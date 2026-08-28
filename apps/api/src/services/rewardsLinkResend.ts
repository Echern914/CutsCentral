import { Prisma, prisma, runAsOwner } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { getMessageProvider } from "../messaging/twilio.js";
import { logger } from "../logger.js";
import {
  billableSegments,
  bumpRecoverySmsMetric,
  takeRecoverySmsBudget,
} from "./recoverySmsBudget.js";

/**
 * Re-send a client their rewards link - the ONE engine behind every
 * authenticated door (the manager button on the client page, the barber's
 * own-clients list). The self-service phone-recovery flow is its sibling in
 * services/rewardsRecovery.ts; all of them commit onto the same loyalty-kind
 * Nudge trail under the same nudge:<clientId> advisory lock and reserve from
 * the same platform segment budget, so adding a door never adds an allowance.
 *
 * 🔴 CONSENT IS THE REAL GATE, and it is the shop's own rule, not a new one:
 * textable means optedOut === false AND smsConsentAt != null. A STOP is
 * client-owned - no dashboard seat can text around it. Refusing with a reason
 * the barber can act on beats a silent no-op that looks like it worked.
 *
 * Rate limited PER CLIENT in the database rather than by IP: the thing worth
 * bounding is "how many texts can one customer receive", and that must hold
 * across barbers, devices, doors and restarts.
 */

export const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
/** Loyalty-kind texts one client row may receive per rolling day, all doors
 * combined - the bound that keeps a phone's worst-case SMS count small. */
export const RESEND_DAILY_CAP = 5;

/** The client fields the engine needs - both doors already hold the full row. */
export interface ResendableClient {
  id: string;
  phone: string | null;
  optedOut: boolean;
  optOutSource: string | null;
  smsConsentAt: Date | null;
  magicToken: string;
}

export type ResendRefusal =
  | "no_phone"
  | "opted_out_stop"
  | "opted_out"
  | "no_consent"
  | "too_soon"
  | "too_many_today"
  | "send_failed";

export type ResendResult = { ok: true } | { ok: false; refusal: ResendRefusal };

/**
 * One HTTP answer per refusal, shared by every door so the two surfaces can
 * never drift apart in status codes or copy. The platform-budget refusal is
 * deliberately the same answer as a delivery hiccup - which spend class
 * refused is not a barber's to see.
 */
export const RESEND_REFUSAL_HTTP: Record<
  ResendRefusal,
  { status: number; error: string; message: string }
> = {
  no_phone: {
    status: 409,
    error: "no_phone",
    message: "Add a mobile number to this client before sending their link.",
  },
  opted_out_stop: {
    status: 409,
    error: "opted_out",
    message: "This client texted STOP. Only they can opt back in - by texting START.",
  },
  opted_out: {
    status: 409,
    error: "opted_out",
    message: "This client is opted out of texts.",
  },
  no_consent: {
    status: 409,
    error: "no_consent",
    message: "This client hasn't opted in to texts yet.",
  },
  too_soon: {
    status: 429,
    error: "too_soon",
    message: "That link was just sent. Give it a few minutes before resending.",
  },
  too_many_today: {
    status: 429,
    error: "too_many_today",
    message: "This client has hit today's text limit. Try again tomorrow.",
  },
  send_failed: {
    status: 502,
    error: "send_failed",
    message: "Couldn't send that text just now. Try again in a moment.",
  },
};

