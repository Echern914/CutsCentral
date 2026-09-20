import { Router } from "express";
import { z } from "zod";
import { Prisma, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { hasActiveAccess, connectEnabled } from "../billing/stripe.js";
import { collectsAtBooking } from "../services/appointmentPaymentHold.js";
import {
  GroupPlanError,
  MAX_GROUP_ATTENDEES,
  groupExtraDurationMin,
  planGroupSequence,
  serviceOfferedDuring,
  type GroupPlan,
  type GroupPlanService,
} from "../engines/appointmentGroup.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "../engines/bookingWrite.js";
import { cancelGroup } from "../engines/appointmentPromotion.js";
import {
  MirrorNotConfiguredError,
  dispatchCreateEach,
  recordMirrorIntent,
} from "../engines/acuityMirror.js";
import {
  compensateGroup,
  sendGroupConfirmationOnce,
} from "../engines/appointmentGroupSettle.js";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import { computeOpenSlots, isSlotBookable } from "../engines/slots.js";
import { bookingReadLimiter, bookingWriteLimiter, rewardsLimiter } from "../middleware/rateLimit.js";
import { logger } from "../logger.js";

/**
 * Back-to-back group booking: "me and my brother, one after the other".
 *
 * Its own router rather than more of booking.public.ts, which is already ~3900
 * lines. Nothing here is a second booking system: the availability check, the
 * double-booking guard and the row shape are the SAME ones a single booking
 * uses - what is new is that several appointments commit together or not at all.
 *
 * 🔴 PAY AT THE SHOP ONLY, in v1, and refused loudly otherwise. Collecting for
 * a group is one payment covering several appointments, which raises questions
 * this PR does not answer: what a deposit means when one attendee later cancels,
 * and what gets refunded to whom. Standing appointments drew the same line for
 * the same reason (recurring series are pay-at-chair only). A shop that takes
 * money at booking gets a clear refusal, never a group that quietly skipped
 * the deposit every single booking pays.
 */
export const bookingGroupRouter: Router = Router();

const attendeeSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  serviceId: z.string().min(1).max(64),
});

const createSchema = z
  .object({
    staffId: z.string().min(1).max(64),
    startsAt: z.coerce.date(),
    attendees: z.array(attendeeSchema).min(1).max(MAX_GROUP_ATTENDEES),
    /** The booker - the ONE person messaged for the whole group. */
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(32).optional(),
    email: z.string().trim().max(200).optional(),
    smsConsent: z.boolean().optional(),
    /**
     * 🔴 Supplied by the CLIENT and unique per submission. A group create is
     * several appointments in one transaction; a retry of a request whose
     * response never arrived must return the SAME group, not a second set of
     * chairs. See the unique index on AppointmentGroup.idempotencyKey.
     */
    idempotencyKey: z.string().trim().min(8).max(100).optional(),
  })
  .strict();

const planSchema = z
  .object({
    staffId: z.string().min(1).max(64),
    startsAt: z.coerce.date(),
    attendees: z.array(attendeeSchema).min(1).max(MAX_GROUP_ATTENDEES),
  })
  .strict();

async function resolveNativeShop(slugRaw: string | undefined) {
  const slug = String(slugRaw).toLowerCase();
  const shop = await prisma.shop.findUnique({ where: { slug } });
  if (!shop || !shop.publicPageEnabled || shop.bookingMode !== "native") return null;
  return shop;
}

/** The services the attendees chose, but only ones THIS staff actually offers. */
async function loadGroupServices(
  shopId: string,
  staffId: string,
  serviceIds: string[],
): Promise<Map<string, GroupPlanService & { name: string; hoursWindows: unknown }> | null> {
  const unique = [...new Set(serviceIds)];
  const services = await prisma.service.findMany({
    where: { id: { in: unique }, shopId, active: true },
    select: {
      id: true,
      name: true,
      durationMin: true,
      price: true,
      durationOverrides: true,
      priceOverrides: true,
      dateOverrides: true,
      timeOverrides: true,
      hoursWindows: true,
    },
  });
  if (services.length !== unique.length) return null;
  // 🔴 Every service must be one this BARBER offers. Without this a group could
  // pair a service the barber does not do with one they do, and the single
  // booking path's own serviceStaff check would never see it.
  const offerings = await prisma.serviceStaff.findMany({
    where: { shopId, staffId, serviceId: { in: unique } },
    select: { serviceId: true },
  });
  if (offerings.length !== unique.length) return null;
  return new Map(services.map((s) => [s.id, s]));
}

