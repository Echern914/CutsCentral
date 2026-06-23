import { Router } from "express";
import { z } from "zod";
import { randomToken } from "@chairback/config";
import { prisma, Prisma } from "@chairback/db";
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { computeOpenSlots, isSlotBookable } from "../engines/slots.js";
import {
  effectivePriceForDate,
  parsePriceOverrides,
  priceRangeForService,
} from "../engines/pricing.js";
import { hasActiveAccess } from "../billing/stripe.js";
import { notifyAppointmentConfirmation } from "../services/appointmentNotify.js";
import { cancelAppointment } from "../engines/appointmentPromotion.js";
import { rewardsLimiter, leadLimiter } from "../middleware/rateLimit.js";
import { logger } from "../logger.js";

/**
 * PUBLIC native booking API. UNauthenticated - the slug resolves the shop and a
 * manageToken authorizes cancel/reschedule (no login), the same trust model as
 * the rewards (magicToken) and lead/review (slug) routes.
 *
 * Every shop read/insert uses plain `prisma` (the connection owner), which
 * bypasses FORCE RLS - exactly like the appointment-request / review writes. The
 * barber reads/manages these through forShop() (RLS-enforced) in the dashboard
 * router. The booking insert is a single transaction with an overlap row-lock;
 * the partial unique (staffId, startsAt) WHERE status='BOOKED' is the backstop.
 *
 * A 404 is returned for any shop that isn't live + native (no oracle).
 */
export const bookingPublicRouter: Router = Router();

// z.coerce.date() turns an unparseable string into an Invalid Date that still
// passes instanceof checks (its getTime() is NaN, which then slips through
// numeric bound comparisons). Refine to a real date so bad input is a clean 400.
const validDate = z.coerce.date().refine((dt) => !Number.isNaN(dt.getTime()), {
  message: "Invalid date.",
});

/** Resolve a live, native-booking shop by slug, or null. */
async function resolveNativeShop(slugRaw: string | undefined) {
  const slug = String(slugRaw).toLowerCase();
  const shop = await prisma.shop.findUnique({ where: { slug } });
  if (!shop || !shop.publicPageEnabled || shop.bookingMode !== "native") {
    return null;
  }
  return shop;
}

// GET /api/book/:slug - shop meta + active staff + active services.
bookingPublicRouter.get("/:slug", rewardsLimiter, async (req, res) => {
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [staff, services, links] = await Promise.all([
    prisma.staff.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, bio: true, imageUrl: true },
    }),
    prisma.service.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        durationMin: true,
        price: true,
        priceOverrides: true,
      },
    }),
    prisma.serviceStaff.findMany({
      where: { shopId: shop.id },
      select: { serviceId: true, staffId: true },
    }),
  ]);
  res.json({
    shop: {
      name: shop.name,
      slug: shop.slug,
      timezone: shop.timezone,
      logoUrl: shop.logoUrl,
      accentColor: shop.accentColor,
      bookingLeadHours: shop.bookingLeadHours,
      bookingMaxDays: shop.bookingMaxDays,
    },
    staff,
    services: services.map((s) => {
      const base = s.price === null ? null : Number(s.price);
      const overrides = parsePriceOverrides(s.priceOverrides);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        durationMin: s.durationMin,
        price: base,
        // Per-weekday overrides ({weekday: price}); the client computes the exact
        // price for the day the customer picks (in the shop tz). priceRange lets
        // the menu show "from $X" / "$45-$55" before a day is chosen.
        priceOverrides: overrides,
        priceRange: priceRangeForService(base, overrides),
      };
    }),
    // The (service, staff) offering matrix so the UI can filter either way.
    offerings: links,
  });
});

// GET /api/book/:slug/slots?staffId=&serviceId=&from=&to= - open slots.
const slotsQuerySchema = z.object({
  staffId: z.string().min(1),
  serviceId: z.string().min(1),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

bookingPublicRouter.get("/:slug/slots", rewardsLimiter, async (req, res) => {
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = slotsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const now = new Date();
  const from = parsed.data.from ?? now;
  // Default to the shop's max horizon when `to` is omitted.
  const to =
    parsed.data.to ??
    new Date(now.getTime() + shop.bookingMaxDays * 24 * 60 * 60 * 1000);
  const slots = await computeOpenSlots({
    shopId: shop.id,
    staffId: parsed.data.staffId,
    serviceId: parsed.data.serviceId,
    fromDate: from,
    toDate: to,
    now,
  });
  res.json({
    timezone: shop.timezone,
    slots: slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    })),
  });
});

