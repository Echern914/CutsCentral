import { Router } from "express";
import { z } from "zod";
import { apiEnv, randomToken } from "@chairback/config";
import { prisma, Prisma } from "@chairback/db";
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { computeOpenSlots, isSlotBookable } from "../engines/slots.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "../engines/bookingWrite.js";
import { resolveAddOns } from "../engines/addOns.js";
import {
  durationRangeForService,
  effectiveDurationForDate,
  effectivePriceForDate,
  parseDurationOverrides,
  parsePriceOverrides,
  priceRangeForService,
} from "../engines/pricing.js";
import { connectEnabled, hasActiveAccess } from "../billing/stripe.js";
import { createAheadPaymentIntent, toCents } from "../billing/payments.js";
import { notifyAppointmentConfirmation } from "../services/appointmentNotify.js";
import { sendPushToUser } from "../messaging/push.js";
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
  const [staff, services, links, addOns, targetedSlots] = await Promise.all([
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
        durationOverrides: true,
        price: true,
        priceOverrides: true,
      },
    }),
    prisma.serviceStaff.findMany({
      where: { shopId: shop.id },
      select: { serviceId: true, staffId: true },
    }),
    prisma.serviceAddOn.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, durationMin: true, price: true, serviceId: true },
    }),
    // Barber-published targeted slots: future, active, still unbooked. Shown
    // under their parent service with a badge + THEIR price.
    prisma.targetedSlot.findMany({
      where: {
        shopId: shop.id,
        active: true,
        bookedAppointmentId: null,
        startsAt: { gt: new Date() },
      },
      orderBy: { startsAt: "asc" },
      take: 100,
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        label: true,
        startsAt: true,
        durationMin: true,
        price: true,
      },
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
      // Lapsed shops can't take bookings (the create POST 403s) - tell the UI
      // up front so a customer isn't walked through the whole flow into a
      // dead-end at the final submit.
      bookingPaused: !hasActiveAccess(shop),
      // When on, the booking page offers "Join the waitlist" (a standing button
      // and when a day is fully booked).
      waitlistEnabled: shop.waitlistEnabled,
      // Fee-free pay-direct handles (display-only) so the confirmation screen can
      // show "pay the barber directly". Only surfaced when the barber enabled it.
      payDirect: shop.payDirectEnabled
        ? {
            zelle: shop.payDirectZelle,
            venmo: shop.payDirectVenmo,
            cashApp: shop.payDirectCashApp,
            note: shop.payDirectNote,
          }
        : null,
    },
    staff,
    services: services.map((s) => {
      const base = s.price === null ? null : Number(s.price);
      const overrides = parsePriceOverrides(s.priceOverrides);
      const durOverrides = parseDurationOverrides(s.durationOverrides);
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
        // Same idea for duration ({weekday: minutes}) - the menu can show
        // "20-30 min" and the picker the exact length for the chosen day.
        durationOverrides: durOverrides,
        durationRange: durationRangeForService(s.durationMin, durOverrides),
      };
    }),
    // The (service, staff) offering matrix so the UI can filter either way.
    offerings: links,
    // One-off special slots, listed under their parent service in the picker.
    targetedSlots: targetedSlots.map((t) => ({
      id: t.id,
      staffId: t.staffId,
      serviceId: t.serviceId,
      label: t.label,
      startsAt: t.startsAt.toISOString(),
      durationMin: t.durationMin,
      price: Number(t.price),
    })),
    // Optional add-ons. serviceId null = offered on every service; set = only
    // with that one. The client shows the ones valid for the chosen service.
    addOns: addOns.map((a) => ({
      id: a.id,
      name: a.name,
      durationMin: a.durationMin,
      price: a.price === null ? null : Number(a.price),
      serviceId: a.serviceId,
    })),
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
    // Chosen service add-ons (ids). Invalid/foreign ids are dropped server-side.
    addOnIds: z.array(z.string().min(1)).max(20).optional(),
    // Booking a barber-published TARGETED slot: its id fixes the time, length,
    // and price (validated server-side against the slot row; capacity 1).
    targetedSlotId: z.string().min(1).optional(),
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
    select: {
      id: true,
      durationMin: true,
      durationOverrides: true,
      price: true,
      priceOverrides: true,
      name: true,
    },
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

  // Targeted slot: the barber-published row fixes time/length/price. Validated
  // here; the capacity-1 CLAIM happens inside the booking transaction below.
  let targeted: {
    id: string;
    startsAt: Date;
    durationMin: number;
    price: Prisma.Decimal;
  } | null = null;
  if (d.targetedSlotId) {
    const slot = await prisma.targetedSlot.findFirst({
      where: { id: d.targetedSlotId, shopId: shop.id },
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        startsAt: true,
        durationMin: true,
        price: true,
        active: true,
        bookedAppointmentId: true,
      },
    });
    // Mismatched ids/time = a crafted POST -> 400. A real slot that's gone
    // (booked or deactivated) -> the clean "no longer available" 409.
    if (
      !slot ||
      slot.staffId !== d.staffId ||
      slot.serviceId !== d.serviceId ||
      slot.startsAt.getTime() !== startsAt.getTime()
    ) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }
    if (!slot.active || slot.bookedAppointmentId !== null || startsAt <= now) {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    targeted = slot;
  }

  // Chosen add-ons extend the appointment + total. Invalid/foreign ids drop.
  // A targeted slot has a fixed length/price, so add-ons don't apply (v1).
  const addOns = targeted
    ? { snapshot: [], extraDurationMin: 0, extraPrice: 0 }
    : await resolveAddOns(shop.id, d.serviceId, d.addOnIds);
  // The duration for the DATE the customer picked (weekday override in the shop
  // tz, else base) - a Friday 20-min cut books a 20-min block. endsAt is the
  // duration snapshot: editing the service later never rewrites this row. A
  // targeted slot carries its own explicit length instead.
  const effectiveDuration = targeted
    ? targeted.durationMin
    : effectiveDurationForDate(
        service.durationMin,
        service.durationOverrides,
        startsAt,
        shop.timezone,
      );
  const endsAt = new Date(
    startsAt.getTime() + (effectiveDuration + addOns.extraDurationMin) * 60_000,
  );
  // Snapshot the price for the DATE the customer picked (weekday override in the
  // shop tz, else base) - so a Sunday surcharge is locked in at exactly what the
  // customer was shown, not the base price. Add-on prices are added on top. A
  // targeted slot snapshots ITS price - that's the whole point of the feature.
  const basePrice = targeted
    ? Number(targeted.price)
    : effectivePriceForDate(
        service.price === null ? null : Number(service.price),
        service.priceOverrides,
        startsAt,
        shop.timezone,
      );
  const effectivePrice =
    basePrice === null && addOns.extraPrice === 0
      ? null
      : (basePrice ?? 0) + addOns.extraPrice;
  // Bounds + availability apply to GRID slots only: a targeted slot is explicit
  // barber inventory - deliberately bookable outside the weekly hours and the
  // lead/max window (already validated: future, active, unbooked, exact time).
  if (!targeted) {
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

    // Authoritative availability check: the requested time must be a REAL open
    // slot (inside the staff's hours, not on a blocked exception, honoring the
    // buffer). The browser's slot list is advisory; a crafted POST must not
    // bypass it. The extra add-on duration means the appointment needs a
    // bigger free window.
    if (
      !(await isSlotBookable({
        shopId: shop.id,
        staffId: d.staffId,
        serviceId: d.serviceId,
        startsAt,
        extraDurationMin: addOns.extraDurationMin,
      }))
    ) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }
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
      // Advisory lock + buffer-padded overlap re-check (throws SlotTakenError).
      // Shared with every other Appointment write - see engines/bookingWrite.ts
      // for the full protocol (and the PR #70 timestamp rule it encapsulates).
      await lockStaffAndAssertSlotFree(tx, {
        staffId: d.staffId,
        startsAt,
        endsAt,
        bufferMin: shop.bookingBufferMin,
        // Booking INTO a targeted slot: its own block must not conflict with
        // this claim (any OTHER overlapping targeted slot still does).
        targetedSlotIdToIgnore: targeted?.id,
        now,
      });

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
          // Request-before-booking: land as PENDING (holds the slot, no
          // confirmation) until the barber approves; else confirm immediately.
          status: shop.requireBookingApproval ? "PENDING" : "BOOKED",
          startsAt,
          endsAt,
          priceAtBooking: effectivePrice ?? undefined,
          addOns: addOns.snapshot as unknown as Prisma.InputJsonValue,
          manageToken: token,
          bookedVia: targeted ? "targeted_slot" : undefined,
        },
        select: { id: true, manageToken: true },
      });

      // Capacity-1 claim: only the update that flips bookedAppointmentId from
      // NULL wins. The advisory lock already serialized same-staff racers, so
      // this is the correctness backstop (and covers a concurrent deactivate).
      // count 0 -> the slot was grabbed/killed since validation - roll back and
      // give the loser the same clean "no longer available" as slot_taken.
      if (targeted) {
        const claimed = await tx.targetedSlot.updateMany({
          where: { id: targeted.id, bookedAppointmentId: null, active: true },
          data: { bookedAppointmentId: appt.id },
        });
        if (claimed.count === 0) throw new SlotTakenError();
      }
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
  // booking, which is already durably saved. SKIPPED for an approval-required
  // request - the confirmation fires when the barber APPROVES it, not before.
  if (!shop.requireBookingApproval) {
    void notifyAppointmentConfirmation({ shopId: shop.id, appointmentId });
  }

  // Pay-ahead: create a PaymentIntent for the customer to confirm (card/Apple
  // Pay) and return its client secret. Gated on the shop being in `ahead` mode
  // with a connected, charges-enabled account, Connect configured, and a real
  // price. AFTER commit (no Stripe call inside the booking tx). A failure here
  // never fails the booking — the customer falls back to paying in person.
  let payment: { clientSecret: string } | null = null;
  const amountCents = toCents(effectivePrice);
  if (
    connectEnabled() &&
    // Don't charge a card for a hold that may be declined - pay-ahead is
    // collected on/after approval (or the shop runs approval + pay-in-person).
    !shop.requireBookingApproval &&
    shop.paymentsMode === "ahead" &&
    shop.connectChargesEnabled &&
    shop.stripeConnectAccountId &&
    amountCents !== null
  ) {
    const created = await createAheadPaymentIntent({
      shopId: shop.id,
      appointmentId,
      connectAccountId: shop.stripeConnectAccountId,
      amountCents,
      platformFeeBps: shop.platformFeeBps,
      description: `${service.name} at ${shop.name}`,
    });
    if (created) payment = { clientSecret: created.clientSecret };
  }

  res.status(201).json({
    ok: true,
    manageToken,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    // true = it's a REQUEST awaiting approval (no confirmation yet); the client
    // renders "Request sent" instead of "You're booked".
    pending: shop.requireBookingApproval,
    // When present, the client must confirm payment with the Payment Element.
    payment,
  });
});