/** Refuse a group when the shop would take money at booking. See the header. */
function collectsMoneyAtBooking(shop: {
  paymentsMode: string;
  requireBookingApproval: boolean;
  connectChargesEnabled: boolean;
  stripeConnectAccountId: string | null;
}): boolean {
  return (
    collectsAtBooking({
      connectEnabled: connectEnabled(),
      paymentsMode: shop.paymentsMode,
      requireBookingApproval: shop.requireBookingApproval,
      connectChargesEnabled: shop.connectChargesEnabled,
      stripeConnectAccountId: shop.stripeConnectAccountId,
      chargeCents: 1,
    }) !== null
  );
}

/** The wire shape of a plan - times as ISO, money in cents. */
function planPayload(plan: GroupPlan) {
  return {
    startsAt: plan.startsAt.toISOString(),
    endsAt: plan.endsAt.toISOString(),
    totalDurationMin: plan.totalDurationMin,
    totalPriceCents: plan.totalPriceCents,
    // So the page can say "plus one service priced in shop" rather than
    // presenting a total that quietly treats an unpriced service as free.
    unpricedCount: plan.unpricedCount,
    members: plan.members.map((m) => ({
      position: m.position,
      firstName: m.firstName,
      serviceId: m.serviceId,
      serviceName: m.serviceName,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt.toISOString(),
      durationMin: m.durationMin,
      priceCents: m.priceCents,
    })),
  };
}

/**
 * Everything that must be true before a group may be written, short of the
 * transaction itself. Shared by the plan endpoint (which shows the customer the
 * sequence and the total) and the create endpoint (which must re-check it),
 * so the page and the writer cannot disagree about what is bookable.
 */
type PreflightFailure =
  | { code: "invalid_slot"; status: 400 }
  | { code: "group_payments_unsupported"; status: 409 }
  | { code: "service_not_offered_then"; status: 400; position: number };

async function preflight(
  shop: {
    id: string;
    timezone: string;
    paymentsMode: string;
    requireBookingApproval: boolean;
    connectChargesEnabled: boolean;
    stripeConnectAccountId: string | null;
  },
  input: { staffId: string; startsAt: Date; attendees: { firstName: string; serviceId: string }[] },
  opts: { now: Date; requirePayable: boolean },
): Promise<{ ok: true; plan: GroupPlan } | { ok: false; failure: PreflightFailure }> {
  const staff = await prisma.staff.findFirst({
    where: { id: input.staffId, shopId: shop.id, active: true },
    select: { id: true },
  });
  if (!staff) return { ok: false, failure: { code: "invalid_slot", status: 400 } };

  const services = await loadGroupServices(
    shop.id,
    input.staffId,
    input.attendees.map((a) => a.serviceId),
  );
  if (!services) return { ok: false, failure: { code: "invalid_slot", status: 400 } };

  let plan: GroupPlan;
  try {
    plan = planGroupSequence({
      attendees: input.attendees,
      startsAt: input.startsAt,
      timezone: shop.timezone,
      services,
    });
  } catch (err) {
    if (err instanceof GroupPlanError) {
      return { ok: false, failure: { code: "invalid_slot", status: 400 } };
    }
    throw err;
  }

  if (opts.requirePayable && collectsMoneyAtBooking(shop)) {
    return { ok: false, failure: { code: "group_payments_unsupported", status: 409 } };
  }

  // 1. The WHOLE RUN must fit, on the first member's grid widened by the rest.
  //    This is the hours / lead-time / bounds / uninterrupted-barber question.
  const first = plan.members[0]!;
  const bookable = await isSlotBookable({
    shopId: shop.id,
    staffId: input.staffId,
    serviceId: first.serviceId,
    startsAt: plan.startsAt,
    extraDurationMin: groupExtraDurationMin(plan),
    now: opts.now,
  });
  if (!bookable) return { ok: false, failure: { code: "invalid_slot", status: 400 } };

  // 2. Each LATER member's own service must be offered across its own span.
  //    The check above cannot answer this, and isSlotBookable cannot either -
  //    member 2's start is generally off member 2's own grid. See the engine.
  for (const m of plan.members.slice(1)) {
    const svc = services.get(m.serviceId)!;
    if (
      !serviceOfferedDuring({
        hoursWindows: svc.hoursWindows,
        timeOverrides: svc.timeOverrides,
        startsAt: m.startsAt,
        endsAt: m.endsAt,
        timezone: shop.timezone,
      })
    ) {
      return {
        ok: false,
        failure: { code: "service_not_offered_then", status: 400, position: m.position },
      };
    }
  }

  return { ok: true, plan };
}

