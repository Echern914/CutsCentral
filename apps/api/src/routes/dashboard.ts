import { Router } from "express";
import { z } from "zod";
import { forShop, prisma, runAsOwner, runWithShop } from "@chairback/db"; // runWithShop: batch a page's tenant reads into one connection
import {
  NUDGE,
  apiEnv,
  randomToken,
  frequencySegment,
  cadenceToDays,
  LOYALTY_TIER_KEYS,
  type LoyaltyTierKey,
} from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { hasActiveAccess } from "../billing/stripe.js";
import { smsLimiter } from "../middleware/rateLimit.js";
import {
  adjustLedgerEntry,
  currentBalance,
  earnPunchForVisitInTx,
  grantBonusPunches,
  redeemReward,
  reverseLedgerEntry,
} from "../services/punch.js";
import { deleteVisit, editVisit } from "../services/visit.js";
import {
  notifyPunchEarned,
  notifyRewardRedeemed,
} from "../services/loyaltyNotify.js";
import {
  archiveClient,
  editClient,
  mergeClients,
  unarchiveClient,
} from "../services/client.js";
import { recomputeCadence } from "../engines/cadence.js";
import { sweepShop, type EligibilityData } from "../engines/nudge.js";
import { sweepShopWinback } from "../engines/winback.js";
import { isNudgeEligible } from "../engines/eligibility.js";
import { inQuietHours } from "../engines/quietHours.js";
import { buildNudgeBody } from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { pokeWalletPass } from "../wallet/pass.js";
import { toE164 } from "../acuity/clientKey.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export const dashboardRouter: Router = Router();
dashboardRouter.use(requireUser, requireShop);

const pushNativeSchema = z
  .object({
    expoPushToken: z.string().min(1).max(255),
    platform: z.string().max(20).optional(),
  })
  .strict();

/**
 * Register THIS barber/manager's device (the iOS dashboard app) for native
 * push - the authenticated twin of the customer route (routes/rewards.ts
 * push-native). The row is keyed to the USER, not a client: business events
 * (new appointment request) fan out to every device this user registered,
 * across every shop they own. shopId records the shop active at registration
 * (the table's RLS home); the write goes through runAsOwner because a
 * re-registering manager's existing row may carry another of their shops'
 * shopId, which a shop-scoped write couldn't touch. userId/shopId come from
 * the session, never the body. Upsert by token so re-registering refreshes.
 */
dashboardRouter.post("/push/native", async (req, res) => {
  const parsed = pushNativeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const { expoPushToken, platform } = parsed.data;
  await runAsOwner((tx) =>
    tx.pushSubscription.upsert({
      where: { expoPushToken },
      create: {
        shopId: req.shop!.id,
        userId: req.userId!,
        kind: "expo",
        expoPushToken,
        userAgent: platform ?? null,
      },
      update: {
        shopId: req.shop!.id,
        userId: req.userId!,
        // A device is one identity: if this token ever re-registers from the
        // barber app after being a customer device, it stops being client-keyed.
        clientId: null,
        kind: "expo",
        userAgent: platform ?? null,
        failureCount: 0,
        lastSeenAt: new Date(),
      },
    }),
  );
  res.json({ ok: true });
});

function daysSince(d: Date, now: Date): number {
  return Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY);
}

/** Parse a numeric query param defensively: NaN/garbage falls back to `def`,
 * and the result is clamped - a malformed ?limit= must never reach Prisma. */
function intQuery(raw: unknown, def: number, min: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Aggregate stats for the dashboard cards.
dashboardRouter.get("/stats", async (req, res) => {
  const shop = req.shop!;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // ONE transaction for all the card reads. This route used to fan out 5
  // parallel forShop calls (each its own pooled connection); with the web
  // dashboard firing /stats, /at-risk and /trends together, two barbers
  // loading at once could exhaust the 10-connection pool.
  const s = await runWithShop(shop.id, async (tx) => {
    const activeClients = await tx.client.count({
      where: { shopId: shop.id, optedOut: false, archivedAt: null },
    });
    const nudgesThisMonth = await tx.nudge.count({
      where: { shopId: shop.id, status: "SENT", createdAt: { gte: startOfMonth } },
    });
    // Rebookings recovered THIS MONTH. Was previously unbounded (all-time) while
    // the card reads as monthly - attribute by the rebooking date, not all time.
    const recovered = await tx.nudge.count({
      where: { shopId: shop.id, resultedInBookingAt: { gte: startOfMonth } },
    });
    const avgTicket = await tx.visit.aggregate({
      where: { shopId: shop.id, status: "COMPLETED", price: { not: null } },
      _avg: { price: true },
    });
    // Win-back ("Growth Agent") rebookings THIS MONTH: the attributed visit ids
    // for kind="winback" nudges that led to a booking this month. We sum the
    // REAL Visit.price on those visits (not avg-ticket) so the recovered-$ is
    // actual money, falling back to nothing rather than an estimate.
    const winbackRows = await tx.nudge.findMany({
      where: {
        shopId: shop.id,
        kind: "winback",
        resultedInBookingAt: { gte: startOfMonth },
      },
      select: { resultedVisitId: true },
    });

    // Real recovered $ from win-backs: sum the price of the actually-booked
    // visits. A win-back rebooking that's still SCHEDULED (no price yet) simply
    // contributes 0 to the $ total but still counts as a re-engaged client.
    const winbackVisitIds = winbackRows
      .map((n) => n.resultedVisitId)
      .filter((id): id is string => Boolean(id));
    let winbackDollarsRecovered = 0;
    if (winbackVisitIds.length > 0) {
      const sum = await tx.visit.aggregate({
        where: { shopId: shop.id, id: { in: winbackVisitIds }, price: { not: null } },
        _sum: { price: true },
      });
      winbackDollarsRecovered = Math.round(Number(sum._sum.price ?? 0));
    }

    return {
      activeClients,
      nudgesThisMonth,
      recovered,
      avgTicket,
      winbackClientsRecovered: winbackRows.length,
      winbackDollarsRecovered,
    };
  });

  const atRisk = await countAtRisk(shop.id, shop.nudgeBufferDays, now);
  const ticket = Number(s.avgTicket._avg.price ?? 0);

  res.json({
    activeClients: s.activeClients,
    atRiskClients: atRisk,
    nudgesThisMonth: s.nudgesThisMonth,
    rebookingsRecovered: s.recovered,
    estDollarsRecovered: Math.round(s.recovered * ticket),
    avgTicket: ticket,
    // Win-back Growth Agent payoff (this month). Clients re-engaged is always
    // accurate; dollars are REAL summed Visit.price (0 when the rebooking hasn't
    // completed/priced yet), distinct from the avg-ticket estimate above.
    winbackClientsRecovered: s.winbackClientsRecovered,
    winbackDollarsRecovered: s.winbackDollarsRecovered,
  });
});

// Monthly trends over a configurable range (3/6/12). Per-month series:
//   visits (COMPLETED), nudges (SENT), newClients (Client.createdAt),
//   paymentsSucceeded (Payment status=succeeded), rebookingsRecovered
//   (Nudge.resultedInBookingAt). One fetch per source back to `earliest`, then
//   bucketed in memory with half-open [start,end) intervals.
dashboardRouter.get("/trends", async (req, res) => {
  const shop = req.shop!;
  const now = new Date();
  const requested = Number(req.query.months ?? 6);
  const monthCount = [3, 6, 12].includes(requested) ? requested : 6;
  const months: { key: string; label: string; start: Date; end: Date }[] = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    months.push({
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
      label: start.toLocaleString(undefined, { month: "short" }),
      start,
      end,
    });
  }

  const earliest = months[0]!.start;
  // One transaction (one pooled connection) - this fires alongside /stats and
  // /at-risk on every dashboard load, so it must not fan out 5 connections.
  const { visits, nudges, newClients, payments, rebookings } = await runWithShop(
    shop.id,
    async (tx) => {
      const visits = await tx.visit.findMany({
        where: { shopId: shop.id, status: "COMPLETED", scheduledAt: { gte: earliest } },
        select: { scheduledAt: true },
      });
      const nudges = await tx.nudge.findMany({
        where: { shopId: shop.id, status: "SENT", createdAt: { gte: earliest } },
        select: { createdAt: true },
      });
      // New customers per month, by when the client first landed in ChairBack.
      const newClients = await tx.client.findMany({
        where: { shopId: shop.id, createdAt: { gte: earliest } },
        select: { createdAt: true },
      });
      // Successful card payments per month. createdAt is the only reliably-written
      // Payment timestamp (capturedAt/authorizedAt are hold-mode-only, never set).
      // Empty for shops not on ChairBack payments (opt-in Stripe Connect feature).
      const payments = await tx.payment.findMany({
        where: { shopId: shop.id, status: "succeeded", createdAt: { gte: earliest } },
        select: { createdAt: true },
      });
      // Rebookings recovered per month: nudges that led to a booking, by the
      // booking date. Parallels the /stats "rebookings recovered" scalar over time.
      const rebookings = await tx.nudge.findMany({
        where: { shopId: shop.id, resultedInBookingAt: { gte: earliest } },
        select: { resultedInBookingAt: true },
      });
      return { visits, nudges, newClients, payments, rebookings };
    },
  );

  const inMonth = (d: Date | null, m: { start: Date; end: Date }) =>
    d !== null && d >= m.start && d < m.end;

  const series = months.map((m) => ({
    label: m.label,
    visits: visits.filter((v) => inMonth(v.scheduledAt, m)).length,
    nudges: nudges.filter((n) => inMonth(n.createdAt, m)).length,
    newClients: newClients.filter((c) => inMonth(c.createdAt, m)).length,
    paymentsSucceeded: payments.filter((p) => inMonth(p.createdAt, m)).length,
    rebookingsRecovered: rebookings.filter((n) => inMonth(n.resultedInBookingAt, m)).length,
  }));
  res.json({ series });
});

