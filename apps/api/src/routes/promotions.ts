import { Router } from "express";
import { z } from "zod";
import { forShop, prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { smsLimiter } from "../middleware/rateLimit.js";
import { loadEligibilityData } from "../engines/nudge.js";
import { isNudgeEligible } from "../engines/eligibility.js";
import { buildPromoBody } from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { hasActiveAccess } from "../billing/stripe.js";

/**
 * Shop-designed promotions: percent/amount off, free add-ons, or extra-punch
 * windows. Live promos show on the client rewards page; blasts go out by SMS
 * through the same audited Nudge pipeline as rebooking nudges (write-ahead
 * rows, shared daily cap, STOP compliance) tagged kind='promo' + promotionId
 * so each promo's results are attributable.
 */
export const promotionsRouter: Router = Router();
promotionsRouter.use(requireUser, requireShop);

const MAX_PROMOS = 20;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

const KINDS = ["PERCENT_OFF", "AMOUNT_OFF", "FREE_ADDON", "EXTRA_PUNCHES"] as const;

const basePromoSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).nullish().or(z.literal("")),
  code: z.string().trim().max(24).nullish().or(z.literal("")),
  percentOff: z.number().int().min(1).max(100).nullish(),
  amountOff: z.number().min(0.01).max(500).nullish(),
  extraPunches: z.number().int().min(1).max(10).nullish(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().nullish(),
  active: z.boolean().optional(),
});

/** The value field that must be present for each promo kind. */
function kindValueError(d: {
  kind: (typeof KINDS)[number];
  percentOff?: number | null;
  amountOff?: number | null;
  extraPunches?: number | null;
}): string | null {
  if (d.kind === "PERCENT_OFF" && !d.percentOff) return "percentOff required";
  if (d.kind === "AMOUNT_OFF" && !d.amountOff) return "amountOff required";
  if (d.kind === "EXTRA_PUNCHES" && !d.extraPunches) return "extraPunches required";
  return null;
}

type PromoRow = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  code: string | null;
  percentOff: number | null;
  amountOff: unknown;
  extraPunches: number | null;
  startsAt: Date;
  endsAt: Date | null;
  active: boolean;
};

function promoStatus(p: PromoRow, now: Date): "live" | "scheduled" | "ended" | "off" {
  if (!p.active) return "off";
  if (p.startsAt > now) return "scheduled";
  if (p.endsAt && p.endsAt <= now) return "ended";
  return "live";
}

function serializePromo(p: PromoRow, now: Date) {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    description: p.description,
    code: p.code,
    percentOff: p.percentOff,
    amountOff: p.amountOff === null ? null : Number(p.amountOff),
    extraPunches: p.extraPunches,
    startsAt: p.startsAt.toISOString(),
    endsAt: p.endsAt?.toISOString() ?? null,
    active: p.active,
    status: promoStatus(p, now),
  };
}

// List all promotions with status + outcome stats.
promotionsRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const now = new Date();
  const [promos, uses, blasts] = await Promise.all([
    forShop(shop.id).promotion.findMany({
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.promotionRedemption.groupBy({
      by: ["promotionId"],
      where: { shopId: shop.id },
      _count: { _all: true },
    }),
    prisma.nudge.findMany({
      where: { shopId: shop.id, promotionId: { not: null }, status: "SENT" },
      select: { promotionId: true, resultedInBookingAt: true },
    }),
  ]);
  const usesById = new Map(uses.map((u) => [u.promotionId, u._count._all]));
  const sentById = new Map<string, number>();
  const rebookedById = new Map<string, number>();
  for (const b of blasts) {
    sentById.set(b.promotionId!, (sentById.get(b.promotionId!) ?? 0) + 1);
    if (b.resultedInBookingAt) {
      rebookedById.set(b.promotionId!, (rebookedById.get(b.promotionId!) ?? 0) + 1);
    }
  }

  res.json({
    promotions: promos.map((p) => ({
      ...serializePromo(p, now),
      timesUsed: usesById.get(p.id) ?? 0,
      textsSent: sentById.get(p.id) ?? 0,
      rebookings: rebookedById.get(p.id) ?? 0,
    })),
  });
});

promotionsRouter.post("/", async (req, res) => {
  const shop = req.shop!;
  const parsed = basePromoSchema.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const valueError = kindValueError(d);
  if (valueError) {
    res.status(400).json({ error: "invalid_input", message: valueError });
    return;
  }
  if (d.startsAt && d.endsAt && d.endsAt <= d.startsAt) {
    res.status(400).json({ error: "invalid_input", message: "endsAt must be after startsAt" });
    return;
  }
  const db = forShop(shop.id);
  const count = await db.promotion.count();
  if (count >= MAX_PROMOS) {
    res.status(400).json({ error: "limit_reached", max: MAX_PROMOS });
    return;
  }
  const promo = await db.promotion.create({
    data: {
      kind: d.kind,
      title: d.title,
      description: d.description || null,
      code: d.code || null,
      percentOff: d.kind === "PERCENT_OFF" ? d.percentOff : null,
      amountOff: d.kind === "AMOUNT_OFF" ? d.amountOff : null,
      extraPunches: d.kind === "EXTRA_PUNCHES" ? d.extraPunches : null,
      startsAt: d.startsAt ?? new Date(),
      endsAt: d.endsAt ?? null,
      active: d.active ?? true,
    },
  });
  res.status(201).json({ id: promo.id });
});

