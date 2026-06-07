import { Router } from "express";
import { z } from "zod";
import { forShop, prisma } from "@chairback/db";
import { NUDGE, randomToken } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { smsLimiter } from "../middleware/rateLimit.js";
import { currentBalance, redeemPunches } from "../services/punch.js";
import { sweepShop } from "../engines/nudge.js";
import { isNudgeEligible } from "../engines/eligibility.js";
import { buildNudgeBody } from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { toE164 } from "../acuity/clientKey.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export const dashboardRouter: Router = Router();
dashboardRouter.use(requireUser, requireShop);

function daysSince(d: Date, now: Date): number {
  return Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY);
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

// At-risk client list with a "nudge now" affordance.
dashboardRouter.get("/at-risk", async (req, res) => {
  const shop = req.shop!;
  const now = new Date();
  const rows = await buildAtRiskRows(shop.id, shop.nudgeBufferDays, now);
  res.json({ clients: rows });
});

// Recent activity feed (latest nudges + completed visits, interleaved).
dashboardRouter.get("/activity", async (req, res) => {
  const shop = req.shop!;
  // Reads-with-relations use prisma directly with an explicit shopId filter
  // (forShop covers the common where/create stamping; includes stay simple here).
  const [nudges, visits] = await Promise.all([
    prisma.nudge.findMany({
      where: { shopId: shop.id, status: "SENT" },
      orderBy: { createdAt: "desc" },
      take: 15,
      include: { client: { select: { firstName: true, lastName: true } } },
    }),
    prisma.visit.findMany({
      where: { shopId: shop.id, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      take: 15,
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
    .slice(0, 20);

  res.json({ items });
});

// Punch leaderboard (top balances).
dashboardRouter.get("/leaderboard", async (req, res) => {
  const shop = req.shop!;
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
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);

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
dashboardRouter.post("/nudge/:clientId", smsLimiter, async (req, res) => {
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
    await prisma.nudge.update({
      where: { id: nudge.id },
      data: { status: "SENT", sentAt: new Date(), messageSid: result.sid },
    });
    res.json({ ok: true, sid: result.sid });
  } catch (err) {
    await prisma.nudge.update({
      where: { id: nudge.id },
      data: { status: "FAILED", failedReason: (err as Error).message },
    });
    res.status(502).json({ error: "send_failed" });
  }
});

// Manual punch redemption.
dashboardRouter.post("/redeem/:clientId", async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const balance = await currentBalance(shop.id, client.id);
  if (balance < shop.rewardThreshold) {
    res.status(400).json({ error: "insufficient_punches", balance });
    return;
  }
  await redeemPunches(shop.id, client.id, shop.rewardThreshold);
  res.json({ ok: true, newBalance: balance - shop.rewardThreshold });
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
  const filter = String(req.query.filter ?? "all"); // all | optedOut | active
  const page = Math.max(1, Number(req.query.page ?? 1));
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

// Manually add a client (walk-ins, referrals — no Acuity needed).
const addClientSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().max(80).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal("")),
  notes: z.string().max(2000).optional(),
});

dashboardRouter.post("/clients", async (req, res) => {
  const shop = req.shop!;
  const parsed = addClientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const phone = toE164(d.phone);
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
      },
      update: {
        firstName: d.firstName,
        lastName: d.lastName ?? undefined,
        notes: d.notes ?? undefined,
      },
    });
    res.status(201).json({ id: client.id });
  } catch {
    res.status(500).json({ error: "create_failed" });
  }
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

// Grant bonus punches (e.g. a referral reward) — recorded in the ledger.
dashboardRouter.post("/clients/:clientId/bonus", async (req, res) => {
  const shop = req.shop!;
  const count = Math.max(1, Math.min(20, Number(req.body?.count ?? 1)));
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const balance = await currentBalance(shop.id, client.id);
  await db.punch.create({
    data: {
      clientId: client.id,
      visitId: null,
      punchesEarned: count,
      runningBalance: balance + count,
      note: "bonus",
    },
  });
  res.json({ ok: true, newBalance: balance + count });
});

// Single client detail: profile, visits, punch balance, nudge history.
dashboardRouter.get("/clients/:clientId", async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [visits, nudges, balance] = await Promise.all([
    db.visit.findMany({
      where: { clientId: client.id },
      orderBy: { scheduledAt: "desc" },
      take: 50,
    }),
    db.nudge.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    currentBalance(shop.id, client.id),
  ]);

  res.json({
    client: {
      id: client.id,
      name: name(client),
      firstName: client.firstName,
      phone: client.phone,
      email: client.email,
      optedOut: client.optedOut,
      notes: client.notes ?? "",
      source: client.source,
      magicToken: client.magicToken,
      lastVisitAt: client.lastVisitAt?.toISOString() ?? null,
      medianIntervalDays: client.medianIntervalDays,
      nextExpectedAt: client.nextExpectedAt?.toISOString() ?? null,
    },
    balance,
    rewardThreshold: shop.rewardThreshold,
    rewardReady: balance >= shop.rewardThreshold,
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

// Run a dry-run sweep preview (who WOULD be nudged) without sending.
dashboardRouter.post("/sweep-preview", smsLimiter, async (req, res) => {
  const summary = await sweepShop(req.shop!, { dryRun: true });
  res.json(summary);
});

// Run the real sweep now — texts every eligible client (respects daily cap).
dashboardRouter.post("/sweep", smsLimiter, async (req, res) => {
  const summary = await sweepShop(req.shop!, { dryRun: false });
  res.json(summary);
});

// ── helpers ──────────────────────────────────────────────────────────

function name(c: { firstName: string | null; lastName: string | null } | undefined): string {
  if (!c) return "Unknown";
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown";
}

async function countAtRisk(shopId: string, bufferDays: number, now: Date): Promise<number> {
  return (await buildAtRiskRows(shopId, bufferDays, now)).length;
}

async function buildAtRiskRows(shopId: string, bufferDays: number, now: Date) {
  const db = forShop(shopId);
  const candidates = await db.client.findMany({
    where: {
      optedOut: false,
      phone: { not: null },
      medianIntervalDays: { not: null },
      lastVisitAt: { not: null },
    },
  });

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
    const [completed, upcoming, lastNudge, lastVisit] = await Promise.all([
      db.visit.count({ where: { clientId: c.id, status: "COMPLETED" } }),
      db.visit.findFirst({
        where: { clientId: c.id, status: "SCHEDULED", scheduledAt: { gt: now } },
        select: { id: true },
      }),
      db.nudge.findFirst({
        where: { clientId: c.id, status: { in: ["SENT", "PENDING"] } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      db.visit.findFirst({
        where: { clientId: c.id, status: "COMPLETED" },
        orderBy: { scheduledAt: "desc" },
        select: { serviceName: true },
      }),
    ]);

    const daysSinceLastVisit = c.lastVisitAt ? daysSince(c.lastVisitAt, now) : null;
    const eligible = isNudgeEligible({
      completedVisitCount: completed,
      medianIntervalDays: c.medianIntervalDays,
      daysSinceLastVisit,
      hasUpcomingVisit: Boolean(upcoming),
      daysSinceLastNudge: lastNudge ? daysSince(lastNudge.createdAt, now) : null,
      optedOut: c.optedOut,
      phone: c.phone,
      nudgeBufferDays: bufferDays,
    });
    if (!eligible) continue;

    rows.push({
      id: c.id,
      name: name(c),
      phone: c.phone,
      lastService: lastVisit?.serviceName ?? null,
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
