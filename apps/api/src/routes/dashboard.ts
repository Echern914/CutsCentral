import { Router } from "express";
import { z } from "zod";
import { forShop, prisma } from "@chairback/db";
import { NUDGE, randomToken } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { smsLimiter } from "../middleware/rateLimit.js";
import {
  currentBalance,
  grantBonusPunches,
  redeemPunches,
} from "../services/punch.js";
import { loadEligibilityData, sweepShop } from "../engines/nudge.js";
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
  // Atomic check-and-redeem (double-click / two tabs can't redeem twice).
  const result = await redeemPunches(shop.id, client.id, shop.rewardThreshold);
  if (!result.ok) {
    res.status(400).json({ error: "insufficient_punches", balance: result.balance });
    return;
  }
  res.json({ ok: true, newBalance: result.newBalance });
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

// Manually add a client (walk-ins, referrals - no Acuity needed).
const addClientSchema = z
  .object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().max(80).optional(),
    phone: z.string().max(40).optional(),
    email: z.string().email().optional().or(z.literal("")),
    notes: z.string().max(2000).optional(),
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
      action: z.enum(["optOut", "optIn", "nudge"]),
      clientIds: z.array(z.string()).min(1).max(200),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { action, clientIds } = parsed.data;
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

  // Bulk nudge: only eligible (not opted out, has phone). Respects nothing fancy
  // here beyond opt-out/phone; this is a deliberate barber action.
  const clients = await db.client.findMany({
    where: { id: { in: clientIds }, optedOut: false, phone: { not: null } },
  });
  const provider = getMessageProvider();
  let sent = 0;
  let failed = 0;
  for (const client of clients) {
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
      await prisma.nudge.update({
        where: { id: nudge.id },
        data: { status: "SENT", sentAt: new Date(), messageSid: result.sid },
      });
      sent++;
    } catch (err) {
      await prisma.nudge.update({
        where: { id: nudge.id },
        data: { status: "FAILED", failedReason: (err as Error).message },
      });
      failed++;
    }
  }
  res.json({ ok: true, sent, failed, skipped: clientIds.length - clients.length });
});

// Punch ledger detail for one client (earned/redeemed/bonus history).
dashboardRouter.get("/clients/:clientId/ledger", async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const client = await db.client.findFirst({ where: { id: req.params.clientId } });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const entries = await db.punch.findMany({
    where: { clientId: client.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({
    balance: await currentBalance(shop.id, client.id),
    entries: entries.map((e) => ({
      at: e.createdAt.toISOString(),
      earned: e.punchesEarned,
      redeemed: e.punchesRedeemed,
      runningBalance: e.runningBalance,
      note: e.note,
    })),
  });
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

// Run a dry-run sweep preview (who WOULD be nudged) without sending.
dashboardRouter.post("/sweep-preview", smsLimiter, async (req, res) => {
  const summary = await sweepShop(req.shop!, { dryRun: true });
  res.json(summary);
});

// Run the real sweep now - texts every eligible client (respects daily cap).
dashboardRouter.post("/sweep", smsLimiter, async (req, res) => {
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
  const candidates = await db.client.findMany({
    where: {
      optedOut: false,
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
