import { apiEnv, marketingEmailConfigError } from "@chairback/config";
import { Prisma, asOwnerWithin, forShop, prisma, runAsOwner, runWithShop, type LoyaltyTier } from "@chairback/db";
import { logger } from "../logger.js";
import { emailEnabled, wrapEmailHtml } from "../messaging/email.js";
import {
  broadcastEmailQuotaFor,
  monthStartUtc,
  remainingMonthlyEmails,
  reserveBroadcastEmails,
} from "../billing/quota.js";
import { unsubscribeTokenFor } from "./unsubscribeToken.js";
import { loadAddressSuppressions } from "../services/emailSuppression.js";
import {
  splitAudience,
  type AudienceClient,
  type AudienceSplit,
  type BroadcastChannelId,
  type SkipReason,
} from "./broadcastAudience.js";

/**
 * SENDING ONE MESSAGE TO MANY CLIENTS: composing it, and committing to it.
 *
 * The actual delivery lives in engines/broadcastWorker.ts. That split is the
 * whole design, and it is worth saying why.
 *
 * ── What "send" means here ──────────────────────────────────────────────────
 *
 * 🔴 PRESSING SEND DOES NOT SEND ANYTHING. It makes a PROMISE, durably, in one
 * transaction: this exact list of people, this much of the month's allowance,
 * committed together or not at all. Only then is 202 returned, and the barber
 * is told the blast is QUEUED - not that anyone has received it, because at
 * that instant nobody has.
 *
 * The first cut did the opposite: it answered 202 and ran the whole blast in a
 * floating promise. A deploy, a crash or a plain restart in the seconds after
 * that response left the broadcast stuck in SENDING with nothing to resume it,
 * and the barber holding a receipt for work that had stopped. 2,700 emails
 * take minutes; deploys take seconds; that window was not rare.
 *
 * ── What the transaction has to hold ────────────────────────────────────────
 *
 * 1. THE AUDIENCE, frozen into rows before anything leaves. The number in the
 *    response is the number of rows written, so "queued for 412" is a fact
 *    about the database rather than an estimate that moved on.
 * 2. THE ALLOWANCE, reserved against a LOCKED row. Two blasts started seconds
 *    apart used to both count the same 400 remaining and both proceed; now the
 *    second one waits, sees the first one's reservation, and is refused before
 *    a single row is written.
 * 3. THE STATE CHANGE, DRAFT -> QUEUED, as a compare-and-set. A second press
 *    finds the row is no longer DRAFT and is told so, rather than being handed
 *    a cheerful receipt for work it is not doing.
 *
 * Any refusal rolls the whole thing back. There is no half-frozen broadcast.
 *
 * ── Two rules that are not negotiable ───────────────────────────────────────
 *
 * IT IS LAWFUL TO SEND. Marketing email needs a working one-click unsubscribe
 * and the sender's postal address (CAN-SPAM). Both go in every message, and a
 * shop that has not set an address is refused with a reason it can fix in a
 * minute. Push carries neither obligation and is never gated on them.
 *
 * NOTHING AUTOMATIC EVER CALLS THIS. A person presses send. The assistant may
 * draft a broadcast, which is a DRAFT row and nothing more.
 */

export interface BroadcastPreview {
  /** How many will actually receive it. */
  reachable: number;
  /** Everyone considered, before exclusions. */
  considered: number;
  skipped: { reason: SkipReason; count: number }[];
  /** Email only: the month's remaining allowance, or null when unmetered. */
  emailsRemaining: number | null;
  /** Why this cannot be sent right now, if it cannot. */
  blocker: BroadcastBlocker | null;
  /**
   * The same group counted on BOTH channels, so the barber sees what the other
   * one would do before he picks: "0 by email, 41 by app notification" is the
   * answer to "why is email zero?". `unavailable` = this channel cannot be sent
   * from this shop at all right now (email switched off, or no street address),
   * so its count must not be read as people it can reach.
   */
  channels: Record<
    BroadcastChannelId,
    { reachable: number; skipped: { reason: SkipReason; count: number }[]; unavailable: boolean }
  >;
  /** Current, non-archived clients in each tier - so a near-empty tier shows. */
  tierCounts: Record<LoyaltyTier, number>;
}