export async function resendRewardsLink(params: {
  shopId: string;
  client: ResendableClient;
  twilioNumber: string | null;
  now?: Date;
}): Promise<ResendResult> {
  const { shopId, client } = params;
  const now = params.now ?? new Date();

  if (!client.phone) return { ok: false, refusal: "no_phone" };
  if (client.optedOut) {
    return {
      ok: false,
      refusal: client.optOutSource === "sms_stop" ? "opted_out_stop" : "opted_out",
    };
  }
  if (!client.smsConsentAt) return { ok: false, refusal: "no_consent" };

  // The exact final body, fixed ASCII/GSM-7 on purpose: no customer or shop
  // name (either could change the length or force UCS-2), just the link and
  // the opt-out. One segment for any base URL of sane length; the segment
  // count is CALCULATED and reserved regardless, never assumed.
  const rewardsUrl = `${apiEnv().APP_BASE_URL.replace(/\/$/, "")}/r/${client.magicToken}/rewards`;
  const body = `Your ChairBack rewards link: ${rewardsUrl} Reply STOP to opt out.`;

  // 🔴 One transaction under the client-ledger lock: cooldown read, daily-cap
  // read, PLATFORM segment reservation and the redacted PENDING row all commit
  // together or not at all. Without the lock, parallel resends from two
  // devices (or two doors) could all pass the reads before any create
  // commits; with it, they serialize on the same key the self-service path
  // locks (nudge:<clientId>), so every door shares one ledger in the
  // strictest sense. Lock order everywhere: rec:<ipHash> (self-service only)
  // then nudge:<clientId>; this engine takes only the second - no cycle.
  type Reserved =
    | { ok: true; nudgeId: string }
    | { ok: false; why: "too_soon" | "too_many_today" | "platform_budget" };
  const reserved = await runAsOwner(async (tx): Promise<Reserved> => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`nudge:${client.id}`}))`,
    );
    const recent = await tx.nudge.findFirst({
      where: {
        shopId,
        clientId: client.id,
        kind: "loyalty",
        createdAt: { gt: new Date(now.getTime() - RESEND_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return { ok: false, why: "too_soon" };
    // Daily ceiling so the authenticated doors are bounded too. Counts EVERY
    // loyalty-kind row on this client - self-service recovery included,
    // since those commit onto the same trail - so the worst case per client
    // row per day is RESEND_DAILY_CAP however the doors are alternated.
    const today = await tx.nudge.count({
      where: {
        shopId,
        clientId: client.id,
        kind: "loyalty",
        createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    });
    if (today >= RESEND_DAILY_CAP) return { ok: false, why: "too_many_today" };
    // The SAME platform breaker self-service uses, in billable segments of
    // THIS exact body - an authenticated door is not a way around the cap.
    if (!(await takeRecoverySmsBudget(tx, now, billableSegments(body)))) {
      return { ok: false, why: "platform_budget" };
    }
    // Write-ahead and REDACTED: the audit row must not store a bearer URL.
    // The provider gets the real body in memory; history gets a label.
    const nudge = await tx.nudge.create({
      data: {
        shopId,
        clientId: client.id,
        channel: "SMS",
        status: "PENDING",
        kind: "loyalty",
        body: "Rewards access link",
      },
      select: { id: true },
    });
    return { ok: true, nudgeId: nudge.id };
  });

  if (!reserved.ok) {
    if (reserved.why === "platform_budget") {
      bumpRecoverySmsMetric("sup_budget", now);
      return { ok: false, refusal: "send_failed" };
    }
    return { ok: false, refusal: reserved.why };
  }

  bumpRecoverySmsMetric("attempt", now);
  bumpRecoverySmsMetric("segments", now, billableSegments(body));
  try {
    const result = await getMessageProvider().send({
      to: client.phone,
      body,
      from: params.twilioNumber ?? undefined,
    });
    bumpRecoverySmsMetric("accepted", now);
    await prisma.nudge.update({
      where: { id: reserved.nudgeId },
      data: { status: "SENT", sentAt: now, messageSid: result.sid },
    });
    return { ok: true };
  } catch {
    // 🔴 Fixed classification only, same as self-service: a provider error can
    // carry the phone, the URL token, the body or credential material, and
    // none of that may reach the log, the Nudge, monitoring or the response.
    bumpRecoverySmsMetric("failed", now);
    await prisma.nudge.update({
      where: { id: reserved.nudgeId },
      data: { status: "FAILED", failedReason: "send_failed" },
    });
    logger.warn({ shopId, clientId: client.id }, "rewards link resend failed");
    return { ok: false, refusal: "send_failed" };
  }
}
