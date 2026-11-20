import { Router } from "express";
import { z } from "zod";
import { forShop, prisma } from "@chairback/db";
import { registerUserDevice } from "../services/userDevice.js";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireRole } from "../auth/roles.js";
import { dayKeyIn, readChairDay } from "../services/chairDay.js";

import { requireActiveAccess } from "../middleware/billing.js";
import { noteForBarber } from "../engines/bookingIntake.js";
import { shopDayKey } from "../services/barberNotify.js";
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
barberRouter.use(requireUser, requireShop, requireRole("OWNER", "MANAGER", "BARBER"), requireActiveAccess);

const homeQuerySchema = z.object({
  // Client-supplied window so the phone's own midnight decides "today"; the
  // server still narrows to the shop's calendar day below.
  from: z.coerce.date(),
  to: z.coerce.date(),
});

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

  // Their own volume, counted on the chair rather than the shop. Three windows
  // in one grouped pass instead of three round trips.
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const completed = (await db.appointment.findMany({
    where: {
      staffId,
      startsAt: { gte: monthAgo, lte: now },
      // A cut that ENDED counts the day it happened, as it did when the sweep
      // completed it 15 minutes later. It now waits a day after the end
      // (NO_SHOW_WINDOW_MS) so a no-show can still be marked; until then an
      // ended, unsettled booking is still BOOKED. A no-show marked in that
      // day leaves the count.
      OR: [{ status: "COMPLETED" }, { status: "BOOKED", endsAt: { lte: now } }],
    },
    select: { startsAt: true },
  })) as unknown as { startsAt: Date }[];

  const todayKey = dayKeyIn(shop.timezone, now);
  const counts = {
    today: completed.filter((c) => dayKeyIn(shop.timezone, c.startsAt) === todayKey).length,
    week: completed.filter((c) => c.startsAt >= weekAgo).length,
    month: completed.length,
  };

  // The caller sends a generous +/-36h window because the shop's timezone isn't
  // known until this response; the shared reader narrows it to the shop's own
  // calendar day (services/chairDay.ts), the same read the day view uses.
  const today = await readChairDay({
    shopId: req.shop!.id,
    staffId,
    timezone: shop.timezone,
    from,
    to,
    day: todayKey,
  });

  res.json({
    chair: staff ? { id: staff.id, name: staff.name } : null,
    shop: { name: shop.name, timezone: shop.timezone },
    today,
    counts,
    reason: null,
  });
});

/**
 * Native push-device registration for the SEAT ITSELF - the twin of the
 * manager-gated /api/dashboard/push/native, mounted here because that gate
 * made a BARBER seat structurally unable to register a device (the one
 * personal readiness task that was impossible). Same handler contract:
 * userId/shopId come from the session, upsert by token (services/userDevice.ts,
 * which also refuses a session signed out mid-request), owner-scoped because
 * a re-registering user's row may carry another of their shops' shopId.
 * The manager route stays exactly as it was - never open that gate.
 */
const barberPushSchema = z
  .object({
    expoPushToken: z.string().min(10).max(4096),
    platform: z.string().max(40).optional(),
  })
  .strict();

barberRouter.post("/push/native", async (req, res) => {
  const parsed = barberPushSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { expoPushToken, platform } = parsed.data;
  const registered = await registerUserDevice({
    userId: req.userId!,
    sessionVersion: req.sessionVersion!,
    shopId: req.shop!.id,
    expoPushToken,
    platform: platform ?? null,
  });
  if (!registered) {
    // Signed out while this was in flight: the device stays unregistered.
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({ ok: true });
});

/** How far ahead the bell looks for notes: the rest of a working day. */
const NOTES_AHEAD_MS = 12 * 60 * 60 * 1000;
/** A client who is a few minutes late is still about to walk in. */
const NOTES_GRACE_MS = 15 * 60 * 1000;

/**
 * GET /api/barber/notes-ahead - the appointments coming up in the next 12
 * hours that carry a note, with the note: what the client wrote when they
 * booked, and the note on the booking. The dashboard bell shows them so the
 * barber reads what was asked for BEFORE the client walks in (X and Drick,
 * 2026-10-16), not after opening each appointment.
 *
 * WHOSE: the same people the Next up alert goes to (engines/barberReminders):
 * the chair this seat works, and for the OWNER also every chair nobody's
 * login is linked to - an owner's own chair made at setup is one of those.
 * Never a colleague's chair: their clients' words are theirs.
 */
barberRouter.get("/notes-ahead", async (req, res) => {
  const shopId = req.shop!.id;
  const isOwner = req.shopRole === "OWNER";
  const staffId = req.shopStaffId ?? null;
  if (!isOwner && !staffId) {
    res.json({ items: [] });
    return;
  }
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { timezone: true } });
  const tz = shop?.timezone ?? "America/New_York";
  const now = Date.now();
  // 🔴 Built without an `undefined` anywhere: `{ staffId: undefined }` is NO
  // filter to Prisma, and inside this OR it would hand an owner every chair.
  const chairs = isOwner
    ? {
        OR: [
          ...(staffId ? [{ staffId }] : []),
          { staff: { userId: null } },
          { staff: { userId: req.userId! } },
        ],
      }
    : { staffId: staffId! };
  const rows = (await forShop(shopId).appointment.findMany({
    where: {
      status: "BOOKED",
      holdExpiresAt: null,
      startsAt: { gt: new Date(now - NOTES_GRACE_MS), lte: new Date(now + NOTES_AHEAD_MS) },
      ...chairs,
    },
    orderBy: { startsAt: "asc" },
    take: 100,
    select: { id: true, startsAt: true, firstName: true, lastName: true, intake: true, notes: true },
  })) as unknown as {
    id: string;
    startsAt: Date;
    firstName: string;
    lastName: string | null;
    intake: unknown;
    notes: string | null;
  }[];
  const items = rows.flatMap((a) => {
    const note = noteForBarber(a);
    if (!note) return [];
    return [
      {
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        clientName: [a.firstName, a.lastName].filter(Boolean).join(" ").trim() || "A client",
        clientWrote: note.clientWrote,
        bookingNote: note.bookingNote,
        // The appointment itself, on its day, where the whole note is.
        href: `/dashboard/booking?tab=Appointments&appointment=${encodeURIComponent(a.id)}&day=${shopDayKey(a.startsAt, tz)}`,
      },
    ];
  });
  res.json({ items: items.slice(0, 20), timezone: tz });
});