// At-risk client list with a "nudge now" affordance.
dashboardRouter.get("/at-risk", async (req, res) => {
  const shop = req.shop!;
  const now = new Date();
  const rows = await buildAtRiskRows(shop.id, shop.nudgeBufferDays, now);
  res.json({ clients: rows });
});

// Recent activity feed (latest nudges + completed visits, interleaved).
// ?limit controls how many merged items to return (dashboard 20, see-all 100).
dashboardRouter.get("/activity", async (req, res) => {
  const shop = req.shop!;
  const limit = intQuery(req.query.limit, 20, 5, 100);
  const perSource = limit; // pull enough from each source to fill `limit` after merge
  const [nudges, visits] = await Promise.all([
    prisma.nudge.findMany({
      where: { shopId: shop.id, status: "SENT" },
      orderBy: { createdAt: "desc" },
      take: perSource,
      include: { client: { select: { firstName: true, lastName: true } } },
    }),
    prisma.visit.findMany({
      where: { shopId: shop.id, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      take: perSource,
      include: { client: { select: { firstName: true, lastName: true } } },
    }),
  ]);

  const items = [
    ...nudges.map((n) => ({
      type: "nudge" as const,
      at: n.createdAt.toISOString(),
      who: name(n.client),
      detail: n.resultedInBookingAt ? "rebooked after nudge" : "nudge sent",
    })),
    ...visits.map((v) => ({
      type: "visit" as const,
      at: (v.completedAt ?? v.scheduledAt).toISOString(),
      who: name(v.client),
      detail: v.serviceName ?? "visit",
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit);

  res.json({ items });
});

// Punch leaderboard. ?limit controls how many (dashboard 10, see-all up to 100).
dashboardRouter.get("/leaderboard", async (req, res) => {
  const shop = req.shop!;
  const limit = intQuery(req.query.limit, 10, 1, 100);
  const grouped = await prisma.punchLedger.groupBy({
    by: ["clientId"],
    where: { shopId: shop.id },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  const ranked = grouped
    .map((g) => ({
      clientId: g.clientId,
      balance: (g._sum.punchesEarned ?? 0) - (g._sum.punchesRedeemed ?? 0),
    }))
    .filter((r) => r.balance > 0)
    .sort((a, b) => b.balance - a.balance);

  // Resolve names, dropping archived clients (they're hidden from the leaderboard
  // too). Filter BEFORE slicing so an archived high-scorer doesn't shrink the list.
  const clients = await prisma.client.findMany({
    where: { id: { in: ranked.map((r) => r.clientId) }, archivedAt: null },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(clients.map((c) => [c.id, c]));

  res.json({
    leaders: ranked
      .filter((r) => byId.has(r.clientId))
      .slice(0, limit)
      .map((r) => ({
        name: name(byId.get(r.clientId)),
        balance: r.balance,
      })),
  });
});

// Manual "nudge now" for one client. Tight per-user SMS limit (real money).
dashboardRouter.post("/nudge/:clientId", smsLimiter, requireActiveAccess, async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (client.optedOut || !client.phone) {
    res.status(400).json({ error: "cannot_nudge", reason: "opted out or no phone" });
    return;
  }
  // TCPA: even a manual one-off nudge requires recorded consent.
  if (client.smsConsentAt === null) {
    res.status(400).json({ error: "cannot_nudge", reason: "no SMS consent on file" });
    return;
  }
  // TCPA quiet hours: block even a deliberate one-off send outside 8am-9pm
  // shop-local time. 422 (not 400) - the request is valid, just not right now.
  const now = new Date();
  if (inQuietHours(shop.timezone, now)) {
    res.status(422).json({
      error: "quiet_hours",
      reason: "Texting is paused 9pm-8am (client local time). Try again in the morning.",
    });
    return;
  }

  const body = buildNudgeBody({
    firstName: client.firstName,
    shopName: shop.name,
    bookingUrl: shop.bookingUrl,
    magicToken: client.magicToken,
    template: shop.smsTemplate,
    industry: shop.industry,
  });
  const nudge = await db.nudge.create({
    data: { clientId: client.id, channel: "SMS", status: "PENDING", body },
  });
  try {
    const result = await getMessageProvider().send({ to: client.phone, body });
    await db.nudge.update({
      where: { id: nudge.id },
      data: { status: "SENT", sentAt: now, messageSid: result.sid },
    });
    res.json({ ok: true, sid: result.sid });
  } catch (err) {
    await db.nudge.update({
      where: { id: nudge.id },
      data: { status: "FAILED", failedReason: (err as Error).message },
    });
    res.status(502).json({ error: "send_failed" });
  }
});

// Manual redemption of a specific menu reward.
dashboardRouter.post("/redeem/:clientId", async (req, res) => {
  const shop = req.shop!;
  const parsed = z
    .object({ rewardId: z.string().min(1) })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Atomic check-and-redeem (double-click / two tabs can't redeem twice).
  const result = await redeemReward(shop.id, client.id, parsed.data.rewardId);
  if (!result.ok) {
    if (result.reason === "reward_not_found") {
      res.status(404).json({ error: "reward_not_found" });
      return;
    }
    res.status(400).json({
      error: "insufficient_punches",
      balance: result.balance,
      required: result.required,
    });
    return;
  }
  // Text the client their redemption confirmation (gated by the shop toggle +
  // consent + quiet hours inside notify). Fire-and-forget after responding so
  // the barber's redeem button is instant and a send issue can't fail it.
  void notifyRewardRedeemed({
    shopId: shop.id,
    clientId: client.id,
    rewardName: result.reward.name,
    balance: result.newBalance,
    cardTypeId: result.cardTypeId,
    cardName: result.cardName,
  });
  res.json({ ok: true, newBalance: result.newBalance, reward: result.reward });
});

// Client list: search + sort + filter + pagination.
const SORTS = {
  recent: { lastVisitAt: { sort: "desc", nulls: "last" } },
  oldest: { lastVisitAt: { sort: "asc", nulls: "last" } },
  name: { firstName: "asc" },
} as const;

dashboardRouter.get("/clients", async (req, res) => {
  const shop = req.shop!;
  const q = String(req.query.q ?? "").trim();
  const sortKey = (String(req.query.sort ?? "recent") as keyof typeof SORTS);
  const filter = String(req.query.filter ?? "all"); // all | optedOut | active | needsConsent | archived
  const page = intQuery(req.query.page, 1, 1, 100000);
  const pageSize = 50;

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { phone: { contains: q } },
      { email: { contains: q, mode: "insensitive" } },
    ];
  }
  if (filter === "optedOut") where.optedOut = true;
  if (filter === "active") where.optedOut = false;
  // Clients ChairBack can't text yet because no consent is on file - the set a
  // barber would bulk-attest or collect consent for.
  if (filter === "needsConsent") where.smsConsentAt = null;
  // Archived clients are hidden from every other view; only the explicit
  // "archived" filter surfaces them (so they can be restored). All non-archived
  // filters default to hiding archived rows.
  where.archivedAt = filter === "archived" ? { not: null } : null;
  // Loyalty tier filter (a stored column, so it's a cheap WHERE). Ignored unless
  // it's a real tier key, so a junk ?tier= never narrows the list to nothing.
  const tier = String(req.query.tier ?? "");
  if ((LOYALTY_TIER_KEYS as readonly string[]).includes(tier)) {
    where.loyaltyTier = tier as LoyaltyTierKey;
  }

  const db = forShop(shop.id);
  const [total, clients] = await Promise.all([
    db.client.count({ where }),
    db.client.findMany({
      where,
      orderBy: SORTS[sortKey] ?? SORTS.recent,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // Balances for THIS PAGE's clients only. Aggregating the whole shop ledger for
  // a 50-row page scanned tens of thousands of rows on a long-lived shop.
  const pageIds = clients.map((c) => c.id);
  const balances =
    pageIds.length === 0
      ? []
      : await prisma.punchLedger.groupBy({
          by: ["clientId"],
          where: { shopId: shop.id, clientId: { in: pageIds } },
          _sum: { punchesEarned: true, punchesRedeemed: true },
        });
  const balById = new Map(
    balances.map((b) => [b.clientId, (b._sum.punchesEarned ?? 0) - (b._sum.punchesRedeemed ?? 0)]),
  );

  res.json({
    clients: clients.map((c) => ({
      id: c.id,
      name: name(c),
      phone: c.phone,
      email: c.email,
      optedOut: c.optedOut,
      smsConsent: c.smsConsentAt !== null,
      archived: c.archivedAt !== null,
      source: c.source,
      lastVisitAt: c.lastVisitAt?.toISOString() ?? null,
      medianIntervalDays: c.medianIntervalDays,
      // Loyalty status (stored) + a coarse frequency segment derived from the
      // computed cadence, falling back to the self-reported one.
      loyaltyTier: c.loyaltyTier,
      frequencySegment: frequencySegment(
        c.medianIntervalDays ??
          (c.preferredCadence ? cadenceToDays(c.preferredCadence) : null),
      ),
      balance: balById.get(c.id) ?? 0,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// Manually add a client (walk-ins, referrals - no Acuity needed).
const addClientSchema = z
  .object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().max(80).optional(),
    phone: z.string().max(40).optional(),
    email: z.string().email().optional().or(z.literal("")),
    notes: z.string().max(2000).optional(),
    // Barber affirms this walk-in/referral agreed to receive texts. Defaults
    // false: a manually added client is NOT textable unless consent is stated.
    smsConsent: z.boolean().optional().default(false),
  })
  .strict();

dashboardRouter.post("/clients", async (req, res) => {
  const shop = req.shop!;
  const parsed = addClientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const phone = toE164(d.phone);
  // A supplied-but-unparseable phone must fail loudly: silently storing null
  // means the barber thinks the client is reachable when they never will be.
  if (d.phone && d.phone.trim() && !phone) {
    res.status(400).json({
      error: "invalid_phone",
      message: "That phone number doesn't look valid. Use a US number like (302) 555-0142.",
    });
    return;
  }
  // Stable key: phone, else email, else a manual-namespaced random key.
  const key = phone
    ? `tel:${phone}`
    : d.email
      ? `mail:${d.email.toLowerCase()}`
      : `manual:${randomToken(8)}`;

  try {
    const client = await forShop(shop.id).client.upsert({
      where: { shopId_acuityClientKey: { shopId: shop.id, acuityClientKey: key } },
      create: {
        acuityClientKey: key,
        magicToken: randomToken(),
        firstName: d.firstName,
        lastName: d.lastName ?? null,
        phone,
        email: d.email || null,
        notes: d.notes ?? null,
        source: "manual",
        // Only textable if the barber affirmed consent at add-time.
        smsConsentAt: d.smsConsent ? new Date() : null,
        smsConsentSource: d.smsConsent ? "manual" : null,
      },
      update: {
        firstName: d.firstName,
        lastName: d.lastName ?? undefined,
        notes: d.notes ?? undefined,
        // Deliberately NOT touching consent here: re-adding an existing client
        // must not silently re-stamp or overwrite an earlier consent record.
        // To grant consent for an existing client, use the bulk attestConsent
        // action (which guards on smsConsentAt: null).
      },
    });
    res.status(201).json({ id: client.id });
  } catch {
    res.status(500).json({ error: "create_failed" });
  }
});

// Bulk import a client list (migrating off Booksy/Fresha/Vagaro/a spreadsheet —
// every platform lets a barber export their contacts to CSV; the WEB layer parses
// the file and POSTs the rows as JSON here). This is how a barber brings their
// book WITH them — the whole "you own your clients" wedge — without needing the
// old platform's API.
//
// TCPA-CRITICAL: imported clients are NOT textable by default. A spreadsheet of
// contacts is NOT proof of SMS consent. smsConsent applies per-row ONLY when the
// barber explicitly attests they have consent for these clients (one checkbox in
// the UI), and even then we stamp it only on rows with a phone and NEVER
// overwrite an existing consent record (first-consent-wins, like the manual-add
// + Acuity paths). Default = null, source = "import".
const importRowSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  email: z.string().trim().max(160).optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});
const importClientsSchema = z
  .object({
    // Cap per request so one upload can't hold a tenant transaction open forever
    // or OOM the parse. The web layer chunks larger files into multiple calls.
    rows: z.array(importRowSchema).min(1).max(1000),
    // The barber affirms they have SMS consent for EVERY row in this batch.
    // Default false: imported clients are not textable unless this is true.
    attestConsentForAll: z.boolean().optional().default(false),
  })
  .strict();

dashboardRouter.post("/clients/import", async (req, res) => {
  const shop = req.shop!;
  const parsed = importClientsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const { rows, attestConsentForAll } = parsed.data;
  const now = new Date();

  let created = 0;
  let updated = 0;
  const skipped: { row: number; reason: string }[] = [];

  // One tenant transaction for the whole batch: RLS context set once, all upserts
  // atomic + a single connection (the connection-amplification lesson). Each row
  // is upserted by the same stable key scheme as manual-add so a re-import (or a
  // client who already exists from Acuity/booking) merges instead of duplicating.
  await runWithShop(shop.id, async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const rawPhone = r.phone?.trim() || "";
      const email = r.email?.trim() || "";
      const phone = rawPhone ? toE164(rawPhone) : null;
      // A supplied-but-unparseable phone is skipped (not silently stored null —
      // the barber would think the client is reachable). A row with neither a
      // valid phone nor an email still imports under a random manual key (it's a
      // real client in the book, just not yet textable).
      if (rawPhone && !phone) {
        skipped.push({ row: i + 1, reason: "invalid_phone" });
        continue;
      }
      const key = phone
        ? `tel:${phone}`
        : email
          ? `mail:${email.toLowerCase()}`
          : `import:${randomToken(8)}`;
      const consent = attestConsentForAll && phone ? now : null;
      try {
        const existing = await tx.client.findUnique({
          where: { shopId_acuityClientKey: { shopId: shop.id, acuityClientKey: key } },
          select: { id: true },
        });
        await tx.client.upsert({
          where: { shopId_acuityClientKey: { shopId: shop.id, acuityClientKey: key } },
          create: {
            shopId: shop.id,
            acuityClientKey: key,
            magicToken: randomToken(),
            firstName: r.firstName,
            lastName: r.lastName?.trim() || null,
            phone,
            email: email || null,
            notes: r.notes?.trim() || null,
            source: "import",
            smsConsentAt: consent,
            smsConsentSource: consent ? "import_attested" : null,
          },
          update: {
            // Fill in contact details but NEVER clobber an existing record's
            // identity; and deliberately do NOT touch consent on update (re-import
            // must not re-stamp). Only fill blanks.
            firstName: r.firstName,
            lastName: r.lastName?.trim() || undefined,
            email: email || undefined,
            notes: r.notes?.trim() || undefined,
          },
        });
        if (existing) updated++;
        else created++;
        // If attesting consent for an EXISTING client that has none yet, grant it
        // with the same first-consent-wins guard the bulk-attest path uses.
        if (consent && existing) {
          await tx.client.updateMany({
            where: { id: existing.id, smsConsentAt: null },
            data: { smsConsentAt: consent, smsConsentSource: "import_attested" },
          });
        }
      } catch {
        skipped.push({ row: i + 1, reason: "write_failed" });
      }
    }
  }, {
    // Up to 1000 rows x ~2-3 sequential round-trips can exceed Prisma's 5s
    // default interactive-tx timeout and roll back the WHOLE import. Give it
    // room; the web layer already caps the batch at 1000 rows.
    timeout: 60_000,
  });

  res.status(200).json({ created, updated, skipped, total: rows.length });
});

// Log a visit by hand (walk-ins / shops not on Acuity). Creates a real
// COMPLETED Visit and runs the SAME earn + cadence pipeline as Acuity ingest,
// so punches, last-visit, and at-risk detection all work without a booking
// integration. Optional `when` backdates (history imports); never the future.
const logVisitSchema = z
  .object({
    when: z.coerce.date().optional(),
    serviceName: z.string().trim().max(120).optional().or(z.literal("")),
    // Barber's card override: absent = auto-route by service; null = force the
    // default card; an id = punch that specific card.
    cardTypeId: z.string().min(1).nullable().optional(),
  })
  .strict();

dashboardRouter.post("/clients/:clientId/visits", async (req, res) => {
  const shop = req.shop!;
  const parsed = logVisitSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const now = new Date();
  const when = parsed.data.when ?? now;
  // 10-minute clock-skew allowance; beyond that it's a typo'd future date.
  if (when.getTime() > now.getTime() + 10 * 60 * 1000) {
    res.status(400).json({ error: "future_visit", message: "Visit date can't be in the future." });
    return;
  }
  const serviceName = parsed.data.serviceName || null;
  const cardOverride = parsed.data.cardTypeId;
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (cardOverride) {
    // A deliberate "punch this card" pick can't target a retired (archived)
    // card - only live cards take new punches (auto-routing already skips them).
    const card = await db.cardType.findFirst({
      where: { id: cardOverride, active: true },
      select: { id: true },
    });
    if (!card) {
      res.status(404).json({ error: "card_not_found" });
      return;
    }
  }

  const { visit, earn } = await runWithShop(shop.id, async (tx) => {
    // Same client row lock as every other ledger write (serializes earns).
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${client.id} FOR UPDATE`;
    const created = await tx.visit.create({
      data: {
        shopId: shop.id,
        clientId: client.id,
        // Composite unique is (shopId, acuityAppointmentId); manual visits get
        // a namespaced random id so they can never collide with Acuity's.
        acuityAppointmentId: `manual:${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: when,
        endAt: when,
        completedAt: when,
        serviceName,
      },
    });
    const earned = await earnPunchForVisitInTx(
      tx,
      shop,
      client.id,
      created.id,
      serviceName,
      when,
      cardOverride === undefined ? undefined : { cardTypeId: cardOverride },
    );
    return { visit: created, earn: earned };
  });
  // Outside the tx - recomputeCadence opens its own shop-scoped transaction.
  await recomputeCadence(shop.id, client.id);
  // The balance shown is the earned card's (the number the barber just changed).
  const balance = await currentBalance(shop.id, client.id, earn?.cardTypeId ?? null);
  // Text the client their punch (gated by the shop toggle + consent + quiet
  // hours inside notify). Fire-and-forget AFTER responding: a walk-in entry
  // shouldn't wait on Twilio, and a send issue must never fail the visit log.
  if (earn) {
    void notifyPunchEarned({
      shopId: shop.id,
      clientId: client.id,
      earned: earn.earned,
      balance: earn.balance,
      cardTypeId: earn.cardTypeId,
      cardName: earn.cardName,
    });
  }
  res.status(201).json({ ok: true, visitId: visit.id, balance });
});

// Toggle opt-out (opt a client back in, or out, from the dashboard).
dashboardRouter.post("/clients/:clientId/opt", async (req, res) => {
  const shop = req.shop!;
  const optedOut = Boolean(req.body?.optedOut);
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // An SMS STOP is client-owned: only the client can reverse it (by texting
  // START or from their rewards page). Letting the dashboard clear it is the
  // re-contact-after-STOP scenario TCPA fines target ($500-1500/text).
  if (!optedOut && client.optedOut && client.optOutSource === "sms_stop") {
    res.status(409).json({
      error: "sms_stop_locked",
      message:
        "This client texted STOP. Only they can opt back in - by texting START or from their rewards page.",
    });
    return;
  }
  // Stamp "barber" only when actually flipping out - re-sending optedOut:true
  // for an already-out client must not overwrite an existing source (turning
  // an "sms_stop" row into a barber-reversible one).
  if (optedOut !== client.optedOut) {
    await db.client.update({
      where: { id: client.id },
      data: { optedOut, optOutSource: optedOut ? "barber" : null },
    });
  }
  res.json({ ok: true, optedOut });
});

// Edit a client's profile (name / phone / email). Consent and the Acuity sync
// key are deliberately left untouched (see services/client.ts). A non-empty but
// unparseable phone is refused; an empty string clears a field.
const editClientSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().max(80).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    // Allow "" (clears) or a valid email; reject malformed non-empty input.
    email: z.string().trim().max(160).email().nullable().optional().or(z.literal("")),
  })
  .strict()
  .refine(
    (d) =>
      d.firstName !== undefined ||
      d.lastName !== undefined ||
      d.phone !== undefined ||
      d.email !== undefined,
    { message: "Provide at least one field to change." },
  );

dashboardRouter.patch("/clients/:clientId", async (req, res) => {
  const shop = req.shop!;
  const parsed = editClientSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  // z.literal("") on email yields "" - normalize to null (clear) for the service.
  const email =
    parsed.data.email === undefined
      ? undefined
      : parsed.data.email === ""
        ? null
        : parsed.data.email;
  const result = await editClient(shop.id, req.params.clientId, {
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    phone: parsed.data.phone,
    email,
  });
  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: result.reason });
      return;
    }
    res.status(400).json({
      error: result.reason,
      message: "That phone number doesn't look valid. Use a US number like (302) 555-0142.",
    });
    return;
  }
  res.json({ ok: true });
});

// Soft-archive a client: hide it from every active surface without deleting
// history. Reversible via /unarchive. Both are idempotent.
dashboardRouter.post("/clients/:clientId/archive", async (req, res) => {
  const shop = req.shop!;
  const result = await archiveClient(shop.id, req.params.clientId);
  if (!result.ok) {
    res.status(404).json({ error: result.reason });
    return;
  }
  res.json({ ok: true, archived: result.archived });
});

dashboardRouter.post("/clients/:clientId/unarchive", async (req, res) => {
  const shop = req.shop!;
  const result = await unarchiveClient(shop.id, req.params.clientId);
  if (!result.ok) {
    res.status(404).json({ error: result.reason });
    return;
  }
  res.json({ ok: true, archived: result.archived });
});

// Merge a duplicate client into this one. :clientId is the WINNER (kept); the
// body's loserId is folded in (its visits/ledger/nudges/promo uses move here,
// consent reconciles opted-out-wins + earliest-consent-wins, then the loser is
// soft-archived). Tenant-scoped: a foreign winner or loser id 404s.
const mergeSchema = z.object({ loserId: z.string().min(1) }).strict();

dashboardRouter.post("/clients/:clientId/merge", async (req, res) => {
  const shop = req.shop!;
  const parsed = mergeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const result = await mergeClients(shop.id, req.params.clientId, parsed.data.loserId);
  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: result.reason });
      return;
    }
    // same_client: winner and loser are the same row.
    res.status(400).json({ error: result.reason });
    return;
  }
  res.json({ ok: true, balance: result.balance, movedVisits: result.movedVisits });
});