/**
 * 🔴 THE GRID MUST BE SIZED FOR THE WHOLE PARTY, NOT FOR ONE HAIRCUT.
 *
 * `/plan` takes a start time as an INPUT - it validates one candidate. Nothing
 * enumerated candidates, and neither existing availability endpoint can express
 * a combined run: `/slug/slots` takes a single serviceId and no extra duration,
 * `/slug/day` takes only a date. A picker built on those offers times sized for
 * ONE service, the customer taps 2:30, and the write refuses it - the grid
 * disagreeing with the writer, which is the outage class #344 was about.
 *
 * So: the same pairing the writer already uses, exposed for reading. Nothing
 * here is new logic - `preflight` calls exactly this on line ~230.
 *
 * 🔴 NOTHING ABOUT DURATION COMES FROM THE BROWSER. The query names services
 * BY ID; every duration and price is resolved server-side from this shop's own
 * rows. A client that could post `extraDurationMin` could book a three-person
 * run into a one-person hole.
 *
 * 🔴 AND THE IDS ARE NOT DEDUPLICATED. Two siblings can want the same cut, and
 * that service's duration has to count TWICE. `loadGroupServices` dedupes its
 * database LOOKUP (an optimisation), but the plan is built by walking the
 * attendee list in order, so a repeated id is planned once per attendee.
 *
 * Read-only: no row is written and Acuity is never contacted.
 */
const groupSlotsQuerySchema = z.object({
  staffId: z.string().min(1).max(64),
  /**
   * In ATTENDEE ORDER, repeats allowed. Order matters because each duration is
   * resolved at its own start, so "30 then 20" and "20 then 30" can end at
   * different times once a weekday override is in play.
   */
  serviceIds: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean)),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Placeholder attendee names. The planner requires one; slots never show it. */
const SLOT_PLACEHOLDER_NAMES = ["A", "B", "C"];

bookingGroupRouter.get("/:slug/group/slots", bookingReadLimiter, async (req, res) => {
  const parsed = groupSlotsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const serviceIds = parsed.data.serviceIds;
  // A party, not a single booking. One id would be an ordinary /slots query and
  // must not be answered here, or the two grids could drift apart.
  if (serviceIds.length < 2 || serviceIds.length > MAX_GROUP_ATTENDEES) {
    res.status(400).json({ error: "invalid_input", code: "GROUP_SIZE" });
    return;
  }

  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!hasActiveAccess(shop)) {
    res.status(403).json({ error: "no_active_access", code: "BOOKING_UNAVAILABLE" });
    return;
  }
  // The same refusal /plan and /create give. Offering times for a shop that
  // cannot take a group booking would be a picker leading to a dead end.
  if (collectsMoneyAtBooking(shop)) {
    res.status(409).json({ error: "group_payments_unsupported" });
    return;
  }

  const staff = await prisma.staff.findFirst({
    where: { id: parsed.data.staffId, shopId: shop.id, active: true },
    select: { id: true },
  });
  if (!staff) {
    res.status(400).json({ error: "invalid_slot" });
    return;
  }
  // Resolved against THIS shop, and only services this barber actually offers.
  const services = await loadGroupServices(shop.id, parsed.data.staffId, serviceIds);
  if (!services) {
    res.status(400).json({ error: "invalid_slot" });
    return;
  }

  const now = new Date();
  const from = parsed.data.from ?? now;
  const horizonMs = shop.bookingMaxDays * 24 * 60 * 60 * 1000;
  const to = parsed.data.to ?? new Date(now.getTime() + horizonMs);
  if (to.getTime() <= from.getTime()) {
    res.status(400).json({ error: "invalid_input", code: "RANGE" });
    return;
  }
  // Bounded like every other slot read: this endpoint fans out to
  // computeOpenSlots, which holds a pooled connection for its whole
  // interactive transaction. An unbounded window is a way to hold one open.
  if (to.getTime() - from.getTime() > horizonMs) {
    res.status(400).json({ error: "invalid_input", code: "RANGE_TOO_WIDE" });
    return;
  }

  // The SAME ordered plan /plan and /create build - walked per attendee, so a
  // repeated service id is counted once per person.
  const attendees = serviceIds.map((serviceId, i) => ({
    firstName: SLOT_PLACEHOLDER_NAMES[i] ?? "X",
    serviceId,
  }));
  let plan: GroupPlan;
  try {
    plan = planGroupSequence({
      attendees,
      startsAt: from,
      timezone: shop.timezone,
      services,
    });
  } catch (err) {
    if (err instanceof GroupPlanError) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }
    throw err;
  }

  const candidates = await computeOpenSlots({
    shopId: shop.id,
    staffId: parsed.data.staffId,
    serviceId: plan.members[0]!.serviceId,
    fromDate: from,
    toDate: to,
    // 🔴 Server-computed, from server-resolved durations. Never from the query.
    extraDurationMin: groupExtraDurationMin(plan),
    now,
  });

  // 🔴 RE-PLAN AT EACH CANDIDATE, because a duration is resolved at ITS OWN
  // start. The grid above was sized from ONE plan (at `from`), but a service
  // can be 30 minutes Mon-Thu and 20 on Friday - so a candidate on another
  // weekday can need more room than the grid was sized for. Re-planning is
  // pure and needs no database, so the check is cheap; without it this endpoint
  // would hand back times that /plan then refuses, which is the precise
  // disagreement it exists to prevent.
  const slots = candidates.filter((slot) => {
    try {
      const at = planGroupSequence({
        attendees,
        startsAt: slot.startsAt,
        timezone: shop.timezone,
        services,
      });
      const roomMin = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
      if (at.totalDurationMin > roomMin) return false;
      // Every LATER member's own service must be offered across its own span -
      // the one question the combined grid cannot answer. Same rule as preflight.
      return at.members.slice(1).every((m) => {
        const svc = services.get(m.serviceId)!;
        return serviceOfferedDuring({
          hoursWindows: svc.hoursWindows,
          timeOverrides: svc.timeOverrides,
          startsAt: m.startsAt,
          endsAt: m.endsAt,
          timezone: shop.timezone,
        });
      });
    } catch {
      return false;
    }
  });

  // Display-safe only: when the party may start, and when the chair frees up.
  res.json({
    timezone: shop.timezone,
    totalDurationMin: plan.totalDurationMin,
    slots: slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: new Date(
        s.startsAt.getTime() + plan.totalDurationMin * 60_000,
      ).toISOString(),
    })),
  });
});