// SlotTakenError moved to engines/bookingWrite.ts (shared by every write site).

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
      checkInStatus: true,
      etaMinutes: true,
      runningLate: true,
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

  // The barber's "come early" nudges for THIS appointment, newest first, plus
  // whether the client already sent their one-tap reply. Shown as a banner with
  // "On my way" / "Can't make it early" buttons.
  const nudges =
    appt.status === "BOOKED"
      ? await prisma.nudge.findMany({
          where: {
            appointmentId: appt.id,
            kind: "checkin_nudge",
            status: { in: ["PENDING", "SENT", "FAILED"] },
          },
          orderBy: { createdAt: "desc" },
          take: 2,
          select: { body: true, createdAt: true },
        })
      : [];
  const replied =
    nudges.length === 0
      ? false
      : (await prisma.nudge.count({
          where: { appointmentId: appt.id, kind: "checkin_nudge_reply" },
        })) > 0;

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
    // Check-in ("On my way"): the window is computed HERE so the client needs
    // no timezone math - it just renders the button when open is true. A
    // received nudge opens the window early (the barber ASKED them to come).
    checkin: {
      open: checkInWindowOpen(appt.status, appt.startsAt, now, nudges.length > 0),
      status: appt.checkInStatus,
      etaMinutes: appt.etaMinutes,
      runningLate: appt.runningLate,
    },
    nudges: nudges.map((n) => ({
      body: n.body,
      sentAt: n.createdAt.toISOString(),
    })),
    nudgeReplied: replied,
  });
});

