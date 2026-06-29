import { Router } from "express";
import { z } from "zod";
import {
  REWARDS_SECTION_DEFAULT,
  apiEnv,
  CADENCE_KEYS,
  cadenceToDays,
  type CadenceKey,
  LOYALTY_TIERS,
  LOYALTY_TIER_KEYS,
  loyaltyTierForVisits,
} from "@chairback/config";
import { prisma, runAsOwner } from "@chairback/db";
import { currentBalance } from "../services/punch.js";
import { toE164 } from "../acuity/clientKey.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { logger } from "../logger.js";

const env = apiEnv();

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
  // All reads run via runAsOwner: the tenant tables are FORCE RLS, and this
  // public endpoint resolves a GLOBAL magicToken with no shop context, so a plain
  // owner query is filtered to zero rows by the RLS policy (every token would
  // 404). runAsOwner does SET LOCAL row_security=off for this transaction only.
  const data = await runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { magicToken: req.params.magicToken },
      include: { shop: true },
    });
    if (!client) return null;

    const now = new Date();
    const balance = await currentBalance(client.shopId, client.id, tx);
    const [visits, upcoming, rewards, promotions, redemptions, completedCount] =
      await Promise.all([
      tx.visit.findMany({
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
    tx.visit.findFirst({
      where: {
        shopId: client.shopId,
        clientId: client.id,
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        scheduledAt: { gt: now },
      },
      orderBy: { scheduledAt: "asc" },
      select: { scheduledAt: true },
    }),
    tx.reward.findMany({
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
    tx.promotion.findMany({
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
    tx.punchLedger.findMany({
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
    // Lifetime completed visits drive the loyalty status tier. Counted here
    // (the `visits` list above is capped at 10) so the tier is always exact,
    // independent of whether the engine has stamped Client.loyaltyTier yet.
    tx.visit.count({
      where: { shopId: client.shopId, clientId: client.id, status: "COMPLETED" },
    }),
    ]);
    return {
      client,
      balance,
      visits,
      upcoming,
      rewards,
      promotions,
      redemptions,
      completedCount,
    };
  });

  if (!data) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { client, balance, visits, upcoming, rewards, promotions, redemptions, completedCount } =
    data;
  const now = new Date();

  // Loyalty status tier (Bronze/Silver/Gold by lifetime completed visits) + how
  // far to the next tier, so the page can show "Gold member" and "2 visits to
  // Gold". Tier is null below the first threshold (a brand-new client).
  const loyaltyTierKey = loyaltyTierForVisits(completedCount);
  const nextTierKey =
    LOYALTY_TIER_KEYS[(loyaltyTierKey ? LOYALTY_TIER_KEYS.indexOf(loyaltyTierKey) : -1) + 1] ??
    null;
  const loyalty = {
    tier: loyaltyTierKey,
    label: loyaltyTierKey ? LOYALTY_TIERS[loyaltyTierKey].label : null,
    color: loyaltyTierKey ? LOYALTY_TIERS[loyaltyTierKey].color : null,
    visits: completedCount,
    nextTier: nextTierKey
      ? {
          label: LOYALTY_TIERS[nextTierKey].label,
          visitsAway: Math.max(1, LOYALTY_TIERS[nextTierKey].minVisits - completedCount),
        }
      : null,
  };

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
  // Personalized rebook window: a client's self-reported cadence (captured with
  // one tap at first open) overrides the shop's flat default, so a "monthly"
  // client counts down over ~30 days, not everyone's 14. Falls back to the shop
  // window when there's no self-report.
  const windowDays = client.preferredCadence
    ? cadenceToDays(client.preferredCadence)
    : client.shop.rebookWindowDays;
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
    // Self-reported visit cadence. Drives whether the page shows the one-tap
    // "how often do you get a cut?" prompt: only when there's no preference yet
    // AND no computed cadence (medianIntervalDays null) - i.e. a cold-start client.
    cadence: {
      preference: client.preferredCadence,
      computed: client.medianIntervalDays != null,
    },
    loyalty,
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
 * Runs via runAsOwner: resolves the global magicToken with no shop context. The
 * tenant tables are FORCE RLS, so a plain owner query (no app.current_shop_id)
 * is filtered to zero rows - runAsOwner turns row_security off for this tx only.
 */
rewardsRouter.post("/:magicToken/opt-in", async (req, res) => {
  const parsed = optInSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const rawPhone = parsed.data.phone?.trim();
  const bodyPhone = toE164(parsed.data.phone);
  if (rawPhone && !bodyPhone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  const result = await runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { magicToken: req.params.magicToken },
    });
    if (!client) return { error: "not_found" as const };

    const effectivePhone = client.phone ?? bodyPhone;
    if (!effectivePhone) return { error: "needs_phone" as const };

    // Two writes, deliberately kept separate:
    //  1. Unconditional: clear any prior STOP and set the phone on first opt-in.
    //  2. Guarded (smsConsentAt: null): stamp consent FIRST-WINS, never overwrite.
    await tx.client.update({
      where: { id: client.id },
      data: { optedOut: false, ...(client.phone ? {} : { phone: bodyPhone }) },
    });
    await tx.client.updateMany({
      where: { id: client.id, smsConsentAt: null },
      data: { smsConsentAt: new Date(), smsConsentSource: "client_self_serve" },
    });
    return { ok: true as const };
  });

  if ("error" in result) {
    res.status(result.error === "not_found" ? 404 : 400).json({ error: result.error });
    return;
  }
  res.json({ consent: { state: "opted_in", hasPhone: true } });
});

const cadenceSchema = z
  .object({ cadence: z.enum(CADENCE_KEYS as [CadenceKey, ...CadenceKey[]]) })
  .strict();

/**
 * Client self-reports how often they get a cut (one tap at first app open). Used
 * as a COLD-START seed: it personalizes the rebook countdown window immediately
 * and seeds nextExpectedAt until the client has enough completed visits for the
 * engine (engines/cadence.ts) to compute a real cadence, which then wins.
 *
 * Deliberately NON-sensitive: it touches neither SMS consent nor
 * medianIntervalDays, so it can NEVER make a client textable or trip the nudge
 * gate - it only shapes what THIS client sees on their own page. Safe to
 * overwrite (a later settings change). runAsOwner: resolves the global
 * magicToken with no shop context (the tenant tables are FORCE RLS).
 */
rewardsRouter.post("/:magicToken/cadence", async (req, res) => {
  const parsed = cadenceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const cadence = parsed.data.cadence;

  const result = await runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { magicToken: req.params.magicToken },
      select: { id: true, medianIntervalDays: true, lastVisitAt: true },
    });
    if (!client) return { error: "not_found" as const };

    // Seed nextExpectedAt ONLY as a cold-start: never override a real computed
    // cadence (medianIntervalDays set), and only when there's a last visit to
    // count from. The engine recomputes/overwrites this once history exists.
    const seedNextExpected =
      client.medianIntervalDays === null && client.lastVisitAt
        ? new Date(client.lastVisitAt.getTime() + cadenceToDays(cadence) * 86_400_000)
        : undefined;

    await tx.client.update({
      where: { id: client.id },
      data: {
        preferredCadence: cadence,
        ...(seedNextExpected ? { nextExpectedAt: seedNextExpected } : {}),
      },
    });
    return { ok: true as const };
  });

  if ("error" in result) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({ ok: true, cadence });
});

