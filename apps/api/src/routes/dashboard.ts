import { Router } from "express";
import { z } from "zod";
import { forShop, prisma, runWithShop } from "@chairback/db"; // runWithShop: batch a page's tenant reads into one connection
import { NUDGE, apiEnv, randomToken } from "@chairback/config";
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
import { recomputeCadence } from "../engines/cadence.js";
import { loadEligibilityData, sweepShop } from "../engines/nudge.js";
import { isNudgeEligible } from "../engines/eligibility.js";
import { inQuietHours } from "../engines/quietHours.js";
import { buildNudgeBody } from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { toE164 } from "../acuity/clientKey.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export const dashboardRouter: Router = Router();
dashboardRouter.use(requireUser, requireShop);

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
  const db = forShop(shop.id);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [activeClients, nudgesThisMonth, recovered, avgTicket] = await Promise.all([
    db.client.count({ where: { optedOut: false } }),
    db.nudge.count({ where: { status: "SENT", createdAt: { gte: startOfMonth } } }),
    db.nudge.count({ where: { resultedInBookingAt: { not: null } } }),
    prisma.visit.aggregate({
      where: { shopId: shop.id, status: "COMPLETED", price: { not: null } },
      _avg: { price: true },
    }),
  ]);

  const atRisk = await countAtRisk(shop.id, shop.nudgeBufferDays, now);
  const ticket = Number(avgTicket._avg.price ?? 0);

  res.json({
    activeClients,
    atRiskClients: atRisk,
    nudgesThisMonth,
    rebookingsRecovered: recovered,
    estDollarsRecovered: Math.round(recovered * ticket),
    avgTicket: ticket,
  });
});

