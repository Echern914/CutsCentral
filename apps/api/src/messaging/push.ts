import webpush from "web-push";
import { apiEnv } from "@chairback/config";
import { forShop, runAsOwner, type Prisma } from "@chairback/db";
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
  if (env.DRY_RUN) return null;
  return ensureVapid() ? realSender : null;
}

/**
 * The native-app (Expo) send. Factored out with a test seam like the web sender.
 * Throws with statusCode 410 when Expo reports the device is gone
 * (DeviceNotRegistered) so the shared prune path deletes the row.
 */
export interface ExpoSender {
  send(expoPushToken: string, payload: PushPayload): Promise<void>;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const realExpoSender: ExpoSender = {
  async send(expoPushToken, payload) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        to: expoPushToken,
        title: payload.title,
        body: payload.body,
        data: { url: payload.url },
        ...(payload.tag ? { collapseId: payload.tag } : {}),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { status?: string; details?: { error?: string } };
    };
    const status = json.data?.status;
    if (status === "error") {
      const detail = json.data?.details?.error;
      // A gone device: surface as 410 so the caller prunes it.
      if (detail === "DeviceNotRegistered") {
        throw Object.assign(new Error("DeviceNotRegistered"), { statusCode: 410 });
      }
      throw new Error(`expo push error: ${detail ?? "unknown"}`);
    }
  },
};

let testExpoSender: ExpoSender | undefined;

/** Test seam for the native (Expo) sender. */
export function __setExpoSenderForTests(s: ExpoSender | undefined): void {
  testExpoSender = s;
}

function sendExpo(expoPushToken: string, payload: PushPayload): Promise<void> {
  const s = testExpoSender ?? realExpoSender;
  return s.send(expoPushToken, payload);
}

/** The subscription columns the delivery loop needs. */
interface DeliverableSub {
  id: string;
  kind: "web" | "expo";
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  expoPushToken: string | null;
}

/**
 * The prune/bump writes the delivery loop makes, abstracted over WHO may make
 * them: the client send path passes the forShop facade (RLS-enforced), the
 * barber send path passes a runAsOwner-backed writer (user-keyed rows are
 * cross-shop by design - see the PushSubscription model comment).
 */
interface SubWriter {
  updateMany(args: Prisma.PushSubscriptionUpdateManyArgs): Promise<unknown>;
  deleteMany(args: Prisma.PushSubscriptionDeleteManyArgs): Promise<unknown>;
}

/**
 * Deliver one payload to a set of devices: send to each, prune the ones the
 * push service reports gone (404/410 web, DeviceNotRegistered expo), bump
 * failureCount on transient errors (deleting past a small threshold so dead
 * rows can't accumulate), and refresh lastSeenAt on success. Honors the global
 * DRY_RUN kill switch (unless a test sender is injected, so suites can assert
 * real-send behavior). Never throws.
 */
async function deliverToSubs(
  db: SubWriter,
  subs: DeliverableSub[],
  payload: PushPayload,
  logCtx: Record<string, string | number>,
): Promise<PushSendResult> {
  const result: PushSendResult = { sent: 0, pruned: 0, failed: 0, anyDelivered: false };
  if (subs.length === 0) return result;

  // DRY_RUN: never touch a real device while simulated, and DELIBERATELY report
  // nothing delivered so callers still fall back to SMS (dry runs must mirror
  // the no-push world).
  const hasTestSender = Boolean(testSender || testExpoSender);
  if (!hasTestSender && env.DRY_RUN) {
    logger.info({ ...logCtx, subs: subs.length }, "[dry-run] suppressed push send");
    return result;
  }
  // The WEB sender needs VAPID; the EXPO transport does not. So a web sender may
  // be null (no VAPID configured) while expo rows still send fine - we only skip
  // an individual web row when there's no sender for it.
  const webSender = senderOrNull();

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    ...(payload.tag ? { tag: payload.tag } : {}),
  });

  for (const sub of subs) {
    try {
      if (sub.kind === "expo") {
        // Native app device: send via Expo's push service. A "gone" device
        // (DeviceNotRegistered) throws with statusCode 410 so the shared prune
        // path below removes it, exactly like a dead web subscription.
        if (!sub.expoPushToken) throw new Error("expo sub missing token");
        await sendExpo(sub.expoPushToken, payload);
      } else {
        // Browser/PWA device: VAPID Web Push. Skip if no web sender (no VAPID).
        if (!webSender) continue;
        if (!sub.endpoint || !sub.p256dh || !sub.auth) {
          throw new Error("web sub missing endpoint/keys");
        }
        await webSender.send(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
      }
      result.sent += 1;
      result.anyDelivered = true;
      await db
        .updateMany({
          where: { id: sub.id },
          data: { lastSeenAt: new Date(), failureCount: 0 },
        })
        .catch(() => {});
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Subscription is gone (uninstalled / permission revoked / expo
        // DeviceNotRegistered): delete it.
        result.pruned += 1;
        await db.deleteMany({ where: { id: sub.id } }).catch(() => {});
      } else {
        // Transient: bump the failure count, then prune once it's clearly dead.
        result.failed += 1;
        logger.warn({ err, status, ...logCtx }, "web-push send error (transient)");
        await db
          .updateMany({
            where: { id: sub.id },
            data: { failureCount: { increment: 1 } },
          })
          .catch(() => {});
        await db
          .deleteMany({
            where: { id: sub.id, failureCount: { gte: PRUNE_AFTER_FAILURES } },
          })
          .catch(() => {});
      }
    }
  }
  return result;
}