/**
 * Client self-serve opt-out from their rewards page. PER-CLIENT only (keyed by
 * the magicToken), deliberately narrower than the Twilio STOP handler's
 * phone-wide updateMany: a web action speaks for one client, not everyone who
 * happens to share that number.
 */
rewardsRouter.post("/:magicToken/opt-out", async (req, res) => {
  const result = await runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { magicToken: req.params.magicToken },
    });
    if (!client) return null;
    await tx.client.update({
      where: { id: client.id },
      data: { optedOut: true },
    });
    return { hasPhone: Boolean(client.phone) };
  });
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ consent: { state: "opted_out", hasPhone: result.hasPhone } });
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
  const { endpoint, keys, userAgent } = parsed.data;
  const ok = await runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { magicToken: req.params.magicToken },
    });
    if (!client) return false;
    await tx.pushSubscription.upsert({
      where: { endpoint },
      create: {
        shopId: client.shopId,
        clientId: client.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: userAgent ?? null,
      },
      // Re-subscribe on the same device: refresh keys/userAgent, mark it live,
      // and clear any prior failure strikes. clientId is re-stamped in case the
      // same browser endpoint is reused by a different client (shared device).
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
    return true;
  });

  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
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
  const ok = await runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { magicToken: req.params.magicToken },
    });
    if (!client) return false;
    await tx.pushSubscription.deleteMany({
      where: { endpoint: parsed.data.endpoint, clientId: client.id },
    });
    return true;
  });
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