// POST /api/book/:slug - create a booking. Tighter (lead) limiter: anti-spam.
const createSchema = z
  .object({
    staffId: z.string().min(1),
    serviceId: z.string().min(1),
    startsAt: validDate,
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80).optional().or(z.literal("")),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    email: z.string().trim().email().max(200).optional().or(z.literal("")),
    smsConsent: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Boolean(d.phone?.trim()) || Boolean(d.email?.trim()), {
    message: "Provide a phone or email.",
    path: ["phone"],
  });

bookingPublicRouter.post("/:slug", leadLimiter, async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // SMS costs money - a shop without active access can't take native bookings.
  if (!hasActiveAccess(shop)) {
    res.status(403).json({ error: "no_active_access" });
    return;
  }
  const d = parsed.data;
  const phone = toE164(d.phone);
  // A non-empty but unparseable phone is a typo - refuse (same as the dashboard).
  if (d.phone?.trim() && !phone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  // Validate staff offers an active service, compute the end time, bounds-check.
  const service = await prisma.service.findFirst({
    where: { id: d.serviceId, shopId: shop.id, active: true },
    select: { id: true, durationMin: true, price: true, priceOverrides: true, name: true },
  });
  const offering = await prisma.serviceStaff.findFirst({
    where: { shopId: shop.id, serviceId: d.serviceId, staffId: d.staffId },
    select: { id: true },
  });
  const staff = await prisma.staff.findFirst({
    where: { id: d.staffId, shopId: shop.id, active: true },
    select: { id: true },
  });
  if (!service || !offering || !staff) {
    res.status(400).json({ error: "invalid_slot" });
    return;
  }

  const now = new Date();
  const startsAt = d.startsAt;
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  // Snapshot the price for the DATE the customer picked (weekday override in the
  // shop tz, else base) - so a Sunday surcharge is locked in at exactly what the
  // customer was shown, not the base price.
  const effectivePrice = effectivePriceForDate(
    service.price === null ? null : Number(service.price),
    service.priceOverrides,
    startsAt,
    shop.timezone,
  );
  const earliest = now.getTime() + shop.bookingLeadHours * 60 * 60_000;
  const latest = now.getTime() + shop.bookingMaxDays * 24 * 60 * 60_000;
  if (startsAt.getTime() < earliest) {
    res.status(400).json({ error: "too_soon" });
    return;
  }
  if (startsAt.getTime() > latest) {
    res.status(400).json({ error: "too_far" });
    return;
  }

  // Authoritative availability check: the requested time must be a REAL open slot
  // (inside the staff's hours, not on a blocked exception, honoring the buffer).
  // The browser's slot list is advisory; a crafted POST must not bypass it.
  if (!(await isSlotBookable({ shopId: shop.id, staffId: d.staffId, serviceId: d.serviceId, startsAt }))) {
    res.status(400).json({ error: "invalid_slot" });
    return;
  }

  const consented = d.smsConsent === true && Boolean(phone);
  const acuityClientKey = deriveAcuityClientKey({
    phone: d.phone,
    email: d.email,
    firstName: d.firstName,
    lastName: d.lastName,
  });

  let appointmentId: string;
  let manageToken: string;
  try {
    // One transaction as the connection owner (NO runWithShop - the public route
    // has no shop context). Availability was validated above; here the advisory
    // lock + overlap check guard against concurrent conflicts, and the partial
    // unique is the final backstop on an identical-start race.
    const result = await prisma.$transaction(async (tx) => {
      // Serialize ALL concurrent grabs on this staff's calendar. A bare overlap
      // SELECT ... FOR UPDATE locks nothing when the slot is free, so two
      // overlapping-but-different-start bookings could both pass; an advisory
      // xact lock keyed on the staff id closes that race (released on commit).
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`appt:${d.staffId}`}))`,
      );
      // Now no other booking for this staff can interleave: re-check overlap,
      // padding existing appointments by the shop's turnover buffer so back-to-
      // back bookings keep the required gap (the availability check ignores
      // bookings, so the buffer is enforced HERE).
      const bufferMs = Math.max(0, shop.bookingBufferMin) * 60_000;
      const overlapStart = new Date(startsAt.getTime() - bufferMs);
      const overlapEnd = new Date(endsAt.getTime() + bufferMs);
      const overlap = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "Appointment"
                   WHERE "staffId" = ${d.staffId}
                     AND "status" = 'BOOKED'
                     AND "startsAt" < ${overlapEnd}
                     AND "endsAt" > ${overlapStart}`,
      );
      if (overlap.length > 0) {
        throw new SlotTakenError();
      }

      // Upsert the client (tenant-scoped key). Stamp consent only when none is
      // recorded yet (first consent wins - never overwrite an earlier source).
      const client = await tx.client.upsert({
        where: {
          shopId_acuityClientKey: { shopId: shop.id, acuityClientKey },
        },
        create: {
          shopId: shop.id,
          acuityClientKey,
          magicToken: randomToken(),
          firstName: d.firstName,
          lastName: d.lastName || null,
          phone,
          email: d.email || null,
          source: "manual",
          smsConsentAt: consented ? now : null,
          smsConsentSource: consented ? "booking" : null,
        },
        update: {
          firstName: d.firstName,
          lastName: d.lastName || undefined,
          phone: phone ?? undefined,
          email: d.email || undefined,
        },
        select: { id: true },
      });
      if (consented) {
        await tx.client.updateMany({
          where: { id: client.id, smsConsentAt: null },
          data: { smsConsentAt: now, smsConsentSource: "booking" },
        });
      }

      const token = randomToken();
      const appt = await tx.appointment.create({
        data: {
          shopId: shop.id,
          staffId: d.staffId,
          serviceId: d.serviceId,
          clientId: client.id,
          firstName: d.firstName,
          lastName: d.lastName || null,
          phone,
          email: d.email || null,
          status: "BOOKED",
          startsAt,
          endsAt,
          priceAtBooking: effectivePrice ?? undefined,
          manageToken: token,
        },
        select: { id: true, manageToken: true },
      });
      return appt;
    });
    appointmentId = result.id;
    manageToken = result.manageToken;
  } catch (err) {
    if (err instanceof SlotTakenError) {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    // P2002 = the partial-unique backstop fired on an identical-start race.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    logger.error({ err, shopId: shop.id }, "native booking create failed");
    res.status(500).json({ error: "create_failed" });
    return;
  }

  // Confirmation SMS after commit (gated by consent/quiet-hours/billing inside
  // notify; honors DRY_RUN). Fire-and-forget: a send issue must not fail the
  // booking, which is already durably saved.
  void notifyAppointmentConfirmation({ shopId: shop.id, appointmentId });

  res.status(201).json({
    ok: true,
    manageToken,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  });
});

