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
import { isSlotBookable } from "../engines/slots.js";
import { bookingWriteLimiter, rewardsLimiter } from "../middleware/rateLimit.js";
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
        await tx.appointment.create({
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
        });
      }
      return group;
    });

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
    staff: { name: group.staff.name },
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