export type BroadcastBlocker =
  | { kind: "no_recipients" }
  | { kind: "over_quota"; need: number; remaining: number }
  | { kind: "email_not_configured" }
  /** This deployment has no dedicated unsubscribe secret - see the engine note. */
  | { kind: "unsubscribe_not_configured" }
  | { kind: "no_postal_address" }
  /** A tier is part of rewards, and this shop has rewards switched off. */
  | { kind: "tiers_need_rewards" }
  /** Somebody already pressed send; this one is queued, in flight or done. */
  | { kind: "already_sending" }
  | { kind: "not_found" };

/** What the audience rule reads - also re-read at send time (broadcastWorker.ts). */
export const CLIENT_SELECT = {
  id: true,
  email: true,
  emailOptedOut: true,
  emailMarketingConsentAt: true,
  loyaltyTier: true,
  archivedAt: true,
  firstName: true,
} as const;

interface LoadedClient extends AudienceClient {
  firstName: string | null;
}

type ClientRow = {
  id: string;
  email: string | null;
  emailOptedOut: boolean;
  emailMarketingConsentAt: Date | null;
  loyaltyTier: LoyaltyTier | null;
  archivedAt: Date | null;
  firstName: string | null;
};

/**
 * Fold each client's push-device count in, in ONE grouped query.
 *
 * Always inside a shop-scoped transaction - either the caller's, or one opened
 * here. PushSubscription is FORCE ROW LEVEL SECURITY, so a plain query with no
 * `app.current_shop_id` set matches nothing and returns zero devices for
 * everybody: every client would look like they had never installed the app,
 * and a push blast would report an audience of nobody.
 */