const resolveByPhoneSchema = z
  .object({ phone: z.string().min(1).max(40) })
  .strict();

/**
 * Cold-start entry for the mobile app: a customer who opens the app without a
 * magic link enters their phone number, and we text them their rewards link
 * (which then deep-links back into the app). Public + unauthenticated like the
 * rest of the rewards routes.
 *
 * PRIVACY: this must not become a phone-enumeration oracle, so the response is
 * ALWAYS the same `{ ok: true }` whether or not a matching, textable client
 * exists. We only actually send when there's a match that consented to SMS and
 * isn't opted out (texting the link is itself a transactional reply to their own
 * request, but we still respect a STOP). If the same phone maps to clients at
 * multiple shops, we text the most recently active one's link.
 */
rewardsRouter.post("/resolve-by-phone", async (req, res) => {
  const parsed = resolveByPhoneSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const phone = toE164(parsed.data.phone);
  // Uniform response regardless of validity/existence (no enumeration signal).
  const ok = { ok: true };

  if (phone) {
    // Lookup via runAsOwner (FORCE RLS; no shop context). The SMS send happens
    // OUTSIDE the transaction so we never hold a DB tx open across a network call.
    const client = await runAsOwner((tx) =>
      tx.client.findFirst({
        where: { phone, optedOut: false, smsConsentAt: { not: null }, archivedAt: null },
        orderBy: [{ lastVisitAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
        include: { shop: { select: { id: true, name: true } } },
      }),
    );
    if (client) {
      const rewardsUrl = `${env.APP_BASE_URL}/r/${client.magicToken}`;
      const who = client.firstName ?? "there";
      const body =
        `Hi ${who}, here's your ${client.shop.name} rewards link: ${rewardsUrl} ` +
        `Reply STOP to opt out.`;
      try {
        const result = await getMessageProvider().send({ to: phone, body });
        // Audit as a loyalty-kind Nudge (transactional, not a marketing blast).
        await runAsOwner((tx) =>
          tx.nudge.create({
            data: {
              shopId: client.shop.id,
              clientId: client.id,
              channel: "SMS",
              status: "SENT",
              kind: "loyalty",
              body,
              sentAt: new Date(),
              messageSid: result.sid,
            },
          }),
        );
      } catch (err) {
        // Never leak failure to the caller (still return ok); just log it.
        logger.error({ err, shopId: client.shop.id, clientId: client.id }, "resolve-by-phone send failed");
      }
    }
  }

  res.json(ok);
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
  const { expoPushToken, platform } = parsed.data;
  const ok = await runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { magicToken: req.params.magicToken },
    });
    if (!client) return false;
    await tx.pushSubscription.upsert({
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
    return true;
  });

  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});
