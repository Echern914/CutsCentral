import { Router } from "express";
import { z } from "zod";
import { REWARDS_SECTION_DEFAULT } from "@chairback/config";
import { prisma } from "@chairback/db";
import { currentBalance } from "../services/punch.js";
import { toE164 } from "../acuity/clientKey.js";

/**
 * Public rewards endpoint. The magicToken in the path IS the auth - it resolves
 * both the client AND the shop. No session. 404 (not 403) on a bad token to
 * avoid a token-probing oracle. Never accepts a shopId from the request.
 */
export const rewardsRouter: Router = Router();

/**
 * Client's view of their own SMS consent, derived from the same fields the
 * textability gate (engines/eligibility.ts) reads. opted_out wins over consent
 * (a STOP since opting in); opted_in needs both consent on file AND not opted
 * out; otherwise consent has never been recorded.
 */
function consentView(c: {
  optedOut: boolean;
  smsConsentAt: Date | null;
  phone: string | null;
}): { state: "opted_in" | "needs_consent" | "opted_out"; hasPhone: boolean } {
  const state = c.optedOut
    ? "opted_out"
    : c.smsConsentAt !== null
      ? "opted_in"
      : "needs_consent";
  return { state, hasPhone: Boolean(c.phone) };
}

rewardsRouter.get("/:magicToken", async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { magicToken: req.params.magicToken },
    include: { shop: true },
  });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const now = new Date();
  const balance = await currentBalance(client.shopId, client.id);
  const [visits, upcoming, rewards, promotions, redemptions] = await Promise.all([
    prisma.visit.findMany({
      where: { shopId: client.shopId, clientId: client.id, status: "COMPLETED" },
      orderBy: { scheduledAt: "desc" },
      take: 10,
      // punch: the EARN row for this visit (if any), so the client sees "+2"
      // next to the cut that earned it. A visit whose punch was undone has a
      // reversed earn; we still show what it originally granted (the row stays).
      select: {
        id: true,
        scheduledAt: true,
        serviceName: true,
        punch: { select: { punchesEarned: true } },
      },
    }),
    prisma.visit.findFirst({
      where: {
        shopId: client.shopId,
        clientId: client.id,
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        scheduledAt: { gt: now },
      },
      orderBy: { scheduledAt: "asc" },
      select: { scheduledAt: true },
    }),
    prisma.reward.findMany({
      where: { shopId: client.shopId, active: true },
      orderBy: [{ sortOrder: "asc" }, { punchCost: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        emoji: true,
        punchCost: true,
      },
    }),
    prisma.promotion.findMany({
      where: {
        shopId: client.shopId,
        active: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: [{ endsAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 6,
      select: {
        id: true,
        kind: true,
        title: true,
        description: true,
        code: true,
        percentOff: true,
        amountOff: true,
        extraPunches: true,
        endsAt: true,
      },
    }),
    // Rewards the client has actually claimed, newest first. Same "real, still
    // standing" predicate as the dashboard ledger: a real redemption
    // (punchesRedeemed > 0), not since undone (reversedAt null), and not itself
    // a correction row (reversalOfId null). `note` carries the reward name even
    // if the reward was later deleted.
    prisma.punchLedger.findMany({
      where: {
        shopId: client.shopId,
        clientId: client.id,
        punchesRedeemed: { gt: 0 },
        reversedAt: null,
        reversalOfId: null,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { createdAt: true, punchesRedeemed: true, note: true },
    }),
  ]);

  // The punch grid counts toward the cheapest reward the client can't afford
  // yet; with everything in reach (or an empty menu) there's no next target.
  const nextTarget =
    [...rewards]
      .sort((a, b) => a.punchCost - b.punchCost)
      .find((r) => r.punchCost > balance) ?? null;

  // Rebooking countdown: deadline = lastVisit + rebookWindowDays. The client-side
  // timer ticks down to this ISO instant. We surface the state so the UI can show
  // the right message (booked / counting down / overdue / no-data).
  const lastVisitAt = client.lastVisitAt ?? visits[0]?.scheduledAt ?? null;
  const windowDays = client.shop.rebookWindowDays;
  let rebook: {
    state: "booked" | "counting" | "overdue" | "none";
    deadline: string | null;
    windowDays: number;
    upcomingAt: string | null;
  };
  if (upcoming) {
    rebook = { state: "booked", deadline: null, windowDays, upcomingAt: upcoming.scheduledAt.toISOString() };
  } else if (lastVisitAt) {
    const deadline = new Date(lastVisitAt.getTime() + windowDays * 86_400_000);
    rebook = {
      state: deadline.getTime() > now.getTime() ? "counting" : "overdue",
      deadline: deadline.toISOString(),
      windowDays,
      upcomingAt: null,
    };
  } else {
    rebook = { state: "none", deadline: null, windowDays, upcomingAt: null };
  }

  res.json({
    shop: {
      name: client.shop.name,
      bookingUrl: client.shop.bookingUrl,
      logoUrl: client.shop.logoUrl,
      accentColor: client.shop.accentColor,
      // The barber's full page identity, so the client rewards page renders in
      // THEIR theme/typography/shape - not the generic app chrome. Same fields
      // the public /s/[slug] mini-site reads; the web side resolves keys to
      // PAGE_THEMES / PAGE_FONTS / LAYOUT_STYLES.
      theme: client.shop.theme,
      fontKey: client.shop.fontKey,
      layoutStyle: client.shop.layoutStyle,
      // Content control: the barber's optional welcome line + which optional
      // sections to show. [] in the DB means "show all" -> the default list.
      rewardsWelcome: client.shop.rewardsWelcome,
      rewardsSections:
        client.shop.rewardsSections.length > 0
          ? client.shop.rewardsSections
          : REWARDS_SECTION_DEFAULT,
      // Link to the shop's public mini-site when it's live.
      pageSlug: client.shop.publicPageEnabled ? client.shop.slug : null,
    },
    client: {
      firstName: client.firstName,
    },
    consent: consentView(client),
    punches: {
      balance,
      // Grid target: progress toward the next reward out of reach (null when
      // the menu is empty or everything is already affordable).
      nextTarget: nextTarget
        ? {
            name: nextTarget.name,
            punchCost: nextTarget.punchCost,
            remaining: nextTarget.punchCost - balance,
          }
        : null,
    },
    rewards: rewards.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      emoji: r.emoji,
      punchCost: r.punchCost,
      ready: balance >= r.punchCost,
      remaining: Math.max(0, r.punchCost - balance),
    })),
    promotions: promotions.map((p) => ({
      id: p.id,
      kind: p.kind,
      title: p.title,
      description: p.description,
      code: p.code,
      percentOff: p.percentOff,
      amountOff: p.amountOff === null ? null : Number(p.amountOff),
      extraPunches: p.extraPunches,
      endsAt: p.endsAt?.toISOString() ?? null,
    })),
    rebook,
    visits: visits.map((v) => ({
      date: v.scheduledAt.toISOString(),
      service: v.serviceName,
      // Punches this visit earned, so the history reads as activity ("+2") not
      // just a date. null when no earn row exists (e.g. a no-show that slipped
      // through, or a visit predating loyalty); the UI then shows no chip.
      punches: v.punch?.punchesEarned ?? null,
    })),
    // Claimed rewards, for the "Rewards claimed" list. Each is one redemption
    // with the reward name (from the ledger note) and how many punches it cost.
    redemptions: redemptions.map((r) => ({
      date: r.createdAt.toISOString(),
      reward: r.note,
      punches: r.punchesRedeemed,
    })),
  });
});