// Save private notes on a client.
dashboardRouter.patch("/clients/:clientId/notes", async (req, res) => {
  const shop = req.shop!;
  const notes = String(req.body?.notes ?? "").slice(0, 2000);
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await db.client.update({ where: { id: client.id }, data: { notes } });
  res.json({ ok: true });
});

// Grant bonus punches (e.g. a referral reward) - recorded in the ledger.
dashboardRouter.post("/clients/:clientId/bonus", async (req, res) => {
  const shop = req.shop!;
  const count = intQuery(req.body?.count, 1, 1, 20);
  const cardParsed = z
    .object({ cardTypeId: z.string().min(1).nullable().optional() })
    .safeParse(req.body ?? {});
  // A malformed cardTypeId is a client bug, not "credit the default card" -
  // reject it (as log-visit/edit-visit/loyalty CRUD do) rather than silently
  // crediting the wrong card's balance.
  if (!cardParsed.success) {
    res.status(400).json({ error: "invalid_input", issues: cardParsed.error.issues });
    return;
  }
  const cardTypeId = cardParsed.data.cardTypeId ?? null;
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await grantBonusPunches(shop.id, client.id, count, cardTypeId);
  if (!result.ok) {
    res.status(404).json({ error: "card_not_found" });
    return;
  }
  // Gifted punches change the balance too - refresh the client's Wallet pass
  // (fire-and-forget; earn/redeem get theirs via loyaltyNotify).
  void pokeWalletPass(client.id);
  res.json({ ok: true, newBalance: result.newBalance });
});