//  Check-in ("On my way") - push-only, never SMS.

/** Tap window: from 60 min before the start until 15 min after (grace). */
const CHECKIN_OPEN_BEFORE_MS = 60 * 60_000;
const CHECKIN_GRACE_AFTER_MS = 15 * 60_000;

/**
 * `nudged` widens the window: a barber "come early" nudge IS an invitation to
 * head over now, so a nudged client may check in any time before the grace
 * cutoff - not just inside the standard 60-min window.
 */
function checkInWindowOpen(
  status: string,
  startsAt: Date,
  now: Date,
  nudged = false,
): boolean {
  if (status !== "BOOKED") return false;
  if (now.getTime() > startsAt.getTime() + CHECKIN_GRACE_AFTER_MS) return false;
  if (nudged) return true;
  return now.getTime() >= startsAt.getTime() - CHECKIN_OPEN_BEFORE_MS;
}

// POST /api/book/manage/:token/checkin - the customer marks themselves en
// route. The manageToken scopes the write to exactly ONE appointment (a foreign
// token 404s like every other manage route), and the handler can only ever
// write 'en_route' - 'arrived' is the barber's dashboard action. One-way: a
// repeat tap may refresh the ETA chips but checkedInAt stays at the FIRST tap
// and there is no un-check-in.
const checkinSchema = z
  .object({
    etaMinutes: z
      .union([z.literal(5), z.literal(10), z.literal(15)])
      .optional(),
    runningLate: z.boolean().optional(),
  })
  .strict();