/**
 * The sequence and the total, WITHOUT booking anything.
 *
 * This is what the customer is shown before the single explicit confirmation:
 * "Eric - Haircut - 2:00-2:30, Brother - Kids cut - 2:30-2:50", and the total.
 * It runs the same preflight the create runs, so a plan that renders is a plan
 * that was bookable a moment ago - the transaction is still what decides.
 */
bookingGroupRouter.post("/:slug/group/plan", rewardsLimiter, async (req, res) => {
  const parsed = planSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!hasActiveAccess(shop)) {
    res.status(403).json({ error: "no_active_access", code: "BOOKING_UNAVAILABLE" });
    return;
  }

  const result = await preflight(shop, parsed.data, {
    now: new Date(),
    // A plan is only ever shown to someone about to confirm, so it answers the
    // payment question too - the page must not lay out a visit it cannot book.
    requirePayable: true,
  });
  if (!result.ok) {
    res.status(result.failure.status).json({
      error: result.failure.code,
      ...("position" in result.failure ? { position: result.failure.position } : {}),
    });
    return;
  }
  res.json({ plan: planPayload(result.plan) });
});

/**
 * Create the whole group, atomically.
 *
 * 🔴 ONE LOCK, ONE COMBINED INTERVAL, ALL THE ROWS, OR NONE. The advisory lock
 * in lockStaffAndAssertSlotFree is keyed on the staff id, so a single call
 * already serialises every concurrent writer on this barber's calendar. It is
 * called once, on [first.startsAt, last.endsAt], which is strictly stronger
 * than checking each member: it also refuses anything trying to land BETWEEN
 * them, and it never compares the members against each other - which is what
 * lets them sit back to back with no turnover buffer wedged in between.
 *
 * Everything then commits in that same transaction. A conflict anywhere in the
 * combined interval throws before any row is written, so "no partial success"
 * is a property of the transaction rather than a cleanup path that has to run.
 */