// Bulk actions over selected clients: opt-out, opt-in, or nudge.
dashboardRouter.post("/clients/bulk", smsLimiter, async (req, res) => {
  const shop = req.shop!;
  const parsed = z
    .object({
      // attestConsent: barber affirms these clients agreed to receive texts -
      // stamps smsConsentAt (a legal attestation), distinct from optIn which
      // only clears a prior STOP and must NOT fabricate consent.
      action: z.enum(["optOut", "optIn", "attestConsent", "nudge"]),
      clientIds: z.array(z.string()).min(1).max(200),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { action, clientIds } = parsed.data;
  // Opt-in/out list hygiene stays free; only bulk TEXTING needs active access.
  if (action === "nudge" && !hasActiveAccess(shop)) {
    res.status(402).json({
      error: "subscription_required",
      message:
        "Texting clients is a Premium feature. Upgrade to send rebooking nudges and promo blasts.",
    });
    return;
  }
  const db = forShop(shop.id);

  if (action === "optOut") {
    // Only stamp "barber" on rows actually flipping out - an already-opted-out
    // row keeps its original source (overwriting "sms_stop" would make the
    // client barber-reversible, which STOP rows must never be).
    const { count } = await prisma.client.updateMany({
      where: { shopId: shop.id, id: { in: clientIds }, optedOut: false },
      data: { optedOut: true, optOutSource: "barber" },
    });
    res.json({ ok: true, updated: count });
    return;
  }

  if (action === "optIn") {
    // A client who texted STOP can only be re-enabled by the client (START
    // webhook / rewards page) - the dashboard must not clear it. NULL-inclusive
    // OR: a bare not-filter drops NULL rows (legacy opt-outs) in Prisma.
    const { count } = await prisma.client.updateMany({
      where: {
        shopId: shop.id,
        id: { in: clientIds },
        optedOut: true,
        OR: [{ optOutSource: null }, { optOutSource: { not: "sms_stop" } }],
      },
      data: { optedOut: false, optOutSource: null },
    });
    const lockedByStop = await prisma.client.count({
      where: {
        shopId: shop.id,
        id: { in: clientIds },
        optedOut: true,
        optOutSource: "sms_stop",
      },
    });
    res.json({ ok: true, updated: count, lockedByStop });
    return;
  }

  if (action === "attestConsent") {
    // Stamp consent only where it's not already recorded (first attestation
    // wins; don't overwrite an earlier source/timestamp). CRITICAL: never clear
    // a prior opt-out here. A client who texted STOP has optedOut=true but may
    // still have smsConsentAt=null (e.g. synced from Acuity, never consented,
    // then STOPped); attesting must NOT silently un-STOP them - that's the exact
    // $500-1500/text TCPA exposure. They can only opt back in by texting START.
    // So we scope to optedOut:false and leave optedOut untouched.
    const { count } = await prisma.client.updateMany({
      where: {
        shopId: shop.id,
        id: { in: clientIds },
        smsConsentAt: null,
        optedOut: false,
        archivedAt: null, // never attest consent for an archived (hidden) client
      },
      data: {
        smsConsentAt: new Date(),
        smsConsentSource: "barber_attest",
      },
    });
    res.json({ ok: true, updated: count });
    return;
  }

  const now = new Date();
  // TCPA quiet hours apply to bulk texting too - block the whole batch outside
  // 8am-9pm shop-local time rather than texting a roomful of clients at 2am.
  if (inQuietHours(shop.timezone, now)) {
    res.status(422).json({
      error: "quiet_hours",
      reason: "Texting is paused 9pm-8am (client local time). Try again in the morning.",
    });
    return;
  }

  // Bulk nudge: only textable clients (consented, not opted out, has phone).
  // This is a deliberate barber action but still bound by TCPA consent.
  const clients = await db.client.findMany({
    where: {
      id: { in: clientIds },
      optedOut: false,
      smsConsentAt: { not: null },
      phone: { not: null },
      archivedAt: null, // never bulk-text an archived (hidden) client
    },
  });

  // Enforce the per-shop daily cap, shared with the sweep and promo blasts.
  // Without this, smsLimiter (10 req/min) x 200 clients/req = 2000 texts/min,
  // blowing past dailySendCap (default 50) and running up the shop's SMS bill.
  // kind="loyalty" transactional texts are exempt (don't count against the cap).
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await db.nudge.count({
    where: { status: "SENT", createdAt: { gte: startOfDay }, kind: { not: "loyalty" } },
  });
  let budget = Math.max(0, shop.dailySendCap - sentToday);

  const provider = getMessageProvider();
  let sent = 0;
  let failed = 0;
  let skippedCap = 0;
  for (const client of clients) {
    if (budget <= 0) {
      skippedCap++;
      continue;
    }
    const body = buildNudgeBody({
      firstName: client.firstName,
      shopName: shop.name,
      bookingUrl: shop.bookingUrl,
      magicToken: client.magicToken,
      template: shop.smsTemplate,
      industry: shop.industry,
    });
    const nudge = await db.nudge.create({
      data: { clientId: client.id, channel: "SMS", status: "PENDING", body },
    });
    try {
      const result = await provider.send({ to: client.phone!, body });
      await db.nudge.update({
        where: { id: nudge.id },
        data: { status: "SENT", sentAt: now, messageSid: result.sid },
      });
      sent++;
      budget--;
    } catch (err) {
      await db.nudge.update({
        where: { id: nudge.id },
        data: { status: "FAILED", failedReason: (err as Error).message },
      });
      failed++;
    }
  }
  res.json({
    ok: true,
    sent,
    failed,
    skippedCap,
    skipped: clientIds.length - clients.length,
  });
});

// Punch ledger detail for one client (earned/redeemed/bonus history).
dashboardRouter.get("/clients/:clientId/ledger", async (req, res) => {
  const shop = req.shop!;
  // One connection for the whole request - same pool-contention fix as the
  // client-detail route above (findFirst + findMany + balance were 3 separate
  // transactions). This call runs in parallel with the detail fetch on the page,
  // so keeping each request to a single connection matters under a small pool.
  const data = await runWithShop(shop.id, async (tx) => {
    const client = await tx.client.findFirst({
      where: { shopId: shop.id, id: req.params.clientId },
    });
    if (!client) return null;
    const entries = await tx.punchLedger.findMany({
      where: { shopId: shop.id, clientId: client.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        cardType: { select: { id: true, name: true, emoji: true, accentColor: true } },
      },
    });
    // Per-card balances in one groupBy; the total stays the top-level number
    // (back-compat) and the cards array powers per-card chips in the UI.
    const groups = await tx.punchLedger.groupBy({
      by: ["cardTypeId"],
      where: { shopId: shop.id, clientId: client.id },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const shopCards = await tx.cardType.findMany({
      where: { shopId: shop.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, emoji: true, accentColor: true, active: true },
    });
    return { entries, groups, shopCards };
  });
  if (!data) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const balanceByCard = new Map(
    data.groups.map((g) => [
      g.cardTypeId,
      (g._sum.punchesEarned ?? 0) - (g._sum.punchesRedeemed ?? 0),
    ]),
  );
  const balance = [...balanceByCard.values()].reduce((sum, b) => sum + b, 0);
  // Default card first, then the shop's cards in their configured order. Cards
  // with no ledger rows show 0 - the barber still sees every card that exists.
  const cards = [
    { id: null as string | null, name: "Punch Card", emoji: null as string | null, accentColor: null as string | null, active: true, balance: balanceByCard.get(null) ?? 0 },
    ...data.shopCards.map((c) => ({
      id: c.id as string | null,
      name: c.name,
      emoji: c.emoji,
      accentColor: c.accentColor,
      active: c.active,
      balance: balanceByCard.get(c.id) ?? 0,
    })),
  ];
  res.json({
    balance,
    cards,
    entries: data.entries.map((e) => ({
      id: e.id,
      at: e.createdAt.toISOString(),
      earned: e.punchesEarned,
      redeemed: e.punchesRedeemed,
      runningBalance: e.runningBalance,
      note: e.note,
      card: e.cardType
        ? {
            id: e.cardType.id,
            name: e.cardType.name,
            emoji: e.cardType.emoji,
            accentColor: e.cardType.accentColor,
          }
        : null,
      // Reversal state for the editing UI:
      //  - reversed: this ORIGINAL row was undone (show struck-through, no controls)
      //  - isCorrection: this row IS an undo/edit of another (show dimmed, no controls)
      //  - editable: a live earn the barber can re-count (earn, not yet reversed)
      reversed: e.reversedAt !== null,
      isCorrection: e.reversalOfId !== null,
      editable:
        e.reversalOfId === null &&
        e.reversedAt === null &&
        e.punchesEarned > 0 &&
        e.punchesRedeemed === 0,
    })),
  });
});

// Undo a single ledger entry (mis-clicked punch, wrong visit, wrong client).
// Writes an offsetting correction row and marks the original reversed - the
// balance self-heals and the history is preserved. forShop-scoped via the
// service (entry must belong to this shop + this client).
dashboardRouter.post("/clients/:clientId/ledger/:entryId/reverse", async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await reverseLedgerEntry(shop.id, client.id, req.params.entryId);
  if (!result.ok) {
    const status = result.reason === "entry_not_found" ? 404 : 409;
    res.status(status).json({ error: result.reason });
    return;
  }
  // Undo changed the balance - refresh the Wallet pass (fire-and-forget), else
  // it shows the stale higher balance until some later earn/redeem pokes it.
  void pokeWalletPass(client.id);
  res.json({ ok: true, newBalance: result.newBalance });
});

// Edit how many punches an EARN entry granted. Reverses the original and
// re-grants the corrected amount in one transaction.
dashboardRouter.post("/clients/:clientId/ledger/:entryId/adjust", async (req, res) => {
  const shop = req.shop!;
  const parsed = z
    .object({ punches: z.number().int().min(1).max(20) })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await adjustLedgerEntry(
    shop.id,
    client.id,
    req.params.entryId,
    parsed.data.punches,
  );
  if (!result.ok) {
    if (result.reason === "entry_not_found") {
      res.status(404).json({ error: result.reason });
      return;
    }
    if (result.reason === "would_go_negative") {
      res.status(409).json({ error: result.reason, balance: result.balance });
      return;
    }
    // already_reversed | is_a_correction | not_an_earn: the entry isn't editable.
    res.status(409).json({ error: result.reason });
    return;
  }
  // Adjusted the earn amount -> balance changed; refresh the Wallet pass.
  void pokeWalletPass(client.id);
  res.json({ ok: true, newBalance: result.newBalance });
});

// Edit a past visit's date and/or service. For a COMPLETED visit this can change
// the punch amount (rules/promos), so the service reverses-and-re-earns and
// refuses if the corrected balance would go negative. At least one field required.
const editVisitSchema = z
  .object({
    when: z.coerce.date().optional(),
    // Distinguish "omitted" (leave service) from "" (clear it). The service
    // treats undefined as unchanged and "" as null.
    serviceName: z.string().trim().max(120).nullable().optional(),
    // Move the earn to a specific card. Omitted = keep/auto (see editVisit);
    // null = force the default card.
    cardTypeId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine(
    (d) => d.when !== undefined || d.serviceName !== undefined || d.cardTypeId !== undefined,
    { message: "Provide a new date, service, or card." },
  );

dashboardRouter.patch("/clients/:clientId/visits/:visitId", async (req, res) => {
  const shop = req.shop!;
  const parsed = editVisitSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  if (parsed.data.cardTypeId) {
    // An explicit re-route to a card can't target a retired (archived) one. This
    // guard only runs when the barber PASSED a cardTypeId; a date-only edit that
    // internally reuses the earn's existing card doesn't come through here, so a
    // visit already sitting on an archived card can still have its date fixed.
    const card = await forShop(shop.id).cardType.findFirst({
      where: { id: parsed.data.cardTypeId, active: true },
      select: { id: true },
    });
    if (!card) {
      res.status(404).json({ error: "card_not_found" });
      return;
    }
  }
  if (parsed.data.when) {
    const now = new Date();
    // Same 10-minute clock-skew allowance as logging a visit.
    if (parsed.data.when.getTime() > now.getTime() + 10 * 60 * 1000) {
      res.status(400).json({ error: "future_visit", message: "Visit date can't be in the future." });
      return;
    }
  }
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await editVisit(shop, client.id, req.params.visitId, {
    when: parsed.data.when,
    serviceName: parsed.data.serviceName,
    cardTypeId: parsed.data.cardTypeId,
  });
  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: result.reason });
      return;
    }
    res.status(409).json({ error: result.reason, balance: result.balance });
    return;
  }
  // Editing a visit can re-earn/claw back its punch -> balance may have changed;
  // refresh the Wallet pass (fire-and-forget, no-ops while wallet is dark).
  void pokeWalletPass(client.id);
  res.json({ ok: true, balance: result.balance });
});

// Delete a past visit. A COMPLETED visit's punch is clawed back first (refuses if
// that would drive the balance negative - those punches were spent on a reward).
dashboardRouter.delete("/clients/:clientId/visits/:visitId", async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await deleteVisit(shop.id, client.id, req.params.visitId);
  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: result.reason });
      return;
    }
    res.status(409).json({ error: result.reason, balance: result.balance });
    return;
  }
  // Deleting a COMPLETED visit claws back its punch -> refresh the Wallet pass.
  void pokeWalletPass(client.id);
  res.json({ ok: true, balance: result.balance });
});