const optInSchema = z.object({ phone: z.string().max(40).optional() }).strict();

/**
 * Client self-serve opt-in from their rewards page. Grants SMS consent with the
 * strongest possible proof (the client's own action). A phone is required for
 * textability: use the one on file, else accept one in the body. The consent
 * stamp is FIRST-WINS (guarded on smsConsentAt: null) so a re-opt-in never
 * overwrites an earlier source/timestamp - matching the barber-attest path.
 *
 * Plain prisma (connection owner, no SET ROLE) like the GET above: resolves by
 * the global magicToken without a shop context, RLS-safe.
 */
rewardsRouter.post("/:magicToken/opt-in", async (req, res) => {
  const parsed = optInSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const client = await prisma.client.findUnique({
    where: { magicToken: req.params.magicToken },
  });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const rawPhone = parsed.data.phone?.trim();
  const bodyPhone = toE164(parsed.data.phone);
  if (rawPhone && !bodyPhone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }
  const effectivePhone = client.phone ?? bodyPhone;
  if (!effectivePhone) {
    res.status(400).json({ error: "needs_phone" });
    return;
  }

  // Two writes, deliberately kept separate:
  //  1. Unconditional: clear any prior STOP and set the phone on first opt-in.
  //  2. Guarded (smsConsentAt: null): stamp consent FIRST-WINS, never overwrite.
  await prisma.client.update({
    where: { id: client.id },
    data: { optedOut: false, ...(client.phone ? {} : { phone: bodyPhone }) },
  });
  await prisma.client.updateMany({
    where: { id: client.id, smsConsentAt: null },
    data: { smsConsentAt: new Date(), smsConsentSource: "client_self_serve" },
  });

  res.json({ consent: { state: "opted_in", hasPhone: true } });
});