/** Thrown inside the booking tx to roll back + map to a 409. */
class SlotTakenError extends Error {}

//  Manage by token (cancel / reschedule) - the token IS the authorization.

bookingPublicRouter.get("/manage/:token", rewardsLimiter, async (req, res) => {
  const appt = await prisma.appointment.findUnique({
    where: { manageToken: String(req.params.token) },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      firstName: true,
      shop: { select: { name: true, timezone: true, slug: true } },
      service: { select: { name: true, durationMin: true } },
      staff: { select: { name: true } },
    },
  });
  if (!appt) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const now = new Date();
  const canChange = appt.status === "BOOKED" && appt.startsAt > now;
  res.json({
    status: appt.status,
    firstName: appt.firstName,
    startsAt: appt.startsAt.toISOString(),
    endsAt: appt.endsAt.toISOString(),
    shop: appt.shop,
    service: appt.service,
    staff: appt.staff,
    canCancel: canChange,
    canReschedule: canChange,
  });
});

// POST /api/book/manage/:token/cancel - the customer cancels their own booking.
bookingPublicRouter.post(
  "/manage/:token/cancel",
  leadLimiter,
  async (req, res) => {
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: { id: true, shopId: true, status: true, startsAt: true },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (appt.status !== "BOOKED" || appt.startsAt <= new Date()) {
      res.status(409).json({ error: "not_cancelable" });
      return;
    }
    await cancelAppointment(appt.shopId, appt.id, "CANCELED");
    res.json({ ok: true });
  },
);

