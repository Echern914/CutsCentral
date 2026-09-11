import { apiEnv } from "@chairback/config";
import { forShop, prisma, type LoyaltyTier } from "@chairback/db";
import { logger } from "../logger.js";
import { emailEnabled, sendEmail, wrapEmailHtml } from "../messaging/email.js";
import { sendPushToClient } from "../messaging/push.js";
import { remainingMonthlyEmails } from "../billing/quota.js";
import {
  splitAudience,
  type AudienceClient,
  type BroadcastChannelId,
  type SkipReason,
} from "./broadcastAudience.js";

/**
 * SENDING ONE MESSAGE TO MANY CLIENTS.
 *
 * ── What this is careful about, in the order it bites ───────────────────────
 *
 * 1. AT MOST ONCE. Every intended recipient gets a BroadcastSend row before a
 *    single message leaves, and (broadcastId, clientId) is unique. A retry, a
 *    double-tap or a process that dies halfway can never mail the same person
 *    twice - the failure nobody forgives and the one a "mark it sent
 *    afterwards" design cannot prevent.
 * 2. THE BARBER IS NEVER SURPRISED BY THE BILL. An email broadcast is refused
 *    outright when the audience is larger than the month's remaining
 *    allowance, with both numbers, rather than mailing 300 people and stopping.
 *    A half-sent blast cannot be un-sent or resumed honestly.
 * 3. IT IS LAWFUL TO SEND. Marketing email needs a working one-click
 *    unsubscribe and the sender's postal address (CAN-SPAM); both are added
 *    here, and a shop that has not set an address is refused with a reason it
 *    can fix in a minute. Push carries neither obligation and is never gated
 *    on them.
 * 4. NOTHING AUTOMATIC EVER CALLS THIS. A person presses send. The assistant
 *    may draft a broadcast, which is a DRAFT row and nothing more.
 */

/** How many recipients are processed per pass. Keeps one send off one connection. */
const BATCH = 50;

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
}

export type BroadcastBlocker =
  | { kind: "no_recipients" }
  | { kind: "over_quota"; need: number; remaining: number }
  | { kind: "email_not_configured" }
  | { kind: "no_postal_address" }
  /** Somebody already pressed send; this one is in flight or done. */
  | { kind: "already_sending" };

const CLIENT_SELECT = {
  id: true,
  email: true,
  emailOptedOut: true,
  loyaltyTier: true,
  archivedAt: true,
  firstName: true,
  magicToken: true,
} as const;

interface LoadedClient extends AudienceClient {
  firstName: string | null;
  magicToken: string;
}

/** Every client of this shop, with their push-device count folded in. */
async function loadClients(shopId: string): Promise<LoadedClient[]> {
  const db = forShop(shopId);
  const rows = (await db.client.findMany({ select: CLIENT_SELECT })) as unknown as {
    id: string;
    email: string | null;
    emailOptedOut: boolean;
    loyaltyTier: LoyaltyTier | null;
    archivedAt: Date | null;
    firstName: string | null;
    magicToken: string;
  }[];
  if (rows.length === 0) return [];
  // One grouped count rather than a query per client.
  const devices = await prisma.pushSubscription.groupBy({
    by: ["clientId"],
    where: { shopId, clientId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const byClient = new Map(devices.map((d) => [d.clientId, d._count._all]));
  return rows.map((r) => ({ ...r, pushDevices: byClient.get(r.id) ?? 0 }));
}

/** The shop facts a send needs. */
async function loadShop(shopId: string) {
  return prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      name: true,
      // Where a reply should land: the shop has no contact-email column, so
      // this is the owner's login address - the person who wrote the message.
      owner: { select: { email: true } },
      addressStreet: true,
      addressCity: true,
      addressRegion: true,
      addressPostal: true,
    },
  });
}

/**
 * The sender's postal address, as CAN-SPAM requires it in the footer.
 * Null when the shop has not set one - which is a refusal, not a blank line.
 */