// Single client detail: profile, visits, punch balance, nudge history.
dashboardRouter.get("/clients/:clientId", async (req, res) => {
  const shop = req.shop!;
  const now = new Date();
  // Read everything this page needs inside ONE tenant transaction (one DB
  // connection), not the old findFirst + five parallel forShop() calls. Each
  // forShop()/currentBalance opens its own interactive $transaction, and an
  // interactive transaction holds its connection for its whole life - so the old
  // path grabbed 4-5 connections at once PER request. Behind a small pool (the
  // serverless connection_limit=1 footgun) those contend, hit Prisma's pool
  // timeout, and the route 500s -> the dashboard's "Couldn't load this client"
  // dead-end. The lighter clients-list page issues fewer concurrent transactions,
  // so it survives the same pool - which is why list works but the detail click
  // fails. Sequential reads on one connection remove that amplification entirely;
  // the tx is already RLS-scoped (runWithShop sets app.current_shop_id), and we
  // keep the explicit shopId filters so app-layer scoping holds too.
  const data = await runWithShop(shop.id, async (tx) => {
    const client = await tx.client.findFirst({
      where: { shopId: shop.id, id: req.params.clientId },
    });
    if (!client) return null;
    const visits = await tx.visit.findMany({
      where: { shopId: shop.id, clientId: client.id },
      orderBy: { scheduledAt: "desc" },
      take: 50,
    });
    const nudges = await tx.nudge.findMany({
      where: { shopId: shop.id, clientId: client.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    // Per-card balances (cardTypeId null = the default card). Rewards redeem
    // from their OWN card, so "affordable" must compare against that balance.
    const groups = await tx.punchLedger.groupBy({
      by: ["cardTypeId"],
      where: { shopId: shop.id, clientId: client.id },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const shopCards = await tx.cardType.findMany({
      where: { shopId: shop.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, emoji: true, accentColor: true, active: true },
    });
    const rewards = await tx.reward.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { punchCost: "asc" }],
    });
    const livePromos = await tx.promotion.findMany({
      where: {
        shopId: shop.id,
        active: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: { createdAt: "desc" },
    });
    return { client, visits, nudges, groups, shopCards, rewards, livePromos };
  });

  if (!data) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { client, visits, nudges, groups, shopCards, rewards, livePromos } = data;
  const balanceByCard = new Map(
    groups.map((g) => [
      g.cardTypeId,
      (g._sum.punchesEarned ?? 0) - (g._sum.punchesRedeemed ?? 0),
    ]),
  );
  const balance = [...balanceByCard.values()].reduce((sum, b) => sum + b, 0);
  const cardBalance = (cardTypeId: string | null) => balanceByCard.get(cardTypeId) ?? 0;

  res.json({
    client: {
      id: client.id,
      name: name(client),
      firstName: client.firstName,
      lastName: client.lastName,
      phone: client.phone,
      email: client.email,
      optedOut: client.optedOut,
      archived: client.archivedAt !== null,
      smsConsent: client.smsConsentAt !== null,
      smsConsentSource: client.smsConsentSource,
      notes: client.notes ?? "",
      source: client.source,
      magicToken: client.magicToken,
      lastVisitAt: client.lastVisitAt?.toISOString() ?? null,
      medianIntervalDays: client.medianIntervalDays,
      nextExpectedAt: client.nextExpectedAt?.toISOString() ?? null,
      loyaltyTier: client.loyaltyTier,
      preferredCadence: client.preferredCadence,
    },
    balance,
    cards: [
      {
        id: null as string | null,
        name: "Punch Card",
        emoji: null as string | null,
        accentColor: null as string | null,
        active: true,
        balance: cardBalance(null),
      },
      ...shopCards.map((c) => ({
        id: c.id as string | null,
        name: c.name,
        emoji: c.emoji,
        accentColor: c.accentColor,
        active: c.active,
        balance: cardBalance(c.id),
      })),
    ],
    rewards: rewards.map((r) => ({
      id: r.id,
      name: r.name,
      emoji: r.emoji,
      punchCost: r.punchCost,
      cardTypeId: r.cardTypeId,
      affordable: cardBalance(r.cardTypeId) >= r.punchCost,
    })),
    rewardReady: rewards.some((r) => cardBalance(r.cardTypeId) >= r.punchCost),
    promotions: livePromos.map((p) => ({ id: p.id, title: p.title })),
    visits: visits.map((v) => ({
      id: v.id,
      date: v.scheduledAt.toISOString(),
      status: v.status,
      service: v.serviceName,
    })),
    nudges: nudges.map((n) => ({
      sentAt: (n.sentAt ?? n.createdAt).toISOString(),
      status: n.status,
      resultedInBooking: Boolean(n.resultedInBookingAt),
    })),
  });
});

// CSV export of all clients (records / analysis).
dashboardRouter.get("/export/clients.csv", async (req, res) => {
  const shop = req.shop!;
  const clients = await forShop(shop.id).client.findMany({
    where: { archivedAt: null }, // export the active book, not hidden clients
    orderBy: { lastVisitAt: { sort: "desc", nulls: "last" } },
  });
  const balances = await prisma.punchLedger.groupBy({
    by: ["clientId"],
    where: { shopId: shop.id },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  const balById = new Map(
    balances.map((b) => [b.clientId, (b._sum.punchesEarned ?? 0) - (b._sum.punchesRedeemed ?? 0)]),
  );
  const rows = clients.map((c) => [
    name(c),
    c.phone ?? "",
    c.email ?? "",
    c.optedOut ? "yes" : "no",
    c.source,
    c.lastVisitAt ? c.lastVisitAt.toISOString().slice(0, 10) : "",
    c.medianIntervalDays ?? "",
    balById.get(c.id) ?? 0,
  ]);
  sendCsv(res, "clients.csv",
    ["Name", "Phone", "Email", "Opted out", "Source", "Last visit", "Visits every (days)", "Punch balance"],
    rows);
});

// CSV export of nudge history.
dashboardRouter.get("/export/nudges.csv", async (req, res) => {
  const shop = req.shop!;
  const nudges = await prisma.nudge.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    include: { client: { select: { firstName: true, lastName: true } } },
  });
  const rows = nudges.map((n) => [
    name(n.client),
    (n.sentAt ?? n.createdAt).toISOString(),
    n.status,
    n.resultedInBookingAt ? "yes" : "no",
  ]);
  sendCsv(res, "nudges.csv", ["Client", "Sent at", "Status", "Led to rebooking"], rows);
});

// Nudge history across the shop (who, when, did it convert).
dashboardRouter.get("/nudges", async (req, res) => {
  const shop = req.shop!;
  const nudges = await prisma.nudge.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { client: { select: { firstName: true, lastName: true } } },
  });
  res.json({
    nudges: nudges.map((n) => ({
      who: name(n.client),
      at: (n.sentAt ?? n.createdAt).toISOString(),
      status: n.status,
      resultedInBooking: Boolean(n.resultedInBookingAt),
    })),
  });
});

// Appointment-request inbox: leads from the public page form, newest first.
dashboardRouter.get("/requests", async (req, res) => {
  const db = forShop(req.shop!.id);
  const requests = await db.appointmentRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({
    requests: requests.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      phone: r.phone,
      email: r.email,
      message: r.message,
      preferredTime: r.preferredTime,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// Reviews inbox: every review for moderation, newest first. Includes PENDING
// (awaiting approval), APPROVED (live on the public page), and HIDDEN. The public
// page only ever shows APPROVED - this is the barber's full moderation view.
dashboardRouter.get("/reviews", async (req, res) => {
  const db = forShop(req.shop!.id);
  const reviews = await db.review.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // Count pending so the dashboard can badge "N awaiting approval".
  const pendingCount = reviews.filter((r) => r.status === "PENDING").length;
  res.json({
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      authorName: r.authorName,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    pendingCount,
  });
});

// Moderate a review: approve (publish), hide (un-publish), or send back to
// pending. Tenant-scoped: findFirst through forShop 404s another shop's review.
const reviewStatusSchema = z
  .object({ status: z.enum(["APPROVED", "HIDDEN", "PENDING"]) })
  .strict();
dashboardRouter.post("/reviews/:id", async (req, res) => {
  const parsed = reviewStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const db = forShop(req.shop!.id);
  const existing = await db.review.findFirst({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await db.review.update({
    where: { id: existing.id },
    data: { status: parsed.data.status },
  });
  res.json({ ok: true, status: parsed.data.status });
});

// Update a lead's status (NEW -> CONTACTED -> CLOSED). Tenant-scoped: the
// findFirst through forShop returns 404 for another shop's request.
const requestStatusSchema = z
  .object({ status: z.enum(["NEW", "CONTACTED", "CLOSED"]) })
  .strict();
dashboardRouter.post("/requests/:id", async (req, res) => {
  const parsed = requestStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const db = forShop(req.shop!.id);
  const existing = await db.appointmentRequest.findFirst({
    where: { id: req.params.id },
  });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await db.appointmentRequest.update({
    where: { id: existing.id },
    data: { status: parsed.data.status },
  });
  res.json({ ok: true, status: parsed.data.status });
});

// Run a dry-run sweep preview (who WOULD be nudged) without sending.
dashboardRouter.post("/sweep-preview", smsLimiter, async (req, res) => {
  const summary = await sweepShop(req.shop!, { dryRun: true });
  res.json(summary);
});

// Win-back ("Growth Agent") preview: a dry-run win-back sweep that shows WHO the
// agent would re-engage, without sending anything. Lets a barber see the value
// today, before 10DLC / before turning on real sends. The dry-run writes SKIPPED
// kind="winback" rows; we read them back to list the previewed clients + how
// lapsed each is. smsLimiter even though nothing sends - it's an expensive sweep.
dashboardRouter.post("/winback-preview", smsLimiter, async (req, res) => {
  const summary = await sweepShopWinback(req.shop!, { dryRun: true });
  // The dry-run sweep returns the exact clients it would text on summary.preview
  // (collected in-memory), so the list is precisely this run's - no read-back of
  // accumulating SKIPPED rows, no double-listing on a rapid re-preview.
  res.json({ summary, clients: summary.preview ?? [] });
});

// Run the real sweep now - texts every eligible client (respects daily cap).
dashboardRouter.post("/sweep", smsLimiter, requireActiveAccess, async (req, res) => {
  const summary = await sweepShop(req.shop!, { dryRun: false });
  res.json(summary);
});

// helpers

function name(c: { firstName: string | null; lastName: string | null } | undefined): string {
  if (!c) return "Unknown";
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown";
}

/** Escape + stream rows as a CSV download. */
function sendCsv(
  res: import("express").Response,
  filename: string,
  header: string[],
  rows: (string | number)[][],
): void {
  const esc = (v: string | number) => {
    let s = String(v);
    // Neutralize spreadsheet formula injection (=, +, -, @, tab, CR prefixes
    // in attacker-influenced text like client names) before CSV quoting.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

async function countAtRisk(shopId: string, bufferDays: number, now: Date): Promise<number> {
  return (await buildAtRiskRows(shopId, bufferDays, now)).length;
}

async function buildAtRiskRows(shopId: string, bufferDays: number, now: Date) {
  const since = new Date(
    now.getTime() - (NUDGE.suppressionDays + 1) * MS_PER_DAY,
  );
  // Everything this function reads runs in ONE transaction (one pooled
  // connection). It's called from /at-risk AND from /stats (via countAtRisk),
  // both of which fire on every dashboard load; keeping it to a single
  // connection is what stops the pool from being exhausted at 100 shops.
  // The per-client tallies use DB-side groupBy (Postgres returns one row per
  // client) rather than streaming every historical visit into Node.
  const built = await runWithShop(shopId, async (tx) => {
    // Mirror the sweep's candidate gate (incl. smsConsentAt) so the at-risk
    // count shown on the dashboard matches who a sweep would actually text -
    // otherwise "12 at risk" but "0 sent" looks broken. Clients lacking consent
    // are managed from the clients page (bulk-attest), not this rebooking list.
    const candidates = await tx.client.findMany({
      where: {
        shopId,
        optedOut: false,
        smsConsentAt: { not: null },
        phone: { not: null },
        medianIntervalDays: { gt: 0 }, // gt also excludes legacy stored-0 rows (no real cadence)
        lastVisitAt: { not: null },
        archivedAt: null, // archived clients drop off the at-risk list
      },
    });
    if (candidates.length === 0) return null;

    const ids = candidates.map((c) => c.id);
    const [completed, upcoming, nudges, lastVisits] = await Promise.all([
      tx.visit.groupBy({
        by: ["clientId"],
        where: { shopId, clientId: { in: ids }, status: "COMPLETED" },
        _count: { _all: true },
      }),
      tx.visit.groupBy({
        by: ["clientId"],
        where: {
          shopId,
          clientId: { in: ids },
          status: "SCHEDULED",
          scheduledAt: { gt: now },
        },
      }),
      tx.nudge.groupBy({
        by: ["clientId"],
        where: {
          shopId,
          clientId: { in: ids },
          status: { in: ["SENT", "PENDING"] },
          createdAt: { gte: since },
        },
        _max: { createdAt: true },
      }),
      tx.visit.findMany({
        where: { shopId, clientId: { in: ids }, status: "COMPLETED" },
        orderBy: [{ clientId: "asc" }, { scheduledAt: "desc" }],
        distinct: ["clientId"],
        select: { clientId: true, serviceName: true },
      }),
    ]);
    return { candidates, completed, upcoming, nudges, lastVisits };
  });

  if (!built) return [];
  const { candidates } = built;
  const data: EligibilityData = {
    completedCounts: new Map(
      built.completed.map((r) => [r.clientId, r._count._all]),
    ),
    upcomingIds: new Set(built.upcoming.map((r) => r.clientId)),
    lastNudgeAt: new Map(
      built.nudges
        .filter((r) => r._max.createdAt)
        .map((r) => [r.clientId, r._max.createdAt as Date]),
    ),
  };
  const lastServiceById = new Map(
    built.lastVisits.map((v) => [v.clientId, v.serviceName]),
  );

  const rows: {
    id: string;
    name: string;
    phone: string | null;
    lastService: string | null;
    magicToken: string;
    daysOverdue: number;
    medianIntervalDays: number;
    lastVisitAt: string;
  }[] = [];

  for (const c of candidates) {
    const lastNudge = data.lastNudgeAt.get(c.id);
    const daysSinceLastVisit = c.lastVisitAt ? daysSince(c.lastVisitAt, now) : null;
    const eligible = isNudgeEligible({
      completedVisitCount: data.completedCounts.get(c.id) ?? 0,
      medianIntervalDays: c.medianIntervalDays,
      daysSinceLastVisit,
      hasUpcomingVisit: data.upcomingIds.has(c.id),
      daysSinceLastNudge: lastNudge ? daysSince(lastNudge, now) : null,
      optedOut: c.optedOut,
      phone: c.phone,
      nudgeBufferDays: bufferDays,
      smsConsentAt: c.smsConsentAt,
    });
    if (!eligible) continue;

    rows.push({
      id: c.id,
      name: name(c),
      phone: c.phone,
      lastService: lastServiceById.get(c.id) ?? null,
      magicToken: c.magicToken,
      daysOverdue:
        (daysSinceLastVisit ?? 0) - ((c.medianIntervalDays ?? 0) + bufferDays),
      medianIntervalDays: c.medianIntervalDays!,
      lastVisitAt: c.lastVisitAt!.toISOString(),
    });
  }

  return rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export { NUDGE };