// POST /api/book/manage/:token/reschedule - move a booking to a new open slot.
const rescheduleSchema = z.object({ startsAt: validDate }).strict();

bookingPublicRouter.post(
  "/manage/:token/reschedule",
  leadLimiter,
  async (req, res) => {
    const parsed = rescheduleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: {
        id: true,
        shopId: true,
        staffId: true,
        serviceId: true,
        status: true,
        startsAt: true,
        service: { select: { durationMin: true, price: true, priceOverrides: true } },
        shop: {
          select: {
            timezone: true,
            bookingLeadHours: true,
            bookingMaxDays: true,
            bookingBufferMin: true,
            bookingMode: true,
            publicPageEnabled: true,
            subscriptionStatus: true,
            trialEndsAt: true,
            compAccess: true,
          },
        },
      },
    });
    if (!appt || appt.shop.bookingMode !== "native" || !appt.shop.publicPageEnabled) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // A lapsed shop can't churn its calendar either (mirror the create gate).
    if (!hasActiveAccess(appt.shop)) {
      res.status(403).json({ error: "no_active_access" });
      return;
    }
    if (appt.status !== "BOOKED" || appt.startsAt <= new Date()) {
      res.status(409).json({ error: "not_reschedulable" });
      return;
    }

    const now = new Date();
    const startsAt = parsed.data.startsAt;
    const endsAt = new Date(
      startsAt.getTime() + appt.service.durationMin * 60_000,
    );
    // The new date may fall on a different-priced weekday - reprice to match.
    const effectivePrice = effectivePriceForDate(
      appt.service.price === null ? null : Number(appt.service.price),
      appt.service.priceOverrides,
      startsAt,
      appt.shop.timezone,
    );
    const earliest = now.getTime() + appt.shop.bookingLeadHours * 60 * 60_000;
    const latest = now.getTime() + appt.shop.bookingMaxDays * 24 * 60 * 60_000;
    if (startsAt.getTime() < earliest) {
      res.status(400).json({ error: "too_soon" });
      return;
    }
    if (startsAt.getTime() > latest) {
      res.status(400).json({ error: "too_far" });
      return;
    }

    // Re-validate the new time against availability (excluding this appointment's
    // own current slot), same authoritative check as create.
    if (
      !(await isSlotBookable({
        shopId: appt.shopId,
        staffId: appt.staffId,
        serviceId: appt.serviceId,
        startsAt,
        excludeAppointmentId: appt.id,
      }))
    ) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Advisory xact lock serializes concurrent grabs on this staff calendar
        // (a bare overlap SELECT locks nothing when the target slot is free).
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`appt:${appt.staffId}`}))`,
        );
        // Same overlap guard as create (buffer-padded), EXCLUDING this appt.
        const bufferMs = Math.max(0, appt.shop.bookingBufferMin) * 60_000;
        const overlapStart = new Date(startsAt.getTime() - bufferMs);
        const overlapEnd = new Date(endsAt.getTime() + bufferMs);
        const overlap = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT id FROM "Appointment"
                     WHERE "staffId" = ${appt.staffId}
                       AND "status" = 'BOOKED'
                       AND "id" <> ${appt.id}
                       AND "startsAt" < ${overlapEnd}
                       AND "endsAt" > ${overlapStart}`,
        );
        if (overlap.length > 0) throw new SlotTakenError();
        // Move it, reprice for the new date, and reset send-state so a fresh
        // confirmation/reminder go out.
        await tx.appointment.update({
          where: { id: appt.id },
          data: {
            startsAt,
            endsAt,
            priceAtBooking: effectivePrice ?? null,
            confirmationSentAt: null,
            reminderSentAt: null,
          },
        });
      });
    } catch (err) {
      if (
        err instanceof SlotTakenError ||
        (err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002")
      ) {
        res.status(409).json({ error: "slot_taken" });
        return;
      }
      logger.error({ err, appointmentId: appt.id }, "reschedule failed");
      res.status(500).json({ error: "reschedule_failed" });
      return;
    }

    void notifyAppointmentConfirmation({
      shopId: appt.shopId,
      appointmentId: appt.id,
    });
    res.json({ ok: true, startsAt: startsAt.toISOString() });
  },
);
