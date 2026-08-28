import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import {
  kioskReadLimiter,
  kioskSmsLimiter,
  kioskWriteLimiter,
} from "../middleware/rateLimit.js";
import { hasActiveAccess } from "../billing/stripe.js";
import { getMessageProvider } from "../messaging/twilio.js";
import {
  buildWalkInLinkBody,
  buildWalkInVerificationBody,
} from "../messaging/templates.js";
import { toE164 } from "../acuity/clientKey.js";
import {
  consumeCheckInProof,
  issueChallenge,
  verifyChallenge,
} from "../engines/walkInVerify.js";
import {
  estimateForNewEntry,
  kioskCheckIn,
  WalkInServiceInputError,
  WALK_IN_SMS_CONSENT_TEXT,
  WALK_IN_SMS_CONSENT_VERSION,
} from "../engines/walkInCheckIn.js";
import {
  exchangeTrackToken,
  trackLeave,
  trackStatus,
} from "../engines/walkInTrack.js";
import {
  WalkInQueueFullError,
  WalkInServiceSelectionError,
  WalkInStaffError,
} from "../engines/walkInQueue.js";
import { resolveWaitlistClient } from "../engines/waitlistClientLink.js";

/**
 * Walk-In Mode: the PUBLIC surface - the kiosk tablet and the customer's
 * "My Place in Line" page. UNauthenticated by design; trust comes from three
 * bearer credentials, every one of them hash-only at rest:
 *
 *   kiosk token  -> the shop (rides in the tablet URL's FRAGMENT + POST bodies)
 *   OTP + proof  -> the phone (six digits in one SMS; proof spends once)
 *   track token  -> one entry (SMS link fragment, exchanged for a session)
 *
 * 🔴 NO CREDENTIAL EVER RIDES IN A URL PATH OR QUERY on this surface - every
 * endpoint is a POST with the secret in the body, so nothing here depends on
 * log redaction to stay un-published.
 *
 * 🔴 ANTI-ENUMERATION IS THE ROUTE CONTRACT. Before a phone is verified, no
 * response may reveal whether that phone belongs to a client, has visited,
 * or already stands in the line: challenge always answers the same {ok:true},
 * verify failures are one uniform {verified:false}, and a duplicate check-in
 * returns the byte-identical success a fresh one gets (the existing entry's
 * link is rotated and re-texted instead). Invalid kiosk credentials and
 * disabled shops collapse into the same 404.
 */
export const walkInPublicRouter: Router = Router();

function sha256Hex(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

function requireWalkInMode(
  _req: Request,
  res: Response,
  next: () => void,
): void {
  if (!apiEnv().WALK_IN_MODE_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

walkInPublicRouter.use(requireWalkInMode);

/**
 * Resolve the kiosk credential to its shop, or the ONE generic nothing.
 * Unknown token, revoked token, walk-in-disabled shop, and lapsed billing
 * all answer identically - a kiosk URL must not be an oracle for any of it.
 */
async function shopForKioskToken(token: string) {
  if (typeof token !== "string" || token.length < 20 || token.length > 512) {
    return null;
  }
  const shop = await prisma.shop.findUnique({
    where: { walkInKioskTokenHash: sha256Hex(token) },
  });
  if (!shop || !shop.walkInEnabled) return null;
  return shop;
}

const notFound = (res: Response): void => {
  res.status(404).json({ error: "not_found" });
};

// ---------------------------------------------------------------------------
// Kiosk
// ---------------------------------------------------------------------------

const tokenSchema = z.object({ token: z.string().min(1).max(512) }).strict();

/**
 * Everything the welcome/selection screens need. Exposes exactly what the
 * public booking page already exposes about a shop - branding, ACTIVE
 * services, ACTIVE staff display identities, and the offerings matrix - and
 * nothing more.
 */
walkInPublicRouter.post("/kiosk/resolve", kioskReadLimiter, async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) return notFound(res);
  const shop = await shopForKioskToken(parsed.data.token);
  if (!shop) return notFound(res);

  const accepting = shop.walkInAcceptingNow && hasActiveAccess(shop);
  const [services, staff, offerings] = await Promise.all([
    prisma.service.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        durationMin: true,
        price: true,
        color: true,
      },
    }),
    prisma.staff.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, imageUrl: true },
    }),
    prisma.serviceStaff.findMany({
      where: { shopId: shop.id },
      select: { serviceId: true, staffId: true },
    }),
  ]);

  res.json({
    shop: {
      name: shop.name,
      logoUrl: shop.logoUrl,
      accentColor: shop.accentColor,
      timezone: shop.timezone,
    },
    acceptingNow: accepting,
    // Display-only: the server re-snapshots duration/price at check-in.
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      durationMin: s.durationMin,
      price: s.price === null ? null : Number(s.price),
      color: s.color,
    })),
    staff,
    offerings,
    consent: {
      text: WALK_IN_SMS_CONSENT_TEXT,
      version: WALK_IN_SMS_CONSENT_VERSION,
    },
  });
});

