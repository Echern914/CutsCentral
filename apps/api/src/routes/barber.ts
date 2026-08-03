import { Router } from "express";
import { z } from "zod";
import { forShop, prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireRole } from "../auth/roles.js";

/**
 * The barber-facing API: one chair, nothing else.
 *
 * WHY THIS IS ITS OWN ROUTER, not BARBER being added to the dashboard gates.
 * The existing routers are gated at the ROUTER level precisely so a route
 * added later inherits the restriction instead of being silently wide open
 * (see auth/roles.ts). Opening those gates to BARBER would invert that: every
 * future dashboard route would be exposed to employees by default, and the
 * scoping would have to be remembered per handler forever. Instead the barber
 * surface is a short, explicit allow-list, and everything else stays closed.
 *
 * SCOPING RULE for everything in here: read `req.shopStaffId` (the chair the
 * signed-in seat works) and filter by it. NEVER accept a staffId from the
 * client - that would let any barber read a colleague's book by changing a
 * query param.
 */
export const barberRouter: Router = Router();

// Managers and owners are allowed through so the view is testable from a real
// account and so a working owner can use it as their own chair view; the
// scoping below still applies to whichever chair their seat is linked to.
barberRouter.use(requireUser, requireShop, requireRole("OWNER", "MANAGER", "BARBER"));

const homeQuerySchema = z.object({
  // Client-supplied window so the phone's own midnight decides "today"; the
  // server still narrows to the shop's calendar day below.
  from: z.coerce.date(),
  to: z.coerce.date(),
});

/** Statuses that no longer occupy the chair. */
const CLOSED = new Set(["CANCELED", "NO_SHOW"]);

/**
 * Everything the barber home screen needs, in ONE round trip: who they are,
 * which chair, today's appointments, and their own counts.
 */
barberRouter.get("/home", async (req, res) => {
  const parsed = homeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { from, to } = parsed.data;
  const staffId = req.shopStaffId ?? null;

  // Shop has RLS with no policy, so timezone/name are read as the owner,
  // outside forShop - same rule the agenda handler follows.
  const shop = await prisma.shop.findUnique({
    where: { id: req.shop!.id },
    select: { name: true, timezone: true, bookingMode: true },
  });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // A seat with no chair linked (an office manager, or a barber the owner
  // hasn't pointed at a Staff row yet) has no book to show. Answered as a
  // normal empty payload with a reason, so the UI can say what to fix instead
  // of rendering a blank day that looks broken.
  if (!staffId) {
    res.json({
      chair: null,
      shop: { name: shop.name, timezone: shop.timezone },
      today: [],
      counts: { today: 0, week: 0, month: 0 },
      reason: "no_chair_linked",
    });
    return;
  }

  const db = forShop(req.shop!.id);
  const staff = await db.staff.findFirst({
    where: { id: staffId },
    select: { id: true, name: true },
  });

  const rows = (await db.appointment.findMany({
    where: {
      staffId,
      startsAt: { gte: from, lte: to },
      // AI-receptionist holds aren't real bookings yet; keep them off the book.
      holdExpiresAt: null,
    },
    orderBy: { startsAt: "asc" },
    take: 200,
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      firstName: true,
      lastName: true,
      checkInStatus: true,
      etaMinutes: true,
      runningLate: true,
      priceAtBooking: true,
      service: { select: { name: true, color: true } },
    },
  })) as unknown as {
    id: string;
    status: string;
    startsAt: Date;
    endsAt: Date;
    firstName: string;
    lastName: string | null;
    checkInStatus: string | null;
    etaMinutes: number | null;
    runningLate: boolean | null;
    priceAtBooking: { toString(): string } | null;
    service: { name: string; color: string | null };
  }[];

  // Their own volume, counted on the chair rather than the shop. Three windows
  // in one grouped pass instead of three round trips.
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const completed = (await db.appointment.findMany({
    where: {
      staffId,
      status: "COMPLETED",
      startsAt: { gte: monthAgo, lte: now },
    },
    select: { startsAt: true },
  })) as unknown as { startsAt: Date }[];

  const todayKey = dayKeyIn(shop.timezone, now);
  const counts = {
    today: completed.filter((c) => dayKeyIn(shop.timezone, c.startsAt) === todayKey).length,
    week: completed.filter((c) => c.startsAt >= weekAgo).length,
    month: completed.length,
  };

  // Narrow to the SHOP's calendar day. The caller sends a generous +/-36h window
  // because the shop's timezone isn't known until this response, so the raw rows
  // span three local days - returning them all under a heading that says "Your
  // day" would list tomorrow's 2pm under today. Comparing en-CA ("YYYY-MM-DD")
  // renderings in the shop zone keeps this off the server's own clock, which
  // would roll over at the wrong midnight.
  const todays = rows.filter((r) => dayKeyIn(shop.timezone, r.startsAt) === todayKey);

  res.json({
    chair: staff ? { id: staff.id, name: staff.name } : null,
    shop: { name: shop.name, timezone: shop.timezone },
    today: todays.map((r) => ({
      id: r.id,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      status: r.status,
      closed: CLOSED.has(r.status),
      clientName: [r.firstName, r.lastName].filter(Boolean).join(" ").trim(),
      service: r.service.name,
      color: r.service.color,
      checkInStatus: r.checkInStatus,
      etaMinutes: r.etaMinutes,
      runningLate: Boolean(r.runningLate),
      // Decimal doesn't survive JSON as a number.
      price: r.priceAtBooking?.toString() ?? null,
    })),
    counts,
    reason: null,
  });
});

/** "YYYY-MM-DD" for an instant, in the given zone. */
function dayKeyIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