async function withDeviceCounts(
  rows: ClientRow[],
  shopId: string,
  tx?: Prisma.TransactionClient,
): Promise<LoadedClient[]> {
  if (rows.length === 0) return [];
  const group = (db: Prisma.TransactionClient) =>
    db.pushSubscription.groupBy({
      by: ["clientId"],
      where: { shopId, clientId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
  const devices = tx ? await group(tx) : await runWithShop(shopId, group);
  const byClient = new Map(devices.map((d) => [d.clientId, d._count._all]));

  // 🔴 AND THE PHONES SIGNED IN TO MY CHAIRBACK. The customer app registers a
  // device on the ACCOUNT (CustomerDevice), never as a shop PushSubscription,
  // and sendPushToClient already delivers to it. Counting only the shop's rows
  // froze every app-only customer as "no_app" before the worker ever ran - so
  // the default channel reached almost nobody, and their Announcements stayed
  // empty. Platform tables, so read as owner: inside the caller's transaction
  // when there is one (one connection, one snapshot with the list being
  // frozen), in its own otherwise. The worker re-derives the link at delivery
  // (accountForClientPush), so a link that has gone stale since costs one
  // FAILED row, never a push to the wrong phone.
  const clientIds = rows.map((r) => r.id);
  const accountDevices = tx
    ? await asOwnerWithin(tx, (otx) => accountDeviceCounts(otx, shopId, clientIds))
    : await runAsOwner((otx) => accountDeviceCounts(otx, shopId, clientIds));

  return rows.map((r) => ({
    ...r,
    pushDevices: (byClient.get(r.id) ?? 0) + (accountDevices.get(r.id) ?? 0),
  }));
}

/**
 * Per client: the devices of the My ChairBack account actively linked to it,
 * under the same rules delivery uses (accountForClientPush +
 * deliverToAccountDevices) - not the demo account, and not an account that
 * switched push off.
 */
async function accountDeviceCounts(
  db: Prisma.TransactionClient,
  shopId: string,
  clientIds: string[],
): Promise<Map<string, number>> {
  const links = await db.customerClientLink.findMany({
    where: {
      shopId,
      clientId: { in: clientIds },
      status: "active",
      account: { isDemo: false, pushEnabled: true },
    },
    select: { clientId: true, account: { select: { _count: { select: { devices: true } } } } },
  });
  const out = new Map<string, number>();
  for (const l of links) out.set(l.clientId, (out.get(l.clientId) ?? 0) + l.account._count.devices);
  return out;
}

/** Every client of this shop, for the preview (its own transaction). */
async function loadClients(shopId: string): Promise<LoadedClient[]> {
  const rows = (await forShop(shopId).client.findMany({
    select: CLIENT_SELECT,
  })) as unknown as ClientRow[];
  return withDeviceCounts(rows, shopId);
}

/**
 * The same read, INSIDE a caller's transaction - which is the version that
 * counts. A preview may be a moment stale; the list that gets frozen may not,
 * because it is the list that decides who is written to and what it costs.
 */
async function loadClientsInTx(
  tx: Prisma.TransactionClient,
  shopId: string,
): Promise<LoadedClient[]> {
  const rows = (await tx.client.findMany({
    where: { shopId },
    select: CLIENT_SELECT,
  })) as unknown as ClientRow[];
  return withDeviceCounts(rows, shopId, tx);
}

export interface BroadcastShop {
  name: string;
  slug: string | null;
  ownerEmail: string | null;
  postal: string | null;
  /** Tiers exist only while this is on - see the tiers_need_rewards blocker. */
  rewardsEnabled: boolean;
}

/** The shop facts a send needs. */
export async function loadBroadcastShop(shopId: string): Promise<BroadcastShop | null> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      name: true,
      // Where a tapped notification lands. A promotion is an invitation to
      // book, so the booking page is the useful destination - and it needs no
      // credential in the payload to reach.
      slug: true,
      // Where a reply should land: the shop has no contact-email column, so
      // this is the owner's login address - the person who wrote the message.
      owner: { select: { email: true } },
      addressStreet: true,
      addressCity: true,
      addressRegion: true,
      addressPostal: true,
      rewardsEnabled: true,
    },
  });
  if (!shop) return null;
  return {
    name: shop.name,
    slug: shop.slug,
    ownerEmail: shop.owner?.email ?? null,
    postal: postalAddress(shop),
    rewardsEnabled: shop.rewardsEnabled,
  };
}

/**
 * The sender's postal address, as CAN-SPAM requires it in the footer.
 * Null when the shop has not set one - which is a refusal, not a blank line.
 */
export function postalAddress(shop: {
  addressStreet: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostal: string | null;
}): string | null {
  const { addressStreet, addressCity, addressRegion, addressPostal } = shop;
  if (!addressStreet?.trim() || !addressCity?.trim() || !addressRegion?.trim()) return null;
  return [addressStreet, `${addressCity}, ${addressRegion}${addressPostal ? ` ${addressPostal}` : ""}`]
    .join(", ")
    .trim();
}

/**
 * The one-click unsubscribe endpoint for ONE client.
 *
 * 🔴 NOT `magicToken`. That is the customer's whole rewards session and has no
 * business in a marketing footer - see engines/unsubscribeToken.ts for what
 * this grants instead, which is one boolean and nothing else.
 */
export function unsubscribeUrlFor(clientId: string): string {
  return `${apiEnv().API_BASE_URL}/api/unsubscribe/${encodeURIComponent(unsubscribeTokenFor(clientId))}`;
}