const SUB_SELECT = {
  id: true,
  kind: true,
  endpoint: true,
  p256dh: true,
  auth: true,
  expoPushToken: true,
} as const;

/**
 * Push a notification to EVERY installed device of one client. Reads the client's
 * subscriptions through forShop (RLS-enforced) and delivers via the shared loop.
 * Records a single WEB_PUSH Nudge for audit when anything was delivered. Never
 * throws.
 */
export async function sendPushToClient(params: {
  shopId: string;
  clientId: string;
  payload: PushPayload;
  /** Ledger discriminator on the Nudge row: "loyalty" | "nudge" | "promo". */
  kind?: string;
  /**
   * A PRE-CREATED Nudge row to resolve instead of inserting a fresh audit row.
   * Used by flows that must write the ledger row inside their own transaction
   * (e.g. the per-appointment nudge rate limit counts rows in-tx before the
   * send): on delivery that row flips PENDING -> SENT (+sentAt); on a no-device
   * result it flips to FAILED so the audit trail shows the attempt.
   */
  auditNudgeId?: string;
}): Promise<PushSendResult> {
  const empty: PushSendResult = { sent: 0, pruned: 0, failed: 0, anyDelivered: false };
  const db = forShop(params.shopId);

  let subs: DeliverableSub[];
  try {
    subs = await db.pushSubscription.findMany({
      where: { clientId: params.clientId },
      select: SUB_SELECT,
    });
  } catch (err) {
    logger.error({ err, ...ids(params) }, "push subscription lookup failed");
    return empty;
  }

  const result = await deliverToSubs(
    db.pushSubscription,
    subs,
    params.payload,
    ids(params),
  );

  // Audit: one WEB_PUSH Nudge per delivered send, sharing the ledger with SMS so
  // attribution + history treat push as a first-class outbound message.
  if (params.auditNudgeId) {
    // Caller pre-created the row (in its own tx) - resolve it either way.
    await db.nudge
      .update({
        where: { id: params.auditNudgeId },
        data: result.anyDelivered
          ? { status: "SENT", sentAt: new Date() }
          : { status: "FAILED", failedReason: "no_push_device" },
      })
      .catch((err) => {
        logger.error({ err, ...ids(params) }, "web-push Nudge audit update failed");
      });
  } else if (result.anyDelivered) {
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

/**
 * Push a notification to EVERY device a barber/manager registered (the iOS
 * dashboard app) - business events like a new appointment request. USER-keyed,
 * not shop-scoped: a manager's device serves every shop they own, so the rows
 * are read (and pruned) via runAsOwner - the same trust model as the public
 * client-row writes; the userId comes from the server-resolved shop owner,
 * never from a request. No Nudge audit row: that ledger is client-keyed and
 * these sends are to the business, not a client. Never throws.
 */
export async function sendPushToUser(params: {
  userId: string;
  /** For log context only - the send itself is user-keyed. */
  shopId: string;
  payload: PushPayload;
}): Promise<PushSendResult> {
  const empty: PushSendResult = { sent: 0, pruned: 0, failed: 0, anyDelivered: false };

  let subs: DeliverableSub[];
  try {
    subs = await runAsOwner((tx) =>
      tx.pushSubscription.findMany({
        where: { userId: params.userId },
        select: SUB_SELECT,
      }),
    );
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, userId: params.userId },
      "barber push subscription lookup failed",
    );
    return empty;
  }

  const ownerWriter: SubWriter = {
    updateMany: (args) => runAsOwner((tx) => tx.pushSubscription.updateMany(args)),
    deleteMany: (args) => runAsOwner((tx) => tx.pushSubscription.deleteMany(args)),
  };
  return deliverToSubs(ownerWriter, subs, params.payload, {
    shopId: params.shopId,
    userId: params.userId,
  });
}

/** Delete a transient-failing subscription once it crosses this many strikes. */
const PRUNE_AFTER_FAILURES = 5;

function ids(p: { shopId: string; clientId: string }) {
  return { shopId: p.shopId, clientId: p.clientId };
}