bookingGroupRouter.post("/:slug/group", bookingWriteLimiter, async (req, res) => {
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
  if (!hasActiveAccess(shop)) {
    res.status(403).json({ error: "no_active_access", code: "BOOKING_UNAVAILABLE" });
    return;
  }
  const d = parsed.data;
  const phone = toE164(d.phone);
  if (d.phone?.trim() && !phone) {
    res.status(422).json({ error: "invalid_phone", code: "INVALID_PHONE", field: "phone" });
    return;
  }

  // An idempotent retry: the winner already exists, so return it unchanged
  // rather than doing any of the work again. The unique index below is what
  // settles a genuine RACE; this is the cheap path for the common case.
  if (d.idempotencyKey) {
    const existing = await prisma.appointmentGroup.findUnique({
      where: { idempotencyKey: d.idempotencyKey },
      select: { id: true, shopId: true, manageToken: true },
    });
    if (existing) {
      if (existing.shopId !== shop.id) {
        // Someone else's key. Say nothing about whose.
        res.status(409).json({ error: "idempotency_conflict" });
        return;
      }
      res.status(200).json({ groupId: existing.id, manageToken: existing.manageToken, retried: true });
      return;
    }
  }

  const now = new Date();
  const result = await preflight(shop, d, { now, requirePayable: true });
  if (!result.ok) {
    res.status(result.failure.status).json({
      error: result.failure.code,
      ...("position" in result.failure ? { position: result.failure.position } : {}),
    });
    return;
  }
  const plan = result.plan;
  const acuityClientKey = deriveAcuityClientKey({
    phone,
    email: d.email || null,
    firstName: d.firstName,
    lastName: d.lastName || null,
  });
  const consented = d.smsConsent === true;

  // Collected inside the transaction, acted on after it commits.
  const appointmentIds: string[] = [];
  const mirrorOutboxIds: string[] = [];
  try {
    const created = await prisma.$transaction(async (tx) => {
      // 🔴 ONE call, the COMBINED interval. See the header above.
      await lockStaffAndAssertSlotFree(tx, {
        walkInCapacity: "enforce",
        staffId: d.staffId,
        shopId: shop.id,
        startsAt: plan.startsAt,
        endsAt: plan.endsAt,
        bufferMin: shop.bookingBufferMin,
        // A group is customer-driven, so the per-service daily cap applies -
        // keyed on the FIRST member's service, matching how the single booking
        // path asks the question. A cap that must count every member separately
        // is a real gap and is called out in the PR rather than faked here.
        serviceDayLimit: { serviceId: plan.members[0]!.serviceId, timezone: shop.timezone },
        now,
      });

      const client = await tx.client.upsert({
        where: { shopId_acuityClientKey: { shopId: shop.id, acuityClientKey } },
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

      const group = await tx.appointmentGroup.create({
        data: {
          shopId: shop.id,
          staffId: d.staffId,
          clientId: client.id,
          firstName: d.firstName,
          lastName: d.lastName || null,
          phone,
          email: d.email || null,
          manageToken: randomToken(),
          idempotencyKey: d.idempotencyKey ?? null,
        },
        select: { id: true, manageToken: true },
      });

      for (const m of plan.members) {
        const appt = await tx.appointment.create({
          data: {
            shopId: shop.id,
            staffId: d.staffId,
            serviceId: m.serviceId,
            clientId: client.id,
            // 🔴 The ATTENDEE's name, not the booker's - this is what the barber
            // reads off the calendar to call the right person over. The booker's
            // name and contact details live on the group.
            firstName: m.firstName,
            lastName: null,
            phone,
            email: d.email || null,
            // Pay-at-shop only in v1 (see the header), so there is no hold and
            // no approval branch: these are real bookings the moment they commit.
            status: "BOOKED",
            startsAt: m.startsAt,
            endsAt: m.endsAt,
            priceAtBooking:
              m.priceCents === null ? undefined : new Prisma.Decimal(m.priceCents / 100),
            // Each member keeps its OWN manage token. That is what makes
            // "cancel just me" possible without handing out the whole group.
            manageToken: randomToken(),
            groupId: group.id,
            groupPosition: m.position,
          },
          select: { id: true },
        });

        // 🔴 EVERY MEMBER GETS ITS OWN ACUITY BLOCK, and the intent is written
        // in THIS transaction so an appointment can never exist without one.
        //
        // This was missing when the group endpoints first shipped, and on an
        // ENFORCE shop that is not a cosmetic gap: the barber's Acuity calendar
        // stays sellable over three chairs ChairBack has already promised. That
        // is the exact way a ChairBack booking which had held 6:10pm for eleven
        // days got sold over from the Acuity side.
        //
        // A group is N blocks, not one: Acuity has no notion of a party, and a
        // single block spanning the run would be wrong the moment one attendee
        // cancels. The HTTP calls happen after commit for the same reason the
        // single path defers them - holding the staff advisory lock across
        // 200-800ms of Acuity latency would serialise every booking for this
        // barber behind it, and a group would hold it three times over.
        const outboxIds = await recordMirrorIntent(tx, {
          shopId: shop.id,
          now,
          appointmentId: appt.id,
          staffId: d.staffId,
          startsAt: m.startsAt,
          endsAt: m.endsAt,
          occupancy: {
            // Pay-at-shop only in v1, so a group member is always a real
            // booking - never a payment hold and never an approval request.
            status: "BOOKED",
            startsAt: m.startsAt,
            endsAt: m.endsAt,
            holdExpiresAt: null,
            holdReason: null,
            visitId: null,
          },
        });
        appointmentIds.push(appt.id);
        mirrorOutboxIds.push(...outboxIds);
      }
      return group;
    });

    // MIRROR BEFORE WE PROMISE ANYTHING. Acuity has to be holding every one of
    // these times before the customer is told the party is booked - otherwise
    // "you are booked" is a claim we cannot back.
    //
    // 🔴 PER-MEMBER OUTCOMES, NOT THE COLLAPSED ONE. dispatchCreateAll folds
    // several answers into one and lets `failed` win over `unknown`. For a
    // single appointment that is correct. For a party it is dangerous: three
    // members coming back ACTIVE + FAILED + UNKNOWN is NOT a definitive
    // failure, because the UNKNOWN member's block may exist in Acuity. Acting
    // on the FAILED one alone would release what we can see and ORPHAN what we
    // cannot - a block nobody can find, on a chair nothing will ever free.
    if (mirrorOutboxIds.length > 0) {
      const outcomes = await dispatchCreateEach(mirrorOutboxIds);
      const anyUnknown = outcomes.includes("unknown");
      const anyFailed = outcomes.includes("failed");

      // 🔴 UNKNOWN OUTRANKS FAILED. Uncertainty anywhere in the party means
      // nothing here may be called definitive yet, whatever else came back.
      if (anyUnknown) {
        logger.warn(
          { shopId: shop.id, groupId: created.id, outboxIds: mirrorOutboxIds, outcomes },
          "acuity mirror: ambiguous group create - holding party for reconciliation",
        );
        // DURABLE. The party keeps its chairs and the settlement sweep finishes
        // it once the reconciler has resolved every UNKNOWN - see
        // engines/appointmentGroupSettle.ts. An in-memory callback would lose
        // this on the next deploy, and deploys happen constantly.
        await prisma.appointmentGroup.updateMany({
          where: { id: created.id, shopId: shop.id },
          data: { mirrorPendingSince: now },
        });
        await noteAvailabilityChanged(shop.id);
        res.status(202).json({
          status: "processing",
          groupId: created.id,
          manageToken: created.manageToken,
        });
        return;
      }

      if (anyFailed) {
        // DEFINITIVE, and now provably so: nothing in this party is uncertain.
        // 🔴 UNDO THE WHOLE PARTY. Keeping the members that happened to land
        // would leave a family booked for two of three chairs and nobody told
        // which one is missing - the partial success this feature exists to
        // make impossible. compensateGroup releases EVERY member's blocks, not
        // only the failed one. Nothing has been sent and no money was taken.
        await compensateGroup(shop.id, created.id, now);
        await noteAvailabilityChanged(shop.id);
        res.status(409).json({ error: "slot_unavailable_external", code: "SLOT_UNAVAILABLE" });
        return;
      }
    }
    await noteAvailabilityChanged(shop.id);

    // 🔴 ONE CONFIRMATION FOR THE WHOLE PARTY, not one per chair, and claimed
    // through the SAME durable marker the settlement sweep uses. Whichever
    // route reaches a party first wins; the other reads count === 0 and sends
    // nothing. That is what stops a retry - or a sweep racing this response -
    // putting a second "you are booked" in front of the same family.
    //
    // 🔴 AWAITED, unlike the single booking path's fire-and-forget notify. Two
    // fast writes, and they are what make the promise durable: if this were
    // voided and the process died here, the claim would never land, the party
    // would carry no mirrorPendingSince for the sweep to find, and the customer
    // would simply never be told. The EMAIL itself is still fire-and-forget
    // inside sendGroupConfirmationOnce - a send problem must not fail a booking
    // that is already saved.
    await sendGroupConfirmationOnce(shop.id, created.id, now);

    res.status(201).json({ groupId: created.id, manageToken: created.manageToken });
  } catch (err) {
    // 🔴 ASK THE IDEMPOTENCY KEY FIRST, BEFORE BELIEVING THE ERROR.
    //
    // A concurrent retry of the SAME submission loses this race with
    // SlotTakenError, not with a unique-violation - because by the time the
    // loser takes the advisory lock, the WINNER HAS ALREADY WRITTEN THE
    // APPOINTMENTS, and the loser dutifully reports that the chairs are taken.
    // They are: by itself. Answering 409 there would tell a customer whose
    // group exists that their booking failed, and the obvious "catch P2002"
    // never fires because the run never reaches the insert.
    //
    // So whenever a key was supplied, a failure means "look again" before it
    // means anything else. Found by a barrier test; a Promise.all would have
    // serialised the two and shown nothing.
    if (d.idempotencyKey) {
      const winner = await prisma.appointmentGroup.findUnique({
        where: { idempotencyKey: d.idempotencyKey },
        select: { id: true, shopId: true, manageToken: true },
      });
      if (winner && winner.shopId === shop.id) {
        res
          .status(200)
          .json({ groupId: winner.id, manageToken: winner.manageToken, retried: true });
        return;
      }
    }
    // An ENFORCE shop whose chair has no Acuity calendar mapped. The single
    // booking path refuses for the same reason: without somewhere to write the
    // block there is no way to protect the time, and booking anyway would be
    // the unprotected write this whole mechanism exists to prevent.
    if (err instanceof MirrorNotConfiguredError) {
      logger.error(
        { shopId: shop.id, staffId: err.staffId },
        "acuity mirror: ENFORCE with an unmapped chair - group booking refused",
      );
      res.status(409).json({ error: "slot_unavailable_external", code: "SLOT_UNAVAILABLE" });
      return;
    }
    if (err instanceof SlotTakenError) {
      // Someone else took part of the run while the customer was confirming.
      // NOTHING was written - the transaction rolled back - so the honest
      // answer is "pick again", with current availability.
      res.status(409).json({ error: "slot_taken", code: "SLOT_TAKEN" });
      return;
    }
    logger.error({ err, shopId: shop.id }, "group booking failed");
    res.status(500).json({ error: "server_error" });
  }
});

/** The group behind a whole-group manage token, or null. */
async function groupByToken(token: string | undefined) {
  if (!token) return null;
  return prisma.appointmentGroup.findUnique({
    where: { manageToken: String(token) },
    select: {
      id: true,
      shopId: true,
      staffId: true,
      status: true,
      firstName: true,
      shop: { select: { timezone: true, name: true, bookingBufferMin: true } },
      staff: { select: { name: true } },
      appointments: {
        orderBy: { groupPosition: "asc" },
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true,
          firstName: true,
          groupPosition: true,
          manageToken: true,
          priceAtBooking: true,
          serviceId: true,
          service: { select: { name: true, durationMin: true } },
        },
      },
    },
  });
}

/**
 * The whole visit behind one group token.
 *
 * 🔴 Each member OWN manage token is included, and that is the point: it is
 * what lets the page offer "cancel just this person" without a second lookup,
 * and it is only ever handed to someone who already holds the group token -
 * which is to say, the person who booked the whole party.
 */
bookingGroupRouter.get("/group/:token", rewardsLimiter, async (req, res) => {
  const group = await groupByToken(req.params.token);
  if (!group) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const live = group.appointments.filter((a) => a.status === "BOOKED");
  res.json({
    status: group.status,
    bookedBy: group.firstName,
    shop: { name: group.shop.name, timezone: group.shop.timezone },
    // 🔴 staffId is here so RESCHEDULE-ALL can reuse /group/slots - it needs to
    // ask for times on this barber with these services. A display-safe
    // identifier and nothing more: no mirror state, no Acuity id, no customer
    // data beyond what this token already authorises.
    staff: { id: group.staffId, name: group.staff.name },
    // The party span, from what is still BOOKED. A cancelled member shrinks
    // the visit rather than leaving a hole in the middle of it.
    startsAt: live[0]?.startsAt.toISOString() ?? null,
    endsAt: live[live.length - 1]?.endsAt.toISOString() ?? null,
    members: group.appointments.map((a) => ({
      appointmentId: a.id,
      manageToken: a.manageToken,
      position: a.groupPosition,
      firstName: a.firstName,
      status: a.status,
      // Same reason as staff.id above: reschedule-all rebuilds the party's
      // service list to re-ask for times. The NAME alone cannot do that.
      serviceId: a.serviceId,
      serviceName: a.service?.name ?? null,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      priceCents:
        a.priceAtBooking === null ? null : Math.round(Number(a.priceAtBooking) * 100),
    })),
  });
});

const rescheduleSchema = z.object({ startsAt: z.coerce.date() }).strict();

/**
 * Move the WHOLE group to a new start, atomically.
 *
 * 🔴 EVERY MEMBER MOVES OR NONE DOES. The run is re-planned from the new start
 * (durations are resolved at their new instants, so a move onto a weekday with
 * a different service length reshapes the sequence correctly), checked as ONE
 * combined interval, and written in ONE transaction. A group half-moved is a
 * party told to arrive at two different times.
 *
 * 🔴 The group own rows are EXCLUDED from the conflict check, all of them.
 * Without that the run collides with itself the moment the new window overlaps
 * the old one - which is most realistic moves, and the reason
 * lockStaffAndAssertSlotFree grew `excludeAppointmentIds`.
 */
bookingGroupRouter.post("/group/:token/reschedule", bookingWriteLimiter, async (req, res) => {
  const parsed = rescheduleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const group = await groupByToken(req.params.token);
  if (!group) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (group.status !== "ACTIVE") {
    res.status(409).json({ error: "group_canceled" });
    return;
  }
  const live = group.appointments.filter((a) => a.status === "BOOKED");
  if (live.length === 0) {
    res.status(409).json({ error: "nothing_to_move" });
    return;
  }
  const shop = await prisma.shop.findUnique({ where: { id: group.shopId } });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const now = new Date();
  // Re-plan from the new start, keeping each member attendee and service.
  const result = await preflight(
    shop,
    {
      staffId: group.staffId,
      startsAt: parsed.data.startsAt,
      attendees: live.map((a) => ({ firstName: a.firstName, serviceId: a.serviceId })),
    },
    { now, requirePayable: false },
  );
  if (!result.ok) {
    res.status(result.failure.status).json({
      error: result.failure.code,
      ...("position" in result.failure ? { position: result.failure.position } : {}),
    });
    return;
  }
  const plan = result.plan;

  try {
    await prisma.$transaction(async (tx) => {
      await lockStaffAndAssertSlotFree(tx, {
        walkInCapacity: "enforce",
        staffId: group.staffId,
        shopId: shop.id,
        startsAt: plan.startsAt,
        endsAt: plan.endsAt,
        bufferMin: shop.bookingBufferMin,
        // 🔴 All of them. See the header.
        excludeAppointmentIds: live.map((a) => a.id),
        // A reschedule is a MOVE, not a new sale: the per-service daily cap was
        // already paid on the way in, and re-charging it would refuse a
        // customer permission to move a booking they already hold.
        serviceDayLimit: null,
        now,
      });
      // 🔴 PARK, THEN PLACE - two passes, and the second one is not optional.
      //
      // The partial unique index on (staffId, startsAt) WHERE status='BOOKED'
      // is checked per STATEMENT, not at commit, so shifting a run in place
      // collides with itself: moving a 2:00-2:50 pair to 2:30 writes member 0
      // to 2:30 while member 1 is STILL SITTING at 2:30, and Postgres refuses
      // it. The failure is a 500 on a perfectly legal reschedule.
      //
      // Ordering the writes (descending for a later move, ascending for an
      // earlier one) fixes the common case and NOT the general one: durations
      // are re-resolved at the new instants, so a member can move later even
      // when the group moved earlier. Parking every row somewhere impossible
      // first is correct whatever the two layouts are.
      //
      // The epoch is the park: no shop has 1970 appointments, the minute offset
      // keeps the parked rows distinct from each other, and none of it is ever
      // observable - it exists only between two statements of one transaction.
      for (const [i, row] of live.entries()) {
        await tx.appointment.update({
          where: { id: row.id },
          data: {
            startsAt: new Date(i * 60_000),
            endsAt: new Date(i * 60_000 + 60_000),
          },
        });
      }
      for (const [i, m] of plan.members.entries()) {
        await tx.appointment.update({
          where: { id: live[i]!.id },
          data: { startsAt: m.startsAt, endsAt: m.endsAt },
        });
      }
    });
  } catch (err) {
    if (err instanceof SlotTakenError) {
      res.status(409).json({ error: "slot_taken", code: "SLOT_TAKEN" });
      return;
    }
    logger.error({ err, groupId: group.id }, "group reschedule failed");
    res.status(500).json({ error: "server_error" });
    return;
  }
  res.json({ ok: true, plan: planPayload(plan) });
});

/**
 * Cancel the ENTIRE group.
 *
 * 🔴 A SEPARATE, EXPLICIT ACTION. Cancelling one attendee is the ordinary
 * single-appointment cancel through that member OWN manage token, and it
 * leaves the rest of the party booked - because they are still coming. Nothing
 * infers one from the other in either direction, which is the whole reason a
 * group is a row rather than a guess about adjacent bookings.
 */
bookingGroupRouter.post("/group/:token/cancel", bookingWriteLimiter, async (req, res) => {
  const group = await groupByToken(req.params.token);
  if (!group) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await cancelGroup(group.shopId, group.id, new Date(), {
    // Customer-initiated: the shop cancellation policy applies per member,
    // exactly as it would one visit at a time.
    applyPolicyFee: true,
  });
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Idempotent: cancelling an already-cancelled group is a no-op that still
  // answers 200, so a double-tap cannot produce an error the customer has to
  // interpret.
  res.json({ ok: true, canceled: result.canceled });
});