/**
 * What would happen if this were sent now - the number the barber is shown
 * BEFORE he commits.
 *
 * 🔴 INFORMATIONAL ONLY. It reads without locks so that typing in the compose
 * box does not serialise against every other send in the shop. The numbers
 * that DECIDE anything are taken again inside queueBroadcast's transaction;
 * this one can be a moment stale and nothing breaks, because nothing acts on
 * it but a human reading a screen.
 */
export async function previewBroadcast(params: {
  shopId: string;
  channel: BroadcastChannelId;
  tiers: readonly LoyaltyTier[];
  now?: Date;
}): Promise<BroadcastPreview> {
  const now = params.now ?? new Date();
  const [clients, shop, suppressed] = await Promise.all([
    loadClients(params.shopId),
    loadBroadcastShop(params.shopId),
    runWithShop(params.shopId, (tx) => loadAddressSuppressions(tx, params.shopId)),
  ]);
  // 🔴 ONE LOAD, BOTH CHANNELS. The same clients and the same rule, split twice,
  // so the two numbers on screen can never come from two different moments.
  const byChannel = {
    push: splitAudience(clients, "push", params.tiers, suppressed),
    email: splitAudience(clients, "email", params.tiers, suppressed),
  };
  const split = byChannel[params.channel];
  const channels = {} as BroadcastPreview["channels"];
  for (const c of ["push", "email"] as const) {
    channels[c] = {
      reachable: byChannel[c].reachable.length,
      skipped: skippedCounts(byChannel[c]),
      unavailable: channelUnavailable(c, shop) !== null,
    };
  }
  const tierCounts: Record<LoyaltyTier, number> = { BRONZE: 0, SILVER: 0, GOLD: 0 };
  for (const c of clients) {
    if (c.archivedAt === null && c.loyaltyTier !== null) tierCounts[c.loyaltyTier] += 1;
  }

  let emailsRemaining: number | null = null;
  let blocker: BroadcastBlocker | null = null;

  // 🔴 A TIER IS A REWARDS THING. With rewards off the shop has told its clients
  // there is no program, so a message to "the gold members" would be the program
  // speaking after it was switched off. Checked first, because no channel fixes
  // it - and fail-closed on a shop that could not be read.
  if (params.tiers.length > 0 && !shop?.rewardsEnabled) {
    blocker = { kind: "tiers_need_rewards" };
  }

  if (!blocker && params.channel === "email") {
    blocker = channelUnavailable("email", shop);
    if (!blocker) {
      const remaining = await remainingMonthlyEmails(params.shopId, now);
      emailsRemaining = Number.isFinite(remaining) ? remaining : null;
      if (Number.isFinite(remaining) && split.reachable.length > remaining) {
        blocker = { kind: "over_quota", need: split.reachable.length, remaining };
      }
    }
  }
  if (!blocker && split.reachable.length === 0) blocker = { kind: "no_recipients" };

  return {
    reachable: split.reachable.length,
    considered: clients.length,
    skipped: channels[params.channel].skipped,
    emailsRemaining,
    blocker,
    channels,
    tierCounts,
  };
}