bookingPublicRouter.post(
  "/manage/:token/checkin",
  leadLimiter,
  async (req, res) => {
    const parsed = checkinSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: {
        id: true,
        shopId: true,
        status: true,
        startsAt: true,
        firstName: true,
        checkInStatus: true,
        checkedInAt: true,
        etaMinutes: true,
        runningLate: true,
        staff: { select: { userId: true } },
        shop: { select: { ownerId: true } },
      },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const now = new Date();
    if (!checkInWindowOpen(appt.status, appt.startsAt, now)) {
      // A barber nudge opens the window early - re-check before rejecting.
      const nudged =
        (await prisma.nudge.count({
          where: { appointmentId: appt.id, kind: "checkin_nudge" },
        })) > 0;
      if (!checkInWindowOpen(appt.status, appt.startsAt, now, nudged)) {
        res.status(409).json({ error: "checkin_window_closed" });
        return;
      }
    }
    // 'arrived' is barber-set and final - the client can't regress it.
    if (appt.checkInStatus === "arrived") {
      res.status(409).json({ error: "already_arrived" });
      return;
    }

    const firstTap = appt.checkInStatus === null;
    const eta = parsed.data.etaMinutes ?? null;
    const late = parsed.data.runningLate ?? false;
    await prisma.appointment.update({
      where: { id: appt.id },
      data: {
        checkInStatus: "en_route",
        // Stamped once, on the first tap; ETA-chip re-taps never move it.
        ...(appt.checkedInAt ? {} : { checkedInAt: now }),
        etaMinutes: eta,
        runningLate: late,
      },
    });

    // Push the barber (the staff's linked user, else the owner) - push ONLY,
    // no SMS leg by design. Fires on the first tap and again when the ETA
    // chips add real information (eta first set / late first flagged); the
    // shared collapse tag makes the update REPLACE the earlier notification
    // instead of stacking a second buzz-per-chip.
    const meaningfulUpdate =
      (appt.etaMinutes === null && eta !== null) ||
      (!appt.runningLate && late);
    if (firstTap || meaningfulUpdate) {
      const body = late
        ? "Running a little late"
        : eta
          ? `About ${eta} min out`
          : "Heads up - they tapped “On my way”";
      await sendPushToUser({
        userId: appt.staff.userId ?? appt.shop.ownerId,
        shopId: appt.shopId,
        payload: {
          title: `${appt.firstName} is on the way`,
          body,
          url: `${apiEnv().APP_BASE_URL}/dashboard/booking`,
          tag: `checkin-${appt.id}`,
        },
      }).catch((err) =>
        logger.error(
          { err, appointmentId: appt.id },
          "check-in barber push failed",
        ),
      );
    }

    res.json({ ok: true, status: "en_route" });
  },
);

