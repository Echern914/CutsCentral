import { Prisma, runAsOwner } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { trackBackgroundWork } from "../backgroundWork.js";
import { suppressionAddressHash } from "../engines/broadcastAudience.js";
import { emailDispatchMode, sendEmail, wrapEmailHtml } from "../messaging/email.js";
import { positiveCapFromEnv, takeWindowedBudget } from "./recoverySmsBudget.js";
import { connectableRecordsAt, syncCustomerView } from "./customerIdentity.js";
import { ambiguousShopKey } from "./customerPortal.js";
import { loadAddressSuppressions } from "./emailSuppression.js";

/**
 * "EMAIL ME MY LINK" - the Connect screen's way out when the customer cannot
 * find the text or email the shop sent.
 *
 * A shop has more than one record carrying this customer's contact, so the
 * app opens none of them (services/customerIdentity.ts). The only thing that
 * settles it is the shop's own link to the right record. This sends each
 * candidate record's link to THAT RECORD'S OWN EMAIL ON FILE - never to the
 * account, never to an address the caller names. So it hands out nothing the
 * shop has not already given to whoever holds that mailbox: the customer whose
 * profile it is gets their link; anyone else sharing the phone gets their own.
 *
 * 🔴 THE ANSWER IS THE SAME WHATEVER IS FOUND. A record with an email, one
 * without, a key that names no shop: all `ok`. The limits below are taken
 * FIRST, before anything is looked up, so a 429 says only "you asked
 * recently" - never "there was something to send".
 *
 * Limits, per account and shop (chosen 2026-11-12): one send per 15
 * minutes and three per day. Plus a per-account ceiling across shops, so a
 * stream of made-up keys cannot mint counter rows without end, and the
 * platform circuit breaker on its own ledger. All ride `rate_limit_counter`
 * (atomic per statement, shared across replicas); the express limiters are
 * not the boundary here.
 *
 * The email is fire-and-forget and its failures are logged by class only,
 * exactly as rewards recovery does it: the thrown value may carry the address.
 */

export const CONNECT_EMAIL_COOLDOWN_MS = 15 * 60 * 1000;
export const CONNECT_EMAIL_PER_SHOP_DAILY = 3;
/** Across every shop one account asks about, per day. */
export const CONNECT_EMAIL_PER_ACCOUNT_DAILY = 10;
/** Records one request may mail - a shop with more on one contact than this is the placeholder case. */
export const CONNECT_EMAIL_MAX_RECORDS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export const CONNECT_EMAIL_HOURLY_CAP_DEFAULT = 200;
export const CONNECT_EMAIL_DAILY_CAP_DEFAULT = 1000;

function connectEmailBudget() {
  return {
    keyPrefix: "connEmail:budget",
    hourlyCap: positiveCapFromEnv("CONNECT_EMAIL_HOURLY_CAP", CONNECT_EMAIL_HOURLY_CAP_DEFAULT),
    dailyCap: positiveCapFromEnv("CONNECT_EMAIL_DAILY_CAP", CONNECT_EMAIL_DAILY_CAP_DEFAULT),
    label: { words: "connect-link email", code: "connect_email_budget" },
  };
}

type Tx = Prisma.TransactionClient;

/** One send per window: refused while the row is live, re-armed once it has expired. */
async function takeCooldown(tx: Tx, key: string, now: Date): Promise<boolean> {
  const until = new Date(now.getTime() + CONNECT_EMAIL_COOLDOWN_MS);
  const rows = await tx.$queryRaw<{ hits: number }[]>(Prisma.sql`
    INSERT INTO "rate_limit_counter" ("key", "hits", "expiresAt", "updatedAt")
    VALUES (${key}, 1, ${until.toISOString()}::timestamp, now())
    ON CONFLICT ("key") DO UPDATE
      SET "hits" = 1, "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()
      WHERE "rate_limit_counter"."expiresAt" <= ${now.toISOString()}::timestamp
    RETURNING "hits"`);
  return rows.length > 0;
}

/**
 * `max` per 24 hours from the first one. An expired row starts over at 1; a
 * live one counts up and refuses at the cap, in the same statement.
 */
async function takeDaily(tx: Tx, key: string, max: number, now: Date): Promise<boolean> {
  const nowTs = now.toISOString();
  const until = new Date(now.getTime() + DAY_MS).toISOString();
  const rows = await tx.$queryRaw<{ hits: number }[]>(Prisma.sql`
    INSERT INTO "rate_limit_counter" ("key", "hits", "expiresAt", "updatedAt")
    VALUES (${key}, 1, ${until}::timestamp, now())
    ON CONFLICT ("key") DO UPDATE
      SET "hits" = CASE WHEN "rate_limit_counter"."expiresAt" <= ${nowTs}::timestamp
                        THEN 1 ELSE "rate_limit_counter"."hits" + 1 END,
          "expiresAt" = CASE WHEN "rate_limit_counter"."expiresAt" <= ${nowTs}::timestamp
                             THEN EXCLUDED."expiresAt" ELSE "rate_limit_counter"."expiresAt" END,
          "updatedAt" = now()
      WHERE "rate_limit_counter"."expiresAt" <= ${nowTs}::timestamp
         OR "rate_limit_counter"."hits" < ${max}
    RETURNING "hits"`);
  return rows.length > 0;
}

