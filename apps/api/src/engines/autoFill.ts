import { QUIET_HOURS, localMinutesOfDay, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { Prisma, prisma, runAsOwner, type LoyaltyTier } from "@chairback/db";
import { logger } from "../logger.js";
import { hasPremiumAccess } from "../billing/entitlements.js";
import { pushDispatchMode } from "../messaging/push.js";
import { smsEnabled } from "../messaging/twilio.js";
import { receptionistConfigured, receptionistEnabledForShop } from "../receptionist/config.js";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import { loadBookingBlocks } from "../services/clientBookingBlock.js";
import { staffMirrorBlocked } from "./acuityMirror.js";
import { AUTO_FILL_STAGE_MS, autoFillDeadline } from "./autoFillRules.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "./bookingWrite.js";
import { inQuietHours } from "./quietHours.js";
import { ServiceDayFullError } from "./serviceDailyLimit.js";
import { PUBLIC_SERVICE } from "./serviceVisibility.js";
import { computeOpenSlots } from "./slots.js";
import { notifyInvitees, tiersAtOrAbove } from "./tierOpenings.js";
import { clientsWithUpcomingBooking } from "./upcomingBooking.js";
import { claimWouldRequirePayment, offerFreedSlotToWaitlist, offerLockKey, slotPrice } from "./waitlistOffer.js";

/**
 * AUTO-FILL: when a client cancels, the time is offered to the shop's best
 * clients before anyone else - Gold members first, then Silver, then the
 * waitlist, then the booking page. Rules only: no model, nothing that costs a
 * message. Every offer is a push to the My ChairBack app, where one tap books
 * it under the member's own record (claimTierOpening).
 *
 * 🔴 IT IS BUILT FROM HOLDS THAT ALREADY EXIST, NOT A NEW KIND OF HOLD. Each
 * stage is a TierOpening (Gold, then the SAME row widened to Silver) or a
 * WaitlistOffer, so the slot grid and the booking guard already keep the time
 * off the booking page while it is offered, and a barber who books over it
 * already releases it. This file only decides who is offered it, and when.
 *
 * 🔴 ONE ROW CARRIES ONE CANCELLATION THROUGH THE STAGES (AutoFillRun), written
 * in the cancellation's own transaction (queueAutoFillRun), so a restart can
 * never lose one, and advanced by the waitlist sweep (advanceAutoFill). The
 * row's state says which stage it is in; `nextAt` says when the sweep next
 * looks at it. Every path through a stage either closes the run or moves
 * nextAt on, so no run is ever stuck due.
 *
 *   queued -> startRun:   checks the shop, the service, the money and the
 *                         clock, then holds the slot for Gold (or for Gold and
 *                         Silver at once when there is not time for two stages)
 *   gold   -> widenToSilver: Silver members join the SAME opening; Gold keeps
 *                         their invitation and is not pushed again
 *   silver -> finishTiers: the hold has run out; the waitlist gets its turn
 *
 * A hold ends early only by setting heldUntil = now, which every reader of a
 * hold already understands. Lock order (bookingWrite.ts header): staff ->
 * wloffer -> TierOpening row -> AutoFillRun row, never the reverse.
 *
 * Shop.autoFillEnabled is off for every shop. Nothing turns it on until the
 * app build that lets a member switch these pushes off.
 */

/** Only a cancellation inside this window is worth offering around. */
export const AUTO_FILL_HORIZON_MS = 7 * 24 * 60 * 60_000;
export { AUTO_FILL_STAGE_MS, autoFillDeadline };
/** Time between the cancellation and the first push: room for Undo. */
export const AUTO_FILL_START_DELAY_MS = 60_000;
/** A window shorter than this is not worth telling anyone about. */
const MIN_WINDOW_MS = 15 * 60_000;
/** Per member, per shop: invitations in a day, and in a week. */
const CAP_PER_DAY = 2;
const CAP_PER_WEEK = 4;
/** Runs read per sweep tick. */
const BATCH = 25;
/** How late the every-2-minutes sweep can run a stage, for planning around quiet hours. */
const SWEEP_SLACK_MS = 5 * 60_000;

export type AutoFillOutcome =
  /** A member booked it. */
  | "claimed"
  /** The barber ended it, booked over it, or the shop changed so a claim was refused. */
  | "released"
  /** Nobody in the tiers took it in time: handed to the waitlist. */
  | "lapsed"
  /** The cancellation was undone before Auto-fill began. */
  | "restored"
  /** The shop no longer qualifies (switch off, rewards off, plan, not native, pushes off). */
  | "gates"
  /** The service is no longer on the booking page. */
  | "service_hidden"
  /** A claim would owe money or a card the app cannot take. */
  | "requires_payment"
  /** The barber's other calendar cannot be protected for this chair. */
  | "mirror_blocked"
  /** Too close to the start (and the shop's minimum notice) to offer. */
  | "too_soon"
  /** Night, and morning comes too late to still offer it. */
  | "quiet_hours"
  /** The time is no longer free, or not one the booking page would offer. */
  | "unavailable"
  /** Nobody in the tiers can be reached. */
  | "no_members"
  | "error";

/** A run's identity: one per cancellation, never two. */
export function autoFillTriggerKey(appointmentId: string, cancellationRevision: number): string {
  return `cancel:${appointmentId}:r${cancellationRevision}`;
}

const SHOP_SELECT = {
  id: true,
  timezone: true,
  bookingMode: true,
  bookingLeadHours: true,
  bookingBufferMin: true,
  autoFillEnabled: true,
  rewardsEnabled: true,
  requireBookingApproval: true,
  paymentsMode: true,
  connectChargesEnabled: true,
  stripeConnectAccountId: true,
  depositAmountCents: true,
  requireCardToBook: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
  plan: true,
  // The receptionist's own gap-fill owns a freed slot while texting is live.
  aiTrialEndsAt: true,
  receptionistEnabled: true,
  receptionistSubscriptionStatus: true,
  receptionistCompAccess: true,
  receptionistTermsAcceptedAt: true,
} as const;

type AutoFillShop = Prisma.ShopGetPayload<{ select: typeof SHOP_SELECT }>;

function loadShop(shopId: string): Promise<AutoFillShop | null> {
  // Owner read: a tenant session sees no Shop rows.
  return prisma.shop.findUnique({ where: { id: shopId }, select: SHOP_SELECT });
}

/**
 * Does this shop run Auto-fill right now? Everything that does not depend on
 * the particular time: the switch, rewards (tiers are a rewards feature), a
 * native calendar, the plan, a push that would really be sent, and the
 * receptionist not already owning freed slots by text.
 */
function shopRunsAutoFill(shop: AutoFillShop | null, now: Date): shop is AutoFillShop {
  if (!shop) return false;
  if (!shop.autoFillEnabled || !shop.rewardsEnabled || shop.bookingMode !== "native") return false;
  if (!hasPremiumAccess(shop, { now })) return false;
  if (pushDispatchMode() !== "live") return false;
  if (receptionistConfigured() && receptionistEnabledForShop(shop, { now }) && smsEnabled()) return false;
  return true;
}

/**
 * Asked BEFORE a client's cancellation transaction: should this cancellation
 * start a run? Read outside the transaction (Shop is owner-only), and asked
 * again when the run starts, so a shop that changes in between is caught.
 */
export async function autoFillShouldQueue(shopId: string, now: Date = new Date()): Promise<boolean> {
  return shopRunsAutoFill(await loadShop(shopId), now);
}

/**
 * Write the run, INSIDE the cancellation's transaction and behind its
 * compare-and-set, so it exists exactly when the cancellation does. Returns
 * whether a run was written: only for a future time inside the horizon.
 */
export async function queueAutoFillRun(
  tx: Prisma.TransactionClient,
  params: {
    shopId: string;
    appointment: { id: string; staffId: string | null; serviceId: string | null; startsAt: Date; endsAt: Date };
    cancellationRevision: number;
    now: Date;
  },
): Promise<boolean> {
  const a = params.appointment;
  if (!a.staffId || !a.serviceId) return false;
  const ahead = a.startsAt.getTime() - params.now.getTime();
  if (ahead <= 0 || ahead > AUTO_FILL_HORIZON_MS) return false;
  await tx.autoFillRun.create({
    data: {
      shopId: params.shopId,
      appointmentId: a.id,
      triggerKey: autoFillTriggerKey(a.id, params.cancellationRevision),
      staffId: a.staffId,
      serviceId: a.serviceId,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      state: "queued",
      nextAt: new Date(params.now.getTime() + AUTO_FILL_START_DELAY_MS),
      createdAt: params.now,
    },
  });
  return true;
}

interface RunRow {
  id: string;
  shopId: string;
  appointmentId: string;
  triggerKey: string;
  staffId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  state: string;
  openingId: string | null;
  deadline: Date | null;
}

const RUN_SELECT = {
  id: true,
  shopId: true,
  appointmentId: true,
  triggerKey: true,
  staffId: true,
  serviceId: true,
  startsAt: true,
  endsAt: true,
  state: true,
  openingId: true,
  deadline: true,
} as const;

/**
 * The sweep body, on the waitlist sweep's lease. Each due run is handled on
 * its own: one that throws is closed as an error (and its hold ended, so the
 * time is not lost) without stopping the rest.
 */
export async function advanceAutoFill(now: Date = new Date()): Promise<{ handled: number }> {
  const due = await runAsOwner((tx) =>
    tx.autoFillRun.findMany({
      where: { state: { not: "closed" }, nextAt: { lte: now } },
      orderBy: [{ nextAt: "asc" }, { id: "asc" }],
      take: BATCH,
      select: RUN_SELECT,
    }),
  );
  let handled = 0;
  for (const run of due) {
    try {
      if (run.state === "queued") await startRun(run, now);
      else if (run.state === "gold") await widenToSilver(run, now);
      else if (run.state === "silver") await finishTiers(run, now);
      handled += 1;
    } catch (err) {
      logger.error({ err, shopId: run.shopId, runId: run.id, state: run.state }, "auto-fill: stage failed");
      await failRun(run, now).catch((e: unknown) => {
        logger.error({ err: e, shopId: run.shopId, runId: run.id }, "auto-fill: could not close a failed run");
      });
    }
  }
  return { handled };
}

/** Close a run from the state it was read in. Loses cleanly to anyone who moved it first. */
async function closeRun(
  db: Prisma.TransactionClient,
  run: { id: string },
  from: string,
  outcome: AutoFillOutcome,
): Promise<boolean> {
  const done = await db.autoFillRun.updateMany({
    where: { id: run.id, state: from },
    data: { state: "closed", nextAt: null, outcome },
  });
  return done.count === 1;
}

/** Close from outside a transaction; hand the time to the waitlist when told to. */
async function closeAndMaybeHandOff(run: RunRow, from: string, outcome: AutoFillOutcome, now: Date, handOff: boolean) {
  const closed = await runAsOwner((tx) => closeRun(tx, run, from, outcome));
  if (!closed) return; // another sweep moved it first
  logger.info({ shopId: run.shopId, runId: run.id, outcome }, "auto-fill: run closed");
  if (handOff) await handToWaitlist(run, now);
}

/**
 * The tiers are done with it: the waitlist's turn, through the waitlist's own
 * gates (offerFreedSlotToWaitlist), which is exactly what a cancellation at a
 * shop without Auto-fill gets.
 */
async function handToWaitlist(run: RunRow, now: Date): Promise<void> {
  const span = run.openingId
    ? await prisma.tierOpening.findUnique({ where: { id: run.openingId }, select: { startsAt: true, endsAt: true } })
    : null;
  await offerFreedSlotToWaitlist(
    {
      shopId: run.shopId,
      staffId: run.staffId,
      serviceId: run.serviceId,
      startsAt: span?.startsAt ?? run.startsAt,
      endsAt: span?.endsAt ?? run.endsAt,
    },
    now,
  );
}

/**
 * A stage threw. Fail OPEN: end the hold, so the time is back on the booking
 * page now rather than when the hold would have run out, close the run so the
 * sweep stops retrying it, and give the waitlist its turn.
 *
 * 🔴 The run is RE-READ, never trusted from the sweep's copy: a stage can
 * commit its hold and then throw, and the copy read while it was queued has no
 * openingId - so the hold it had just made was left standing with nothing
 * behind it to widen or finish it. It closes only from the state it read, so
 * it never closes a run another sweep has since moved on. The read is unlocked
 * (openingId is written once, under the queued lock), so the opening row is
 * still taken before the run row.
 */
async function failRun(run: RunRow, now: Date): Promise<void> {
  const closed = await runAsOwner(async (tx) => {
    const fresh = await tx.autoFillRun.findUnique({
      where: { id: run.id },
      select: { openingId: true, state: true },
    });
    if (!fresh || fresh.state === "closed") return null;
    if (fresh.openingId) {
      await tx.tierOpening.updateMany({
        where: { id: fresh.openingId, status: "HELD", heldUntil: { gt: now } },
        data: { heldUntil: now },
      });
    }
    const done = await tx.autoFillRun.updateMany({
      where: { id: run.id, state: fresh.state },
      data: { state: "closed", nextAt: null, outcome: "error" },
    });
    return done.count === 1 ? { ...run, openingId: fresh.openingId } : null;
  });
  if (!closed) return;
  await noteAvailabilityChanged(run.shopId);
  await handToWaitlist(closed, now);
}

/**
 * Tell the invited members, after the stage has committed. A push failing is
 * not the stage failing: the hold and the run's next step already stand, and
 * anyone not told is picked up by the resend sweep.
 */
async function pushInvitations(run: RunRow, openingId: string, now: Date): Promise<void> {
  await notifyInvitees(openingId, { now }).catch((err: unknown) => {
    logger.error({ err, shopId: run.shopId, runId: run.id, openingId }, "auto-fill: push failed; the resend sweep retries");
  });
}

/** The next 08:00 (the end of quiet hours) in the shop's zone, after `now`. */
function nextQuietEnd(timezone: string, now: Date): Date {
  const p = zonedDateParts(now, timezone);
  const startMin = QUIET_HOURS.startHour * 60;
  const today = localMinutesOfDay(now, timezone) < startMin;
  return zonedWallTimeToUtc(p.year, p.month0, p.day + (today ? 0 : 1), startMin, timezone);
}

/** Stage 1: is this worth offering, and to whom? Then hold it. */
async function startRun(run: RunRow, now: Date): Promise<void> {
  // The cancellation must still stand. Undo restores the booking; a second
  // cancellation after that is a different run with its own key.
  const appt = await runAsOwner((tx) =>
    tx.appointment.findUnique({
      where: { id: run.appointmentId },
      select: { status: true, cancellationRevision: true, clientId: true, email: true },
    }),
  );
  if (
    !appt ||
    appt.status !== "CANCELED" ||
    autoFillTriggerKey(run.appointmentId, appt.cancellationRevision) !== run.triggerKey
  ) {
    await closeAndMaybeHandOff(run, "queued", "restored", now, false);
    return;
  }

  const shop = await loadShop(run.shopId);
  if (!shopRunsAutoFill(shop, now)) {
    await closeAndMaybeHandOff(run, "queued", "gates", now, true);
    return;
  }
  // 🔴 Only what the booking page offers. The visibility rule is kept out of
  // the slot engine on purpose (serviceVisibility.ts), so it is asked here: a
  // barber-only or retired service is never pushed to members.
  const service = await prisma.service.findFirst({
    where: { id: run.serviceId, shopId: run.shopId, ...PUBLIC_SERVICE },
    select: { price: true, priceOverrides: true, dateOverrides: true, timeOverrides: true },
  });
  if (!service) {
    await closeAndMaybeHandOff(run, "queued", "service_hidden", now, true);
    return;
  }
  if (claimWouldRequirePayment(shop, slotPrice(service, run.startsAt, shop.timezone))) {
    await closeAndMaybeHandOff(run, "queued", "requires_payment", now, true);
    return;
  }
  if (await staffMirrorBlocked(run.shopId, run.staffId)) {
    await closeAndMaybeHandOff(run, "queued", "mirror_blocked", now, true);
    return;
  }

  const deadline = autoFillDeadline(run.startsAt, shop.bookingLeadHours);
  const windowMs = deadline.getTime() - now.getTime();
  if (windowMs < MIN_WINDOW_MS) {
    await closeAndMaybeHandOff(run, "queued", "too_soon", now, true);
    return;
  }
  // 🔴 No one is woken up. A cancellation at night waits for 08:00 if there
  // is still time then; if there is not, it goes the way a cancellation went
  // before Auto-fill.
  if (inQuietHours(shop.timezone, now)) {
    const wake = nextQuietEnd(shop.timezone, now);
    if (deadline.getTime() - wake.getTime() >= MIN_WINDOW_MS) {
      await runAsOwner((tx) =>
        tx.autoFillRun.updateMany({ where: { id: run.id, state: "queued" }, data: { nextAt: wake } }),
      );
      return;
    }
    await closeAndMaybeHandOff(run, "queued", "quiet_hours", now, true);
    return;
  }

  // The exact time, as the booking page would offer it right now: closed,
  // taken, past or off the grid is refused before anything is held, and the
  // hold's end comes from the same duration rules the picker uses.
  const target = run.startsAt.getTime();
  const slot = (
    await computeOpenSlots({
      shopId: run.shopId,
      staffId: run.staffId,
      serviceId: run.serviceId,
      fromDate: new Date(target - 24 * 60 * 60_000),
      toDate: new Date(target + 24 * 60 * 60_000),
      now,
    })
  ).find((s) => s.startsAt.getTime() === target);
  if (!slot) {
    await closeAndMaybeHandOff(run, "queued", "unavailable", now, true);
    return;
  }

  let plan: { kind: "gone" } | { kind: "nobody" } | { kind: "held"; openingId: string };
  try {
    plan = await runAsOwner(async (tx) => {
      // The guard every booking takes, with a CUSTOMER's rules: a member is
      // who will book it.
      await lockStaffAndAssertSlotFree(tx, {
        staffId: run.staffId,
        shopId: run.shopId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: shop.bookingBufferMin,
        serviceDayLimit: { serviceId: run.serviceId, timezone: shop.timezone },
        walkInCapacity: "enforce",
        now,
      });
      // The per-shop invitation cap is read and written under this lock.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${offerLockKey(run.shopId)}))`);
      const [mine] = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "AutoFillRun" WHERE id = ${run.id} AND state = 'queued' FOR UPDATE`,
      );
      if (!mine) return { kind: "gone" }; // another sweep got here first

      const people = await autoFillInvitees(tx, {
        shopId: run.shopId,
        minTier: "SILVER",
        canceller: { clientId: appt.clientId, email: appt.email },
        openingId: null,
        now,
      });
      const gold = people.filter((p) => p.tier === "GOLD");
      const silver = people.filter((p) => p.tier === "SILVER");
      if (people.length === 0) {
        // Only the sweep that really closes it hands the time on - never two.
        return (await closeRun(tx, run, "queued", "no_members")) ? { kind: "nobody" } : { kind: "gone" };
      }

      // Two stages need half an hour before the deadline, someone in each
      // tier, and the second stage's push to land before quiet hours - with
      // room for the sweep that runs it being a tick or two late (the widen
      // refuses at night anyway). Otherwise both tiers get it at once.
      const twoStages =
        windowMs >= 2 * AUTO_FILL_STAGE_MS &&
        gold.length > 0 &&
        silver.length > 0 &&
        !inQuietHours(shop.timezone, new Date(now.getTime() + AUTO_FILL_STAGE_MS + SWEEP_SLACK_MS));
      const heldUntil = new Date(
        Math.min(now.getTime() + (twoStages ? 2 : 1) * AUTO_FILL_STAGE_MS, deadline.getTime()),
      );
      const invited = twoStages ? gold : people;
      const minTier: LoyaltyTier = twoStages || silver.length === 0 ? "GOLD" : "SILVER";
      const opening = await tx.tierOpening.create({
        data: {
          shopId: run.shopId,
          staffId: run.staffId,
          serviceId: run.serviceId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          minTier,
          heldUntil,
          source: "auto",
          recipientCount: invited.length,
        },
        select: { id: true },
      });
      await tx.tierOpeningRecipient.createMany({
        data: invited.map((p) => ({
          openingId: opening.id,
          accountId: p.accountId,
          clientId: p.clientId,
          wave: p.tier === "GOLD" ? "gold" : "silver",
          createdAt: now,
        })),
      });
      await tx.autoFillRun.update({
        where: { id: run.id },
        data: {
          state: twoStages ? "gold" : "silver",
          nextAt: twoStages ? new Date(now.getTime() + AUTO_FILL_STAGE_MS) : heldUntil,
          openingId: opening.id,
          deadline,
        },
      });
      return { kind: "held", openingId: opening.id };
    });
  } catch (err) {
    if (err instanceof SlotTakenError || err instanceof ServiceDayFullError) {
      // Someone booked it, or the day is full: there is nothing to offer, to
      // the waitlist either.
      await closeAndMaybeHandOff(run, "queued", "unavailable", now, false);
      return;
    }
    throw err;
  }

  if (plan.kind === "nobody") {
    logger.info({ shopId: run.shopId, runId: run.id, outcome: "no_members" }, "auto-fill: run closed");
    await handToWaitlist(run, now);
    return;
  }
  if (plan.kind === "held") {
    await noteAvailabilityChanged(run.shopId);
    logger.info({ shopId: run.shopId, runId: run.id, openingId: plan.openingId }, "auto-fill: opening held");
    await pushInvitations(run, plan.openingId, now);
  }
}

/**
 * Stage 2: Gold has had its turn. Silver members join the SAME opening, so a
 * Gold member who has not tapped yet still can; they are not pushed again.
 */
async function widenToSilver(run: RunRow, now: Date): Promise<void> {
  if (!run.openingId) {
    await closeAndMaybeHandOff(run, "gold", "error", now, true);
    return;
  }
  const shop = await loadShop(run.shopId);
  // 🔴 Everything startRun checked, asked again: a service hidden, a deposit
  // switched on or the other calendar unprotected since the Gold stage would
  // otherwise be pushed to Silver - and the first Silver tap refused, with the
  // hold released and nobody on the waitlist told.
  let stop: AutoFillOutcome | null = null;
  if (!shopRunsAutoFill(shop, now)) stop = "gates";
  else {
    const service = await prisma.service.findFirst({
      where: { id: run.serviceId, shopId: run.shopId, ...PUBLIC_SERVICE },
      select: { price: true, priceOverrides: true, dateOverrides: true, timeOverrides: true },
    });
    if (!service) stop = "service_hidden";
    else if (claimWouldRequirePayment(shop, slotPrice(service, run.startsAt, shop.timezone))) stop = "requires_payment";
    else if (await staffMirrorBlocked(run.shopId, run.staffId)) stop = "mirror_blocked";
  }
  const night = shop ? inQuietHours(shop.timezone, now) : false;
  const appt = await runAsOwner((tx) =>
    tx.appointment.findUnique({ where: { id: run.appointmentId }, select: { clientId: true, email: true } }),
  );

  const step = await runAsOwner(async (tx) => {
    // wloffer, then the opening row, then the run row: the order every other
    // writer takes them in. A member claiming it holds the barber's lock and
    // then this row - never wloffer - so the two queue, never deadlock.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${offerLockKey(run.shopId)}))`);
    const [opening] = await tx.$queryRaw<{ status: string; heldUntil: Date }[]>(
      Prisma.sql`SELECT status, "heldUntil" FROM "TierOpening" WHERE id = ${run.openingId} FOR UPDATE`,
    );
    const [mine] = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM "AutoFillRun" WHERE id = ${run.id} AND state = 'gold' FOR UPDATE`,
    );
    if (!mine) return { kind: "gone" as const };
    if (!opening || opening.status === "RELEASED") {
      await closeRun(tx, run, "gold", "released");
      return { kind: "done" as const };
    }
    if (opening.status === "CLAIMED") {
      await closeRun(tx, run, "gold", "claimed");
      return { kind: "done" as const };
    }
    if (opening.heldUntil.getTime() <= now.getTime()) {
      await closeRun(tx, run, "gold", "lapsed");
      return { kind: "handoff" as const };
    }
    if (stop) {
      // The shop or the service changed mid-run: end the hold now.
      await tx.tierOpening.update({ where: { id: run.openingId! }, data: { heldUntil: now } });
      await closeRun(tx, run, "gold", stop);
      return { kind: "handoff" as const };
    }
    if (night) {
      // 🔴 Nobody is invited at night - the sweep ran this stage late, past
      // 21:00. Gold keeps the rest of its hold; the lapse hands it on as usual.
      await tx.autoFillRun.update({ where: { id: run.id }, data: { state: "silver", nextAt: opening.heldUntil } });
      return { kind: "done" as const };
    }

    // Everyone now eligible who is not already invited: Silver members, and a
    // Gold member who could not be reached when the first stage began.
    const silver = await autoFillInvitees(tx, {
      shopId: run.shopId,
      minTier: "SILVER",
      canceller: { clientId: appt?.clientId ?? null, email: appt?.email ?? null },
      openingId: run.openingId!,
      now,
    });
    if (silver.length > 0) {
      await tx.tierOpening.update({
        where: { id: run.openingId! },
        data: { minTier: "SILVER", recipientCount: { increment: silver.length } },
      });
      await tx.tierOpeningRecipient.createMany({
        data: silver.map((p) => ({
          openingId: run.openingId!,
          accountId: p.accountId,
          clientId: p.clientId,
          wave: "silver",
          createdAt: now,
        })),
        skipDuplicates: true,
      });
    }
    await tx.autoFillRun.update({
      where: { id: run.id },
      data: { state: "silver", nextAt: opening.heldUntil },
    });
    return { kind: silver.length > 0 ? ("widened" as const) : ("done" as const) };
  });

  if (step.kind === "handoff") {
    await noteAvailabilityChanged(run.shopId);
    await handToWaitlist(run, now);
  } else if (step.kind === "widened") {
    await pushInvitations(run, run.openingId, now);
  }
}

/** Stage 3: the tiers' hold has run its course. */
async function finishTiers(run: RunRow, now: Date): Promise<void> {
  const step = await runAsOwner(async (tx) => {
    // Rows only, opening first: this write only ENDS something.
    const [opening] = run.openingId
      ? await tx.$queryRaw<{ status: string; heldUntil: Date }[]>(
          Prisma.sql`SELECT status, "heldUntil" FROM "TierOpening" WHERE id = ${run.openingId} FOR UPDATE`,
        )
      : [];
    const [mine] = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM "AutoFillRun" WHERE id = ${run.id} AND state = 'silver' FOR UPDATE`,
    );
    if (!mine) return "gone" as const;
    if (!opening || opening.status === "RELEASED") {
      await closeRun(tx, run, "silver", "released");
      return "done" as const;
    }
    if (opening.status === "CLAIMED") {
      await closeRun(tx, run, "silver", "claimed");
      return "done" as const;
    }
    if (opening.heldUntil.getTime() > now.getTime()) {
      // Not over yet (the sweep ran early): come back when it is.
      await tx.autoFillRun.update({ where: { id: run.id }, data: { nextAt: opening.heldUntil } });
      return "done" as const;
    }
    await closeRun(tx, run, "silver", "lapsed");
    return "handoff" as const;
  });
  if (step === "handoff") {
    await noteAvailabilityChanged(run.shopId);
    await handToWaitlist(run, now);
  }
}