// Edit (kind is immutable - it anchors the promo's stats and value fields).
promotionsRouter.patch("/:id", async (req, res) => {
  const shop = req.shop!;
  const parsed = basePromoSchema.omit({ kind: true }).partial().strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const { count } = await forShop(shop.id).promotion.updateMany({
    where: { id: req.params.id },
    data: {
      ...(d.title !== undefined && { title: d.title }),
      ...(d.description !== undefined && { description: d.description || null }),
      ...(d.code !== undefined && { code: d.code || null }),
      ...(d.percentOff !== undefined && { percentOff: d.percentOff }),
      ...(d.amountOff !== undefined && { amountOff: d.amountOff }),
      ...(d.extraPunches !== undefined && { extraPunches: d.extraPunches }),
      ...(d.startsAt !== undefined && { startsAt: d.startsAt }),
      ...(d.endsAt !== undefined && { endsAt: d.endsAt }),
      ...(d.active !== undefined && { active: d.active }),
    },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

promotionsRouter.delete("/:id", async (req, res) => {
  const { count } = await forShop(req.shop!.id).promotion.deleteMany({
    where: { id: req.params.id },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

// Record a client cashing in the promo at the chair.
promotionsRouter.post("/:id/use", async (req, res) => {
  const shop = req.shop!;
  const clientId = String(req.body?.clientId ?? "");
  const db = forShop(shop.id);
  const [promo, client] = await Promise.all([
    db.promotion.findFirst({ where: { id: req.params.id } }),
    db.client.findFirst({ where: { id: clientId } }),
  ]);
  if (!promo || !client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await db.promoUse.create({
    data: { promotionId: promo.id, clientId: client.id },
  });
  res.json({ ok: true });
});

const blastSchema = z
  .object({
    audience: z.enum(["all", "atRisk"]).default("all"),
    dryRun: z.boolean().default(false),
  })
  .strict();

/**
 * Text this promo to clients. "all" = every opted-in client with a phone (a
 * deliberate barber action, like bulk nudge); "atRisk" = only clients the nudge
 * engine currently considers overdue. Both respect the shop's daily send cap
 * (shared with nudges) and record write-ahead Nudge rows (kind='promo').
 */
promotionsRouter.post("/:id/blast", smsLimiter, async (req, res) => {
  const shop = req.shop!;
  const parsed = blastSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { audience, dryRun } = parsed.data;
  // Previews stay free; real sends require an active trial/subscription.
  if (!dryRun && !hasActiveAccess(shop)) {
    res.status(402).json({
      error: "subscription_required",
      message:
        "Texting clients is a Premium feature. Upgrade to send rebooking nudges and promo blasts.",
    });
    return;
  }
  const db = forShop(shop.id);
  const promo = await db.promotion.findFirst({ where: { id: req.params.id } });
  if (!promo) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const now = new Date();
  if (promoStatus(promo, now) !== "live") {
    res.status(400).json({ error: "not_live", status: promoStatus(promo, now) });
    return;
  }

  // Candidates: opted-in clients with phones.
  let candidates = await db.client.findMany({
    where: { optedOut: false, phone: { not: null } },
  });
  const considered = candidates.length;

  if (audience === "atRisk" && candidates.length > 0) {
    const data = await loadEligibilityData(
      shop.id,
      candidates.map((c) => c.id),
      now,
    );
    candidates = candidates.filter((c) =>
      isNudgeEligible({
        completedVisitCount: data.completedCounts.get(c.id) ?? 0,
        medianIntervalDays: c.medianIntervalDays,
        daysSinceLastVisit: c.lastVisitAt
          ? Math.floor((now.getTime() - c.lastVisitAt.getTime()) / MS_PER_DAY)
          : null,
        hasUpcomingVisit: data.upcomingIds.has(c.id),
        daysSinceLastNudge: data.lastNudgeAt.has(c.id)
          ? Math.floor((now.getTime() - data.lastNudgeAt.get(c.id)!.getTime()) / MS_PER_DAY)
          : null,
        optedOut: c.optedOut,
        phone: c.phone,
        nudgeBufferDays: shop.nudgeBufferDays,
      }),
    );
  }

  // Shared daily budget with nudges - promos can't blow past the cap.
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await db.nudge.count({
    where: { status: "SENT", createdAt: { gte: startOfDay } },
  });
  let budget = Math.max(0, shop.dailySendCap - sentToday);

  // Lazy + real-send-only: a dry-run preview must work even with missing/invalid
  // Twilio creds (same reasoning as the nudge sweep).
  const provider = dryRun ? null : getMessageProvider();
  const summary = {
    considered,
    eligible: candidates.length,
    sent: 0,
    failed: 0,
    skippedCap: 0,
    dryRun,
  };

  for (const client of candidates) {
    if (budget <= 0) {
      summary.skippedCap++;
      continue;
    }
    if (dryRun) {
      // Preview only: report what WOULD send; consume simulated budget.
      summary.sent++;
      budget--;
      continue;
    }
    const body = buildPromoBody({
      firstName: client.firstName,
      shopName: shop.name,
      bookingUrl: shop.bookingUrl,
      title: promo.title,
      description: promo.description,
      code: promo.code,
    });
    // WRITE-AHEAD: persist PENDING before dispatch so a crash can't double-send.
    const nudge = await db.nudge.create({
      data: {
        clientId: client.id,
        channel: "SMS",
        status: "PENDING",
        kind: "promo",
        promotionId: promo.id,
        body,
      },
    });
    try {
      // Non-null: dryRun===false here (the dry-run branch above `continue`d).
      const result = await provider!.send({ to: client.phone!, body });
      await prisma.nudge.update({
        where: { id: nudge.id },
        data: { status: "SENT", sentAt: new Date(), messageSid: result.sid },
      });
      summary.sent++;
      budget--;
    } catch (err) {
      await prisma.nudge.update({
        where: { id: nudge.id },
        data: { status: "FAILED", failedReason: (err as Error).message },
      });
      summary.failed++;
    }
  }

  res.json(summary);
});