/**
 * Client self-serve opt-out from their rewards page. PER-CLIENT only (keyed by
 * the magicToken), deliberately narrower than the Twilio STOP handler's
 * phone-wide updateMany: a web action speaks for one client, not everyone who
 * happens to share that number.
 */
rewardsRouter.post("/:magicToken/opt-out", async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { magicToken: req.params.magicToken },
  });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await prisma.client.update({
    where: { id: client.id },
    data: { optedOut: true },
  });
  res.json({
    consent: { state: "opted_out", hasPhone: Boolean(client.phone) },
  });
});

const pushSubscribeSchema = z
  .object({
    endpoint: z.string().url().max(2000),
    keys: z.object({
      p256dh: z.string().min(1).max(255),
      auth: z.string().min(1).max(255),
    }),
    userAgent: z.string().max(500).optional(),
  })
  .strict();

/**
 * Store a Web Push subscription for one installed-PWA device of this client. The
 * browser permission grant the page just obtained IS the push consent - so this
 * is allowed regardless of SMS optedOut/smsConsentAt (push and SMS are separate
 * channels). Plain prisma like the opt-in above: resolves the client + shop by
 * the global magicToken, runs as the connection owner (RLS-safe insert), and
 * stamps shopId from the resolved client - NEVER from the request body. Upsert by
 * endpoint so re-subscribing on the same browser refreshes keys instead of
 * duplicating. 404 (not 403) on a bad token, like every public rewards handler.
 */
rewardsRouter.post("/:magicToken/push-subscribe", async (req, res) => {
  const parsed = pushSubscribeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const client = await prisma.client.findUnique({
    where: { magicToken: req.params.magicToken },
  });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const { endpoint, keys, userAgent } = parsed.data;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      shopId: client.shopId,
      clientId: client.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: userAgent ?? null,
    },
    // Re-subscribe on the same device: refresh keys/userAgent, mark it live, and
    // clear any prior failure strikes. clientId is re-stamped in case the same
    // browser endpoint is reused by a different client (shared device).
    update: {
      shopId: client.shopId,
      clientId: client.id,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: userAgent ?? null,
      failureCount: 0,
      lastSeenAt: new Date(),
    },
  });

  res.json({ ok: true });
});

const pushUnsubscribeSchema = z
  .object({ endpoint: z.string().url().max(2000) })
  .strict();

/**
 * Remove a Web Push subscription. PER-CLIENT + per-endpoint (keyed by the
 * magicToken AND the device endpoint): a web action removes only the caller's own
 * device, never another client who might share the same browser endpoint - the
 * same narrowing as opt-out above. Idempotent: deleting an unknown endpoint is a
 * no-op success.
 */
rewardsRouter.post("/:magicToken/push-unsubscribe", async (req, res) => {
  const parsed = pushUnsubscribeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const client = await prisma.client.findUnique({
    where: { magicToken: req.params.magicToken },
  });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await prisma.pushSubscription.deleteMany({
    where: { endpoint: parsed.data.endpoint, clientId: client.id },
  });
  res.json({ ok: true });
});

const pushNativeSchema = z
  .object({
    expoPushToken: z.string().min(1).max(255),
    platform: z.string().max(20).optional(),
  })
  .strict();

/**
 * Register a NATIVE-app (Expo) push token for one device of this client - the
 * iOS/Android app twin of push-subscribe. Same trust model: the magicToken in
 * the URL is the auth, plain prisma stamps shopId from the resolved client, and
 * the Expo token IS the push consent (independent of SMS). kind:"expo" so the
 * send path routes it through Expo's push service. Upsert by token so the same
 * device re-registering refreshes rather than duplicating.
 */
rewardsRouter.post("/:magicToken/push-native", async (req, res) => {
  const parsed = pushNativeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const client = await prisma.client.findUnique({
    where: { magicToken: req.params.magicToken },
  });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const { expoPushToken, platform } = parsed.data;
  await prisma.pushSubscription.upsert({
    where: { expoPushToken },
    create: {
      shopId: client.shopId,
      clientId: client.id,
      kind: "expo",
      expoPushToken,
      userAgent: platform ?? null,
    },
    update: {
      shopId: client.shopId,
      clientId: client.id,
      kind: "expo",
      userAgent: platform ?? null,
      failureCount: 0,
      lastSeenAt: new Date(),
    },
  });

  res.json({ ok: true });
});