// Monthly trends: completed visits + nudges sent, configurable range (3/6/12).
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
  const [visits, nudges] = await Promise.all([
    prisma.visit.findMany({
      where: { shopId: shop.id, status: "COMPLETED", scheduledAt: { gte: earliest } },
      select: { scheduledAt: true },
    }),
    prisma.nudge.findMany({
      where: { shopId: shop.id, status: "SENT", createdAt: { gte: earliest } },
      select: { createdAt: true },
    }),
  ]);

  const series = months.map((m) => ({
    label: m.label,
    visits: visits.filter((v) => v.scheduledAt >= m.start && v.scheduledAt < m.end).length,
    nudges: nudges.filter((n) => n.createdAt >= m.start && n.createdAt < m.end).length,
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
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);

  const clients = await prisma.client.findMany({
    where: { id: { in: ranked.map((r) => r.clientId) } },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(clients.map((c) => [c.id, c]));

  res.json({
    leaders: ranked.map((r) => ({
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
  const filter = String(req.query.filter ?? "all"); // all | optedOut | active | needsConsent
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

  const balances = await prisma.punchLedger.groupBy({
    by: ["clientId"],
    where: { shopId: shop.id },
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
      source: c.source,
      lastVisitAt: c.lastVisitAt?.toISOString() ?? null,
      medianIntervalDays: c.medianIntervalDays,
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

// Log a visit by hand (walk-ins / shops not on Acuity). Creates a real
// COMPLETED Visit and runs the SAME earn + cadence pipeline as Acuity ingest,
// so punches, last-visit, and at-risk detection all work without a booking
// integration. Optional `when` backdates (history imports); never the future.
const logVisitSchema = z
  .object({
    when: z.coerce.date().optional(),
    serviceName: z.string().trim().max(120).optional().or(z.literal("")),
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
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const visit = await runWithShop(shop.id, async (tx) => {
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
    await earnPunchForVisitInTx(tx, shop, client.id, created.id, serviceName, when);
    return created;
  });
  // Outside the tx - recomputeCadence opens its own shop-scoped transaction.
  await recomputeCadence(shop.id, client.id);
  const balance = await currentBalance(shop.id, client.id);
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
  await db.client.update({ where: { id: client.id }, data: { optedOut } });
  res.json({ ok: true, optedOut });
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
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { newBalance } = await grantBonusPunches(shop.id, client.id, count);
  res.json({ ok: true, newBalance });
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

  if (action === "optOut" || action === "optIn") {
    const optedOut = action === "optOut";
    const { count } = await prisma.client.updateMany({
      where: { shopId: shop.id, id: { in: clientIds } },
      data: { optedOut },
    });
    res.json({ ok: true, updated: count });
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
    },
  });

  // Enforce the per-shop daily cap, shared with the sweep and promo blasts.
  // Without this, smsLimiter (10 req/min) x 200 clients/req = 2000 texts/min,
  // blowing past dailySendCap (default 50) and running up the shop's SMS bill.
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await db.nudge.count({
    where: { status: "SENT", createdAt: { gte: startOfDay } },
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
    });
    const agg = await tx.punchLedger.aggregate({
      where: { shopId: shop.id, clientId: client.id },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const balance =
      (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
    return { entries, balance };
  });
  if (!data) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    balance: data.balance,
    entries: data.entries.map((e) => ({
      id: e.id,
      at: e.createdAt.toISOString(),
      earned: e.punchesEarned,
      redeemed: e.punchesRedeemed,
      runningBalance: e.runningBalance,
      note: e.note,
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
  res.json({ ok: true, newBalance: result.newBalance });
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
    const agg = await tx.punchLedger.aggregate({
      where: { shopId: shop.id, clientId: client.id },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const balance =
      (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
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
    return { client, visits, nudges, balance, rewards, livePromos };
  });

  if (!data) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { client, visits, nudges, balance, rewards, livePromos } = data;

  res.json({
    client: {
      id: client.id,
      name: name(client),
      firstName: client.firstName,
      phone: client.phone,
      email: client.email,
      optedOut: client.optedOut,
      smsConsent: client.smsConsentAt !== null,
      smsConsentSource: client.smsConsentSource,
      notes: client.notes ?? "",
      source: client.source,
      magicToken: client.magicToken,
      lastVisitAt: client.lastVisitAt?.toISOString() ?? null,
      medianIntervalDays: client.medianIntervalDays,
      nextExpectedAt: client.nextExpectedAt?.toISOString() ?? null,
    },
    balance,
    rewards: rewards.map((r) => ({
      id: r.id,
      name: r.name,
      emoji: r.emoji,
      punchCost: r.punchCost,
      affordable: balance >= r.punchCost,
    })),
    rewardReady: rewards.some((r) => balance >= r.punchCost),
    promotions: livePromos.map((p) => ({ id: p.id, title: p.title })),
    visits: visits.map((v) => ({
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
  const db = forShop(shopId);
  // Mirror the sweep's candidate gate (incl. smsConsentAt) so the at-risk count
  // shown on the dashboard matches who a sweep would actually text - otherwise
  // "12 at risk" but "0 sent" looks broken. Clients lacking consent are managed
  // from the clients page (bulk-attest), not this rebooking list.
  const candidates = await db.client.findMany({
    where: {
      optedOut: false,
      smsConsentAt: { not: null },
      phone: { not: null },
      medianIntervalDays: { not: null },
      lastVisitAt: { not: null },
    },
  });
  if (candidates.length === 0) return [];

  // Batched lookups (4 queries total) instead of 4 queries PER candidate - the
  // old N+1 was ~6 round-trips per client per dashboard load.
  const ids = candidates.map((c) => c.id);
  const [data, lastVisits] = await Promise.all([
    loadEligibilityData(shopId, ids, now),
    db.visit.findMany({
      where: { clientId: { in: ids }, status: "COMPLETED" },
      orderBy: [{ clientId: "asc" }, { scheduledAt: "desc" }],
      distinct: ["clientId"],
      select: { clientId: true, serviceName: true },
    }),
  ]);
  const lastServiceById = new Map(
    lastVisits.map((v) => [v.clientId, v.serviceName]),
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