// POST /api/book/manage/:token/nudge-reply - the client's one-tap answer to a
// barber "come early" nudge. "On my way" reuses /checkin; this endpoint carries
// the decline ("can't make it early") back to the barber as a push. Only valid
// while a nudge exists, and capped at one reply per nudge received (a spam
// guard - the button is one-tap, so a client could otherwise buzz the barber
// repeatedly).
const nudgeReplySchema = z
  .object({ reply: z.enum(["cant_make_it_early"]) })
  .strict();

bookingPublicRouter.post(
  "/manage/:token/nudge-reply",
  leadLimiter,
  async (req, res) => {
    const parsed = nudgeReplySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: {
        id: true,
        shopId: true,
        status: true,
        firstName: true,
        clientId: true,
        staff: { select: { userId: true } },
        shop: { select: { ownerId: true } },
      },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (appt.status !== "BOOKED") {
      res.status(409).json({ error: "not_active" });
      return;
    }
    const [nudgeCount, replyCount] = await Promise.all([
      prisma.nudge.count({
        where: { appointmentId: appt.id, kind: "checkin_nudge" },
      }),
      prisma.nudge.count({
        where: { appointmentId: appt.id, kind: "checkin_nudge_reply" },
      }),
    ]);
    if (nudgeCount === 0) {
      res.status(409).json({ error: "no_nudge" });
      return;
    }
    if (replyCount >= nudgeCount) {
      res.status(429).json({ error: "already_replied" });
      return;
    }

    const body = `${appt.firstName}: can't make it early`;
    await prisma.nudge.create({
      data: {
        shopId: appt.shopId,
        clientId: appt.clientId!,
        appointmentId: appt.id,
        channel: "WEB_PUSH",
        kind: "checkin_nudge_reply",
        status: "SENT",
        body,
        sentAt: new Date(),
      },
    });
    await sendPushToUser({
      userId: appt.staff.userId ?? appt.shop.ownerId,
      shopId: appt.shopId,
      payload: {
        title: body,
        body: "They'll keep the original time.",
        url: `${apiEnv().APP_BASE_URL}/dashboard/booking`,
        tag: `nudge-reply-${appt.id}`,
      },
    }).catch((err) =>
      logger.error({ err, appointmentId: appt.id }, "nudge reply push failed"),
    );
    res.json({ ok: true });
  },
);

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
    // Customer-initiated: honor the shop's cancellation policy (a fee may apply
    // if they cancel inside the window). A paid booking is refunded accordingly.
    await cancelAppointment(appt.shopId, appt.id, "CANCELED", new Date(), {
      applyPolicyFee: true,
    });
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
        payment: { select: { status: true, amount: true } },
        service: {
          select: {
            durationMin: true,
            durationOverrides: true,
            price: true,
            priceOverrides: true,
          },
        },
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
    // The new date may fall on a different-duration weekday - re-measure, like
    // the reprice below. (Add-on minutes aren't carried through a reschedule
    // today - endsAt was already service-only on this path.)
    const endsAt = new Date(
      startsAt.getTime() +
        effectiveDurationForDate(
          appt.service.durationMin,
          appt.service.durationOverrides,
          startsAt,
          appt.shop.timezone,
        ) *
          60_000,
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

    // If the booking is already PAID and the new date costs a different amount,
    // a self-serve reschedule can't reconcile the captured charge in v1 (no
    // partial capture/top-up here). Block it and point the customer at the shop,
    // rather than silently leaving them over/under-charged.
    const paidAmount =
      appt.payment && appt.payment.status === "succeeded" ? appt.payment.amount : null;
    if (paidAmount !== null) {
      const newCents = toCents(effectivePrice);
      if (newCents !== null && newCents !== paidAmount) {
        res.status(409).json({ error: "price_changed", message: "That day has a different price. Please contact the shop to move a paid booking." });
        return;
      }
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
        // Same shared guard as create, EXCLUDING this appt's own row.
        await lockStaffAndAssertSlotFree(tx, {
          staffId: appt.staffId,
          startsAt,
          endsAt,
          bufferMin: appt.shop.bookingBufferMin,
          excludeAppointmentId: appt.id,
        });
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