const estimateSchema = z
  .object({
    token: z.string().min(1).max(512),
    serviceIds: z.array(z.string().min(1).max(64)).min(1).max(3),
    preferredStaffId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

/** The pre-confirmation quote. Deterministic, server-computed, labeled an
 * estimate by every screen that shows it. */
walkInPublicRouter.post("/kiosk/estimate", kioskReadLimiter, async (req, res) => {
  const parsed = estimateSchema.safeParse(req.body);
  if (!parsed.success) return notFound(res);
  const shop = await shopForKioskToken(parsed.data.token);
  if (!shop) return notFound(res);

  const now = new Date();
  const services = await prisma.service.findMany({
    where: { shopId: shop.id, id: { in: parsed.data.serviceIds }, active: true },
    select: { id: true, durationMin: true },
  });
  if (services.length !== new Set(parsed.data.serviceIds).size) {
    res.status(400).json({ error: "invalid_selection" });
    return;
  }
  const est = await estimateForNewEntry({
    shopId: shop.id,
    now,
    totalDurationMin: services.reduce((s, x) => s + x.durationMin, 0),
    serviceIds: services.map((s) => s.id),
    preferredStaffId: parsed.data.preferredStaffId ?? null,
  });
  res.json({ ok: true, waitMin: est.waitMin, ahead: est.ahead });
});

const challengeSchema = z
  .object({
    token: z.string().min(1).max(512),
    phone: z.string().min(3).max(40),
  })
  .strict();

/**
 * Send (or silently decline to send) a six-digit code. The response is the
 * SAME {ok:true} whether the phone is new, known, already in line, cooling
 * down, or capped - the only 4xx paths are a bad kiosk credential and a
 * malformed phone FORMAT, neither of which says anything about a person.
 */
walkInPublicRouter.post("/kiosk/challenge", kioskSmsLimiter, async (req, res) => {
  const parsed = challengeSchema.safeParse(req.body);
  if (!parsed.success) return notFound(res);
  const shop = await shopForKioskToken(parsed.data.token);
  if (!shop) return notFound(res);
  if (!shop.walkInAcceptingNow || !hasActiveAccess(shop)) {
    res.status(409).json({ error: "not_accepting" });
    return;
  }
  const phone = toE164(parsed.data.phone);
  if (!phone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  const now = new Date();
  const outcome = await issueChallenge({ shopId: shop.id, phone, now });
  if (outcome.send) {
    // A STOP is absolute even for transactional texts - skip the send, keep
    // the constant answer. Shop-scoped lookup only (never across shops).
    const optedOut = await prisma.client.findFirst({
      where: { shopId: shop.id, phone, archivedAt: null, optedOut: true },
      select: { id: true },
    });
    if (!optedOut) {
      try {
        await getMessageProvider().send({
          to: phone,
          body: buildWalkInVerificationBody({
            shopName: shop.name,
            code: outcome.code,
          }),
          from: shop.twilioNumber ?? undefined,
        });
      } catch (err) {
        // The challenge stays valid; the customer can resend after the
        // cooldown. Never leak the failure (or the phone) to the kiosk.
        logger.error({ err, shopId: shop.id }, "walk-in verify: SMS send failed");
      }
    } else {
      logger.info({ shopId: shop.id }, "walk-in verify: send skipped (opted out)");
    }
  } else {
    logger.info(
      { shopId: shop.id, reason: outcome.reason },
      "walk-in verify: challenge not sent",
    );
  }
  res.json({ ok: true });
});

const verifySchema = z
  .object({
    token: z.string().min(1).max(512),
    phone: z.string().min(3).max(40),
    code: z.string().min(1).max(12),
  })
  .strict();

/**
 * Redeem the code. Success additionally answers with the caller's OWN
 * first name when this shop already knows the (now proven) phone - that is
 * the returning-customer recognition, gated strictly behind possession.
 */
walkInPublicRouter.post("/kiosk/verify", kioskSmsLimiter, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return notFound(res);
  const shop = await shopForKioskToken(parsed.data.token);
  if (!shop) return notFound(res);
  const phone = toE164(parsed.data.phone);
  if (!phone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  const now = new Date();
  const outcome = await verifyChallenge({
    shopId: shop.id,
    phone,
    code: parsed.data.code,
    now,
  });
  if (!outcome.verified) {
    // One uniform refusal: wrong, expired, replayed, locked, never issued.
    res.json({ ok: true, verified: false });
    return;
  }
  const link = await resolveWaitlistClient(prisma, shop.id, phone);
  const client = link.clientId
    ? await prisma.client.findFirst({
        where: { id: link.clientId, shopId: shop.id },
        select: { firstName: true },
      })
    : null;
  res.json({
    ok: true,
    verified: true,
    proof: outcome.proof,
    known: Boolean(client?.firstName),
    firstName: client?.firstName ?? null,
  });
});

const checkInSchema = z
  .object({
    token: z.string().min(1).max(512),
    proof: z.string().min(1).max(512),
    phone: z.string().min(3).max(40),
    firstName: z.string().trim().max(80).optional(),
    lastName: z.string().trim().max(80).optional(),
    serviceIds: z.array(z.string().min(1).max(64)).min(1).max(3),
    preferredStaffId: z.string().min(1).max(64).nullable().optional(),
    smsConsent: z.boolean().optional(),
  })
  .strict();

/**
 * Join the line. The response for a duplicate active phone is BYTE-IDENTICAL
 * to a fresh join - the existing entry's link is rotated and re-texted, and
 * nothing in the status, shape, or wording says which path ran.
 */
walkInPublicRouter.post("/kiosk/check-in", kioskWriteLimiter, async (req, res) => {
  const parsed = checkInSchema.safeParse(req.body);
  if (!parsed.success) return notFound(res);
  const shop = await shopForKioskToken(parsed.data.token);
  if (!shop) return notFound(res);
  if (!shop.walkInAcceptingNow || !hasActiveAccess(shop)) {
    res.status(409).json({ error: "not_accepting" });
    return;
  }
  const phone = toE164(parsed.data.phone);
  if (!phone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  const now = new Date();
  const proven = await consumeCheckInProof({
    shopId: shop.id,
    phone,
    proof: parsed.data.proof,
    now,
  });
  if (!proven) {
    res.status(403).json({ error: "verification_required" });
    return;
  }

  try {
    const result = await kioskCheckIn({
      shopId: shop.id,
      timezone: shop.timezone,
      phone,
      firstName: parsed.data.firstName ?? null,
      lastName: parsed.data.lastName ?? null,
      serviceIds: parsed.data.serviceIds,
      preferredStaffId: parsed.data.preferredStaffId ?? null,
      smsConsent: parsed.data.smsConsent === true,
      now,
    });

    // The tracking link, post-commit. A failed text NEVER costs the spot -
    // the entry stands either way and the success copy stays generic.
    const optedOut = await prisma.client.findFirst({
      where: { shopId: shop.id, phone, archivedAt: null, optedOut: true },
      select: { id: true },
    });
    if (!optedOut) {
      const url = `${apiEnv().APP_BASE_URL.replace(/\/$/, "")}/line#t=${result.trackToken}`;
      try {
        const sent = await getMessageProvider().send({
          to: phone,
          body: buildWalkInLinkBody({ shopName: shop.name, url }),
          from: shop.twilioNumber ?? undefined,
        });
        // A ledger row only when a client exists (Nudge.clientId is NOT
        // NULL) and NEVER the body - the URL carries the credential.
        const link = await resolveWaitlistClient(prisma, shop.id, phone);
        if (link.clientId) {
          await prisma.nudge.create({
            data: {
              shopId: shop.id,
              clientId: link.clientId,
              kind: "walk_in_link",
              status: "SENT",
              sentAt: now,
              messageSid: sent.sid,
            },
          });
        }
      } catch (err) {
        logger.error({ err, shopId: shop.id }, "walk-in link: SMS send failed");
      }
    }

    // Constant body for fresh AND deduped joins.
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof WalkInQueueFullError) {
      res.status(409).json({ error: "queue_full" });
      return;
    }
    if (
      err instanceof WalkInServiceSelectionError ||
      err instanceof WalkInServiceInputError
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof WalkInStaffError) {
      res.status(400).json({ error: "invalid_selection" });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// My Place in Line
// ---------------------------------------------------------------------------

const sessionSchema = z.object({ session: z.string().min(1).max(512) }).strict();

/** Fragment token in, bounded session out - once. */
walkInPublicRouter.post("/track/exchange", kioskReadLimiter, async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) return notFound(res);
  const outcome = await exchangeTrackToken({
    token: parsed.data.token,
    now: new Date(),
  });
  if (!outcome.ok) return notFound(res);
  res.json({ ok: true, session: outcome.session });
});

/** The caller's own place, recomputed live. Nobody else's anything. */
walkInPublicRouter.post("/track/status", kioskReadLimiter, async (req, res) => {
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) return notFound(res);
  const outcome = await trackStatus({
    session: parsed.data.session,
    now: new Date(),
  });
  if (!outcome.ok) return notFound(res);
  res.json({ ok: true, ...outcome.status });
});

/** Leave the line. Idempotently safe under repeats and races. */
walkInPublicRouter.post("/track/leave", kioskWriteLimiter, async (req, res) => {
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) return notFound(res);
  const outcome = await trackLeave({
    session: parsed.data.session,
    now: new Date(),
  });
  if (!outcome.ok) return notFound(res);
  res.json({ ok: true, status: outcome.status });
});