/**
 * Take this request's allowance. The cooldown goes first so a double tap
 * spends nothing else; anything taken before a later refusal stays taken
 * (the limits err toward sending less, never more).
 */
async function takeAllowance(accountId: string, shopKey: string, now: Date): Promise<boolean> {
  return runAsOwner(async (tx) => {
    if (!(await takeCooldown(tx, `connEmail:cool:${accountId}:${shopKey}`, now))) return false;
    if (!(await takeDaily(tx, `connEmail:day:${accountId}:${shopKey}`, CONNECT_EMAIL_PER_SHOP_DAILY, now))) {
      return false;
    }
    return takeDaily(tx, `connEmail:acct:${accountId}`, CONNECT_EMAIL_PER_ACCOUNT_DAILY, now);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The email itself. The shop's name and the record's own link; no customer name, no other record. */
export function connectLinkEmail(shopName: string, link: string): { subject: string; text: string; html: string } {
  const subject = `Your link for ${shopName}`;
  const how = "Open it on your phone and it connects your profile in the ChairBack app. You can also paste it into the app's Connect screen.";
  const why = `This was asked for from the ChairBack app, and sent to the email ${shopName} has on file for you. If it wasn't you, you can ignore it.`;
  const text = [`Here's your personal link for ${shopName}:`, "", link, "", how, "", why].join("\n");
  const shop = escapeHtml(shopName);
  const html = wrapEmailHtml(
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#17171b;">
<p style="margin:0 0 16px;font-size:15px;">Here's your personal link for ${shop}:</p>
<p style="margin:0 0 20px;font-size:15px;"><a href="${link}">${link}</a></p>
<p style="margin:0 0 16px;font-size:15px;">${escapeHtml(how)}</p>
<p style="margin:0;font-size:13px;color:#5a5a62;">${escapeHtml(why)}</p>
</div>`,
    subject,
  );
  return { subject, text, html };
}

export type ConnectEmailOutcome = { ok: true } | { ok: false; reason: "rate_limited" };

/**
 * Email the shop's link for each record this account might be, at the shop
 * the Connect screen is about. `shopKey` is the opaque key the home sent for
 * that shop (customerPortal.ts ambiguousShopKey) - never a shop id.
 */
export async function emailConnectLinks(opts: {
  accountId: string;
  shopKey: string;
  now: Date;
}): Promise<ConnectEmailOutcome> {
  const { accountId, shopKey, now } = opts;
  if (!(await takeAllowance(accountId, shopKey, now))) return { ok: false, reason: "rate_limited" };
  // Nothing could leave: the allowance is spent (the answer cannot differ), the lookup is not.
  if (emailDispatchMode() === "unconfigured") return { ok: true };

  // Re-derived now, so a shop that has since become connected - or stopped
  // matching - sends nothing.
  const { ambiguousShopIds } = await syncCustomerView(accountId, now);
  const shopId = ambiguousShopIds.find((id) => ambiguousShopKey(accountId, id) === shopKey);
  if (!shopId) return { ok: true };

  const [shop, records, suppressed] = await Promise.all([
    runAsOwner((tx) => tx.shop.findUnique({ where: { id: shopId }, select: { name: true } })),
    connectableRecordsAt(accountId, shopId),
    runAsOwner((tx) => loadAddressSuppressions(tx, shopId)),
  ]);
  if (!shop) return { ok: true };
  const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
  // An address this shop's mail has bounced from or been reported by, on any record.
  const deliverable = records.filter((r) => {
    const hash = suppressionAddressHash(shopId, r.email);
    return hash !== null && !suppressed.undeliverable.has(hash);
  });

  for (const record of deliverable.slice(0, CONNECT_EMAIL_MAX_RECORDS)) {
    // 🔴 The platform breaker, per email, reserved and never given back.
    const allowed = await runAsOwner((tx) => takeWindowedBudget(tx, now, 1, connectEmailBudget()));
    if (!allowed) break;
    const mail = connectLinkEmail(shop.name, `${base}/r/${record.magicToken}`);
    void trackBackgroundWork(
      (async () => {
        try {
          await sendEmail({
            to: record.email,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            fromName: shop.name,
            meta: { shopId, clientId: record.clientId, kind: "connect_link" },
          });
        } catch {
          // 🔴 Fixed classification only - the thrown value may carry the address or the link.
          logger.warn("connect link email: send failed");
        }
      })(),
    );
  }
  return { ok: true };
}