export interface AutoFillInvitee {
  accountId: string;
  /** The record they are invited as - their highest-tier one at this shop. */
  clientId: string;
  tier: LoyaltyTier;
}

/**
 * Who Auto-fill may offer a time to: the manual opening's rule (My ChairBack
 * accounts actively linked to a live, unblocked record at this shop whose tier
 * qualifies; never a demo account), and then, because nobody chose these
 * people by hand:
 *
 *   - never the person who just cancelled it - through ANY record of theirs
 *     here, matched by the record they cancelled or its email (never a phone
 *     alone: a shared phone is not the same person);
 *   - never someone already invited to this opening;
 *   - never someone the shop has blocked, by record, phone or email;
 *   - never someone who already has an upcoming visit here: an extra
 *     appointment is not what they asked for;
 *   - only someone a push can reach: their own push switch on, and a phone
 *     registered to their account;
 *   - and at most CAP_PER_DAY invitations in 24 hours and CAP_PER_WEEK in 7
 *     days from this shop, counting manual openings too. Read under the
 *     shop's wloffer lock, which every invitation is written under.
 *
 * Runs on an owner transaction: the links, devices and invitations are
 * platform-owned.
 */
export async function autoFillInvitees(
  tx: Prisma.TransactionClient,
  p: {
    shopId: string;
    minTier: LoyaltyTier;
    canceller: { clientId: string | null; email: string | null };
    /** Leave out everyone already invited to this opening. */
    openingId: string | null;
    now: Date;
  },
): Promise<AutoFillInvitee[]> {
  const rank = (t: LoyaltyTier) => ["BRONZE", "SILVER", "GOLD"].indexOf(t);
  const links = await tx.customerClientLink.findMany({
    where: {
      shopId: p.shopId,
      status: "active",
      account: { isDemo: false, pushEnabled: true },
      client: { shopId: p.shopId, archivedAt: null, bookingBlockedAt: null, loyaltyTier: { in: tiersAtOrAbove(p.minTier) } },
    },
    orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
    select: {
      accountId: true,
      clientId: true,
      client: { select: { loyaltyTier: true, phone: true, email: true } },
    },
  });
  if (links.length === 0) return [];
  const best = new Map<string, { clientId: string; tier: LoyaltyTier; phone: string | null; email: string | null }>();
  for (const l of links) {
    const tier = l.client.loyaltyTier!;
    const seen = best.get(l.accountId);
    if (!seen || rank(tier) > rank(seen.tier)) {
      best.set(l.accountId, { clientId: l.clientId, tier, phone: l.client.phone, email: l.client.email });
    }
  }
  const accountIds = [...best.keys()];

  // Every record each of these people has here, whatever its tier: the
  // canceller and an upcoming visit can sit on any of them.
  const allLinks = await tx.customerClientLink.findMany({
    where: { shopId: p.shopId, status: "active", accountId: { in: accountIds } },
    select: { accountId: true, clientId: true, client: { select: { email: true } } },
  });
  const cancellerEmail = p.canceller.email?.trim().toLowerCase() || null;
  const recordsOf = new Map<string, string[]>();
  const out = new Set<string>();
  for (const l of allLinks) {
    recordsOf.set(l.accountId, [...(recordsOf.get(l.accountId) ?? []), l.clientId]);
    if (
      (p.canceller.clientId && l.clientId === p.canceller.clientId) ||
      (cancellerEmail && l.client.email?.trim().toLowerCase() === cancellerEmail)
    ) {
      out.add(l.accountId);
    }
  }

  const [already, blocks, upcoming, devices, recent] = await Promise.all([
    p.openingId
      ? tx.tierOpeningRecipient.findMany({ where: { openingId: p.openingId }, select: { accountId: true } })
      : Promise.resolve([] as { accountId: string }[]),
    loadBookingBlocks(tx, p.shopId),
    clientsWithUpcomingBooking(tx, p.shopId, [...new Set(allLinks.map((l) => l.clientId))], p.now),
    tx.customerDevice.findMany({ where: { accountId: { in: accountIds } }, select: { accountId: true } }),
    tx.tierOpeningRecipient.findMany({
      where: {
        accountId: { in: accountIds },
        createdAt: { gt: new Date(p.now.getTime() - 7 * 24 * 60 * 60_000) },
        opening: { shopId: p.shopId },
        // An invitation that was never delivered does not count against them;
        // one not sent yet does, because it is about to be.
        OR: [{ delivered: true }, { notifiedAt: null }],
      },
      select: { accountId: true, createdAt: true },
    }),
  ]);
  for (const a of already) out.add(a.accountId);
  const reachable = new Set(devices.map((d) => d.accountId));
  const dayAgo = p.now.getTime() - 24 * 60 * 60_000;
  const perDay = new Map<string, number>();
  const perWeek = new Map<string, number>();
  for (const r of recent) {
    perWeek.set(r.accountId, (perWeek.get(r.accountId) ?? 0) + 1);
    if (r.createdAt.getTime() > dayAgo) perDay.set(r.accountId, (perDay.get(r.accountId) ?? 0) + 1);
  }

  const invitees: AutoFillInvitee[] = [];
  for (const [accountId, rec] of best) {
    if (out.has(accountId)) continue;
    if (!reachable.has(accountId)) continue;
    if (blocks.covers({ clientId: rec.clientId, phone: rec.phone, email: rec.email })) continue;
    if ((recordsOf.get(accountId) ?? []).some((c) => upcoming.has(c))) continue;
    if ((perDay.get(accountId) ?? 0) >= CAP_PER_DAY) continue;
    if ((perWeek.get(accountId) ?? 0) >= CAP_PER_WEEK) continue;
    invitees.push({ accountId, clientId: rec.clientId, tier: rec.tier });
  }
  return invitees;
}