function skippedCounts(split: AudienceSplit): { reason: SkipReason; count: number }[] {
  return (Object.entries(split.reasonCounts) as [SkipReason, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * Why this CHANNEL cannot be used from this shop right now, whoever is in the
 * group - or null. Only email has such a reason; push is always there.
 */
function channelUnavailable(
  channel: BroadcastChannelId,
  shop: BroadcastShop | null,
): BroadcastBlocker | null {
  if (channel !== "email") return null;
  if (!emailEnabled()) return { kind: "email_not_configured" };
  // 🔴 THE FEATURE IS OFF, NOT THE PLATFORM. A missing unsubscribe secret
  // means links in a sent email could stop working the next time sessions
  // are rotated, so this deployment must not send marketing email - but it
  // must go on taking bookings, which is what refusing to BOOT stopped it
  // doing. Push is unaffected and available right now.
  if (marketingEmailConfigError(apiEnv()) !== null) return { kind: "unsubscribe_not_configured" };
  // 🔴 NOT A NAG. US law requires the sender's physical address in
  // commercial email, so this is the difference between a compliant send
  // and one that can cost the shop - and the whole platform's sending
  // reputation. It takes a barber a minute to fix, and push is available
  // meanwhile with no such requirement.
  if (!shop || shop.postal === null) return { kind: "no_postal_address" };
  return null;
}

export type QueueOutcome =
  | { ok: true; recipients: number; skipped: number }
  | { ok: false; blocker: BroadcastBlocker };

/** Rolls the freeze back with a reason the route can word for a person. */
class Refused extends Error {
  constructor(readonly blocker: BroadcastBlocker) {
    super(`broadcast_refused_${blocker.kind}`);
    this.name = "BroadcastRefused";
  }
}

/**
 * 🔴 COMMIT TO THE BLAST. One transaction, and the only thing in this feature
 * that may answer a barber with a number.
 *
 * In order, and all-or-nothing:
 *   1. LOCK the broadcast row, and refuse anything that is not still DRAFT.
 *      This is the mutex a double-tapped button hits, taken before any work.
 *   2. RE-READ the audience. Not the preview's copy - that was computed
 *      without a lock and may be minutes old; a client archived since then
 *      must not be mailed, and one added since then is part of the promise.
 *   3. RESERVE the allowance against a locked row (see reserveBroadcastEmails).
 *   4. FREEZE every recipient - reachable and skipped alike - into rows. The
 *      skipped ones are what lets the report say "412 sent, 1,900 had no
 *      email" a year later, when the client book has moved on.
 *   5. QUEUE it, as a compare-and-set on DRAFT.
 *
 * Nothing is delivered here and nothing is delivered by the caller. The worker
 * picks the rows up, which is what makes a restart one second after the 202
 * uneventful instead of unrecoverable.
 */
export async function queueBroadcast(params: {
  shopId: string;
  broadcastId: string;
  now?: Date;
}): Promise<QueueOutcome> {
  const now = params.now ?? new Date();

  // Read OUTSIDE the transaction: neither of these races a send in any way
  // that matters (a shop does not change its street address mid-tap), and
  // holding a row lock across them would widen the window for nothing.
  const shop = await loadBroadcastShop(params.shopId);
  const quota = await broadcastEmailQuotaFor(params.shopId, now);

  try {
    return await runWithShop(
      params.shopId,
      async (tx) => {
        // 1. THE MUTEX. FOR UPDATE, so a second press blocks here and then
        // reads the status this one wrote rather than the one it started with.
        const locked = await tx.$queryRaw<
          { id: string; status: string; channel: BroadcastChannelId; audienceTiers: LoyaltyTier[] }[]
        >(Prisma.sql`
          SELECT "id", "status"::text AS "status", "channel"::text AS "channel", "audienceTiers"
            FROM "Broadcast"
           WHERE "id" = ${params.broadcastId} AND "shopId" = ${params.shopId}
           FOR UPDATE`);
        const broadcast = locked[0];
        if (!broadcast) throw new Refused({ kind: "not_found" });
        if (broadcast.status !== "DRAFT") throw new Refused({ kind: "already_sending" });
        // The preview's rule, taken again at the moment of commitment: a draft
        // aimed at a tier while rewards were on must not go out after they were
        // switched off.
        if (broadcast.audienceTiers.length > 0 && !shop?.rewardsEnabled) {
          throw new Refused({ kind: "tiers_need_rewards" });
        }

        // 2. THE REAL AUDIENCE, now, under the lock.
        const clients = await loadClientsInTx(tx, params.shopId);
        const suppressed = await loadAddressSuppressions(tx, params.shopId);
        const split = splitAudience(clients, broadcast.channel, broadcast.audienceTiers, suppressed);

        const unavailable = channelUnavailable(broadcast.channel, shop);
        if (unavailable) throw new Refused(unavailable);
        if (split.reachable.length === 0) throw new Refused({ kind: "no_recipients" });

        // 3. THE ALLOWANCE. Push is free and unmetered, which is the entire
        // reason the barber is offered the choice.
        let reserved = 0;
        if (broadcast.channel === "email") {
          const res = await reserveBroadcastEmails(tx, {
            shopId: params.shopId,
            count: split.reachable.length,
            quota,
            now,
          });
          if (!res.ok) {
            throw new Refused({
              kind: "over_quota",
              need: split.reachable.length,
              remaining: res.remaining,
            });
          }
          reserved = res.reserved;
        }

        // 4. FREEZE. skipDuplicates makes a re-run of an interrupted freeze
        // harmless; the (broadcastId, clientId) unique underneath is what
        // makes it true rather than hopeful.
        await tx.broadcastSend.createMany({
          data: [
            ...split.reachable.map((c) => ({
              broadcastId: broadcast.id,
              shopId: params.shopId,
              clientId: c.id,
              status: "PENDING" as const,
              nextAttemptAt: new Date(0), // due immediately
            })),
            ...split.skipped.map((s) => ({
              broadcastId: broadcast.id,
              shopId: params.shopId,
              clientId: s.client.id,
              status: "SKIPPED" as const,
              reason: s.reason,
            })),
          ],
          skipDuplicates: true,
        });

        // 5. QUEUED, as a CAS. The row lock above already guarantees we are
        // alone; this is the belt that makes the guarantee local and obvious.
        const moved = await tx.broadcast.updateMany({
          where: { id: broadcast.id, shopId: params.shopId, status: "DRAFT" },
          data: {
            status: "QUEUED",
            recipientCount: split.reachable.length,
            skippedCount: split.skipped.length,
            emailsReserved: reserved,
            queuedAt: now,
          },
        });
        if (moved.count === 0) throw new Refused({ kind: "already_sending" });

        logger.info(
          {
            shopId: params.shopId,
            broadcastId: broadcast.id,
            channel: broadcast.channel,
            recipients: split.reachable.length,
            reserved,
          },
          "broadcast queued",
        );
        return {
          ok: true as const,
          recipients: split.reachable.length,
          skipped: split.skipped.length,
        };
      },
      // A shop with a few thousand clients writes a few thousand rows here.
      // Prisma's default 5s is not generous enough for that on a cold pool.
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (err instanceof Refused) return { ok: false, blocker: err.blocker };
    throw err;
  }
}

/** The month a broadcast's reservation was taken in - NOT the month it ends in. */
export function reservationPeriodFor(broadcast: {
  queuedAt: Date | null;
  createdAt: Date;
}): Date {
  return monthStartUtc(broadcast.queuedAt ?? broadcast.createdAt);
}

/** Escape anything the barber typed - his words go in, his markup does not. */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The email body. The footer is not decoration: the sender's postal address
 * and a working unsubscribe are what make a promotional email lawful to send.
 */
export function broadcastHtml(p: {
  greeting: string;
  body: string;
  shopName: string;
  postal: string | null;
  unsubscribeUrl: string;
}): string {
  const paragraphs = p.body
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px;line-height:1.6">${escapeHtml(para).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return wrapEmailHtml(
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111">
       ${p.greeting ? `<p style="margin:0 0 14px">${escapeHtml(p.greeting.trim())}</p>` : ""}
       ${paragraphs}
       <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0"/>
       <p style="margin:0 0 6px;font-size:12px;color:#666">${escapeHtml(p.shopName)}</p>
       ${p.postal ? `<p style="margin:0 0 6px;font-size:12px;color:#666">${escapeHtml(p.postal)}</p>` : ""}
       <p style="margin:0;font-size:12px;color:#666">
         <a href="${p.unsubscribeUrl}" style="color:#666">Unsubscribe from these emails</a>
       </p>
     </div>`,
    p.shopName,
  );
}