function postalAddress(shop: {
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

/** The one-click unsubscribe endpoint for ONE client. */
export function unsubscribeUrlFor(magicToken: string): string {
  return `${apiEnv().API_BASE_URL}/api/unsubscribe/${encodeURIComponent(magicToken)}`;
}

/**
 * What would happen if this were sent now - the number the barber is shown
 * BEFORE he commits, and the same resolution the send itself performs.
 */
export async function previewBroadcast(params: {
  shopId: string;
  channel: BroadcastChannelId;
  tiers: readonly LoyaltyTier[];
  now?: Date;
}): Promise<BroadcastPreview> {
  const now = params.now ?? new Date();
  const [clients, shop] = await Promise.all([
    loadClients(params.shopId),
    loadShop(params.shopId),
  ]);
  const split = splitAudience(clients, params.channel, params.tiers);
  const skipped = (Object.entries(split.reasonCounts) as [SkipReason, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));

  let emailsRemaining: number | null = null;
  let blocker: BroadcastBlocker | null = null;

  if (params.channel === "email") {
    if (!emailEnabled()) {
      blocker = { kind: "email_not_configured" };
    } else if (!shop || postalAddress(shop) === null) {
      // 🔴 NOT A NAG. US law requires the sender's physical address in
      // commercial email, so this is the difference between a compliant send
      // and one that can cost the shop - and the whole platform's sending
      // reputation. It takes a barber a minute to fix, and push is available
      // meanwhile with no such requirement.
      blocker = { kind: "no_postal_address" };
    } else {
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
    skipped,
    emailsRemaining,
    blocker,
  };
}

/**
 * 🔴 THE MUTEX, TAKEN AT THE MOMENT OF THE TAP.
 *
 * Only the update that moves this row out of DRAFT wins, so a double-tapped
 * button or a retried request cannot start two sends over the same audience -
 * and because the route takes it BEFORE answering, the loser is told 409
 * rather than being handed a cheerful 202 for work it is not doing. The
 * per-recipient unique index is the backstop underneath; this is what stops
 * the work being attempted twice at all.
 */
export async function claimForSending(shopId: string, broadcastId: string): Promise<boolean> {
  const { count } = await forShop(shopId).broadcast.updateMany({
    where: { id: broadcastId, status: "DRAFT" },
    data: { status: "SENDING" },
  });
  return count > 0;
}

export type SendOutcome =
  | { ok: true; sent: number; failed: number; skipped: number }
  | { ok: false; blocker: BroadcastBlocker };

/**
 * Send a DRAFT broadcast.
 *
 * The caller must already hold the claim (claimForSending). Freezes the
 * audience into BroadcastSend rows, then works through them in batches. Safe
 * to call again on a run that died: the unique index makes the freeze
 * idempotent and only PENDING rows are processed.
 */
export async function sendBroadcast(params: {
  shopId: string;
  broadcastId: string;
  now?: Date;
}): Promise<SendOutcome> {
  const now = params.now ?? new Date();
  const db = forShop(params.shopId);
  const broadcast = (await db.broadcast.findFirst({
    where: { id: params.broadcastId },
  })) as unknown as {
    id: string;
    channel: BroadcastChannelId;
    audienceTiers: LoyaltyTier[];
    subject: string | null;
    body: string;
    status: string;
  } | null;
  if (!broadcast) return { ok: false, blocker: { kind: "no_recipients" } };

  const preview = await previewBroadcast({
    shopId: params.shopId,
    channel: broadcast.channel,
    tiers: broadcast.audienceTiers,
    now,
  });
  if (preview.blocker) return { ok: false, blocker: preview.blocker };

  // The caller holds the claim (see claimForSending). This must already be
  // SENDING, or somebody has called this without taking the mutex.
  if (broadcast.status !== "SENDING") {
    return { ok: false, blocker: { kind: "already_sending" } };
  }

  const [clients, shop] = await Promise.all([
    loadClients(params.shopId),
    loadShop(params.shopId),
  ]);
  const split = splitAudience(clients, broadcast.channel, broadcast.audienceTiers);

  // Freeze BOTH sides: who is getting it, and who is not and why. The skipped
  // rows are what lets the report say "412 sent, 1,900 had no email" a month
  // later, when the client book has moved on.
  await db.broadcastSend.createMany({
    data: [
      ...split.reachable.map((c) => ({
        broadcastId: broadcast.id,
        clientId: c.id,
        status: "PENDING" as const,
      })),
      ...split.skipped.map((s) => ({
        broadcastId: broadcast.id,
        clientId: s.client.id,
        status: "SKIPPED" as const,
        reason: s.reason,
      })),
    ],
  });
  await db.broadcast.updateMany({
    where: { id: broadcast.id },
    data: {
      recipientCount: split.reachable.length,
      skippedCount: split.skipped.length,
    },
  });

  const byId = new Map(clients.map((c) => [c.id, c]));
  let sent = 0;
  let failed = 0;

  for (;;) {
    const pending = (await db.broadcastSend.findMany({
      where: { broadcastId: broadcast.id, status: "PENDING" },
      take: BATCH,
      select: { id: true, clientId: true },
    })) as unknown as { id: string; clientId: string }[];
    if (pending.length === 0) break;

    for (const row of pending) {
      const client = byId.get(row.clientId);
      if (!client) {
        await db.broadcastSend.updateMany({
          where: { id: row.id },
          data: { status: "SKIPPED", reason: "archived" },
        });
        continue;
      }
      const ok = await deliver({
        shopId: params.shopId,
        broadcast,
        client,
        shopName: shop?.name ?? "Your shop",
        shopEmail: shop?.owner?.email ?? null,
        postal: shop ? postalAddress(shop) : null,
      });
      await db.broadcastSend.updateMany({
        where: { id: row.id },
        data: ok
          ? { status: "SENT", sentAt: new Date() }
          : { status: "FAILED", reason: "send_failed" },
      });
      if (ok) sent++;
      else failed++;
    }
  }

  await db.broadcast.updateMany({
    where: { id: broadcast.id },
    data: {
      status: "SENT",
      sentCount: sent,
      failedCount: failed,
      sentAt: new Date(),
    },
  });
  logger.info(
    { shopId: params.shopId, broadcastId: broadcast.id, channel: broadcast.channel, sent, failed },
    "broadcast sent",
  );
  return { ok: true, sent, failed, skipped: split.skipped.length };
}

/** One message to one client. Never throws - one bad address is not a failed blast. */
async function deliver(params: {
  shopId: string;
  broadcast: { channel: BroadcastChannelId; subject: string | null; body: string };
  client: LoadedClient;
  shopName: string;
  shopEmail: string | null;
  postal: string | null;
}): Promise<boolean> {
  const { broadcast, client } = params;
  const greeting = client.firstName?.trim() ? `${client.firstName.trim()}, ` : "";
  try {
    if (broadcast.channel === "push") {
      const res = await sendPushToClient({
        shopId: params.shopId,
        clientId: client.id,
        kind: "promo",
        payload: {
          title: broadcast.subject?.trim() || params.shopName,
          body: broadcast.body,
          url: `${apiEnv().APP_BASE_URL}/r/${client.magicToken}`,
        },
      });
      return res.anyDelivered;
    }
    const unsubscribeUrl = unsubscribeUrlFor(client.magicToken);
    const res = await sendEmail({
      to: client.email!,
      subject: broadcast.subject?.trim() || `A message from ${params.shopName}`,
      fromName: params.shopName,
      ...(params.shopEmail ? { replyTo: params.shopEmail } : {}),
      stream: "broadcast",
      unsubscribeUrl,
      text: `${greeting}${broadcast.body}\n\n—\n${params.shopName}\n${params.postal ?? ""}\nUnsubscribe: ${unsubscribeUrl}`,
      html: broadcastHtml({
        greeting,
        body: broadcast.body,
        shopName: params.shopName,
        postal: params.postal,
        unsubscribeUrl,
      }),
      meta: { shopId: params.shopId, kind: "broadcast" },
    });
    return res.status === "sent" || res.status === "dry_run";
  } catch (err) {
    logger.warn({ err, shopId: params.shopId, clientId: client.id }, "broadcast delivery failed");
    return false;
  }
}

/** Escape anything the barber typed - his words go in, his markup does not. */
function escapeHtml(raw: string): string {
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
function broadcastHtml(p: {
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
