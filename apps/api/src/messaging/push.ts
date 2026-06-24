import webpush from "web-push";
import { apiEnv } from "@chairback/config";
import { forShop } from "@chairback/db";
import { logger } from "../logger.js";

const env = apiEnv();

/**
 * Web Push send service - the free, push-first leg of a loyalty/rebooking send.
 *
 * Parallel to the SMS provider (messaging/twilio.ts), NOT an implementation of
 * MessageProvider: that interface is SMS-shaped (`to: E.164`, one recipient),
 * while a push fans out to every installed device of a client and prunes dead
 * subscriptions as it goes. The two share only the Nudge ledger.
 *
 * Like every send path here it NEVER throws - a push failure is logged and
 * reflected in the return value, but must never roll back or 500 the visit /
 * redeem / sweep flow that triggered it.
 */

/** The notification payload the service worker (public/sw.js) renders. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where notificationclick should focus/open (usually the rewards page). */
  url: string;
  /** Collapse tag so re-sends replace rather than stack (e.g. "rebook"). */
  tag?: string;
}

export interface PushSendResult {
  /** Subscriptions that accepted the push. */
  sent: number;
  /** Dead subscriptions deleted (404/410 from the push service). */
  pruned: number;
  /** Subscriptions that errored transiently (failureCount bumped). */
  failed: number;
  /** True when at least one device accepted - the signal to SKIP the SMS. */
  anyDelivered: boolean;
}

/**
 * VAPID is configured once, lazily, the first time we send - mirroring the lazy
 * Twilio construction so a missing keypair never breaks boot. Returns false (and
 * the caller falls back to SMS) whenever any of the three VAPID vars is unset.
 */
let vapidReady = false;
function ensureVapid(): boolean {
  if (!pushEnabled()) return false;
  if (!vapidReady) {
    webpush.setVapidDetails(
      env.PUSH_VAPID_SUBJECT!,
      env.PUSH_VAPID_PUBLIC_KEY!,
      env.PUSH_VAPID_PRIVATE_KEY!,
    );
    vapidReady = true;
  }
  return true;
}

/** Whether Web Push is configured at all (all three VAPID vars present). */
export function pushEnabled(): boolean {
  return Boolean(
    env.PUSH_VAPID_PUBLIC_KEY &&
      env.PUSH_VAPID_PRIVATE_KEY &&
      env.PUSH_VAPID_SUBJECT,
  );
}

/**
 * The single low-level send, factored out so tests can inject a fake instead of
 * hitting a real push service. Resolves on accept; rejects with a `statusCode`
 * (web-push's WebPushError) on reject - 404/410 means the subscription is gone.
 */
export interface PushSender {
  send(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ): Promise<void>;
}

const realSender: PushSender = {
  async send(sub, payload) {
    await webpush.sendNotification(sub, payload);
  },
};

let testSender: PushSender | undefined;

/** Test seam: inject a fake sender (mirrors __setMessageProviderForTests). */
export function __setPushSenderForTests(s: PushSender | undefined): void {
  testSender = s;
}

function senderOrNull(): PushSender | null {
  if (testSender) return testSender;
  // DRY_RUN kill switch (global), matching NoopMessageProvider: never hit a real
  // push service while simulated. A test sender always wins so suites can still
  // assert real-send behavior.
  if (env.DRY_RUN) return null;
  return ensureVapid() ? realSender : null;
}

/**
 * Push a notification to EVERY installed device of one client. Reads the client's
 * subscriptions through forShop (RLS-enforced), sends to each, prunes the ones
 * the push service reports gone (404/410), and bumps failureCount on transient
 * errors (deleting past a small threshold so dead rows can't accumulate). Bumps
 * lastSeenAt on success. Records a single WEB_PUSH Nudge for audit when anything
 * was delivered. Never throws.
 */
export async function sendPushToClient(params: {
  shopId: string;
  clientId: string;
  payload: PushPayload;
  /** Ledger discriminator on the Nudge row: "loyalty" | "nudge" | "promo". */
  kind?: string;
}): Promise<PushSendResult> {
  const empty: PushSendResult = { sent: 0, pruned: 0, failed: 0, anyDelivered: false };
  const db = forShop(params.shopId);

  let subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
  try {
    subs = await db.pushSubscription.findMany({
      where: { clientId: params.clientId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  } catch (err) {
    logger.error({ err, ...ids(params) }, "push subscription lookup failed");
    return empty;
  }
  if (subs.length === 0) return empty;

  const sender = senderOrNull();
  if (!sender) {
    // DRY_RUN or push not configured: simulate, do not touch real devices, and
    // DELIBERATELY report nothing delivered so the caller still falls back to SMS
    // (dry runs must mirror the no-push world, never silently swallow the send).
    logger.info(
      { ...ids(params), subs: subs.length },
      "[dry-run] suppressed web-push send",
    );
    return empty;
  }

  const body = JSON.stringify({
    title: params.payload.title,
    body: params.payload.body,
    url: params.payload.url,
    ...(params.payload.tag ? { tag: params.payload.tag } : {}),
  });

  const result: PushSendResult = { ...empty };
  for (const sub of subs) {
    try {
      await sender.send(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      );
      result.sent += 1;
      result.anyDelivered = true;
      await db.pushSubscription
        .updateMany({
          where: { id: sub.id },
          data: { lastSeenAt: new Date(), failureCount: 0 },
        })
        .catch(() => {});
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Subscription is gone (uninstalled / permission revoked): delete it.
        result.pruned += 1;
        await db.pushSubscription
          .deleteMany({ where: { id: sub.id } })
          .catch(() => {});
      } else {
        // Transient: bump the failure count, then prune once it's clearly dead.
        result.failed += 1;
        logger.warn(
          { err, status, ...ids(params) },
          "web-push send error (transient)",
        );
        await db.pushSubscription
          .updateMany({
            where: { id: sub.id },
            data: { failureCount: { increment: 1 } },
          })
          .catch(() => {});
        await db.pushSubscription
          .deleteMany({
            where: { id: sub.id, failureCount: { gte: PRUNE_AFTER_FAILURES } },
          })
          .catch(() => {});
      }
    }
  }

  // Audit: one WEB_PUSH Nudge per delivered send, sharing the ledger with SMS so
  // attribution + history treat push as a first-class outbound message.
  if (result.anyDelivered) {
    await db.nudge
      .create({
        data: {
          clientId: params.clientId,
          channel: "WEB_PUSH",
          status: "SENT",
          kind: params.kind ?? "loyalty",
          body: params.payload.body,
          sentAt: new Date(),
        },
      })
      .catch((err) => {
        // The push already went out; a ledger write failure must not throw.
        logger.error({ err, ...ids(params) }, "web-push Nudge audit write failed");
      });
  }

  return result;
}

/** Delete a transient-failing subscription once it crosses this many strikes. */
const PRUNE_AFTER_FAILURES = 5;

function ids(p: { shopId: string; clientId: string }) {
  return { shopId: p.shopId, clientId: p.clientId };
}
