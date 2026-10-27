import { QUIET_HOURS, apiEnv, localMinutesOfDay, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import type { AutoFillBlocker } from "@chairback/config/fillCancellations";
import { Prisma, prisma, runAsOwner, type LoyaltyTier } from "@chairback/db";
import { logger } from "../logger.js";
import { hasPremiumAccess, type PlanShop } from "../billing/entitlements.js";
import { pushDispatchMode, sendPushToClient } from "../messaging/push.js";
import { buildAutoFillEveryonePush, formatOpeningWhen } from "../messaging/templates.js";
import { smsEnabled } from "../messaging/twilio.js";
import { receptionistConfigured, receptionistEnabledForShop, type ReceptionistShop } from "../receptionist/config.js";
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
 * AUTO-FILL ("Fill cancellations automatically"): when a client cancels, the
 * shop's Gold members get a short head start on the time, and then EVERY
 * client of the shop who has the app is told it is open - first to book it on
 * the booking page gets it. Rules only: no model, nothing that costs a message
 * (app pushes only, never a text or an email).
 *
 * 🔴 THE HEAD START IS A HOLD THAT ALREADY EXISTS, NOT A NEW KIND OF HOLD. Gold
 * gets a TierOpening, so the slot grid and the booking guard keep the time off
 * the booking page for those 15 minutes, a Gold member books it with one tap
 * in the app (claimTierOpening), and a barber who books over it releases it.
 *
 * 🔴 "EVERYONE" HOLDS NOTHING AND WRITES NO BOOKING. The time is simply on the
 * booking page again; the push says so, and whoever taps it books through the
 * ordinary booking flow and its ONE overlap guard. That is what makes "first
 * to book wins" true: there is no second write path to race the first. The
 * stage only decides who hears, and stops the moment the time is no longer on
 * the booking page - booked, blocked off by the barber, or too close to start.
 *
 * 🔴 ONE ROW CARRIES ONE CANCELLATION THROUGH THE STAGES (AutoFillRun), written
 * in the cancellation's own transaction (queueAutoFillRun), so a restart can
 * never lose one, and advanced by the waitlist sweep (advanceAutoFill). The
 * row's state says which stage it is in; `nextAt` says when the sweep next
 * looks at it. Every path through a stage either closes the run or moves
 * nextAt on, so no run is ever stuck due.
 *
 *   queued   -> startRun: checks the shop, the service and the clock, then
 *                         holds the slot for Gold for 15 minutes - or skips
 *                         straight to everyone when the time starts within
 *                         two hours, nobody Gold can be reached, or a hold is
 *                         not possible (a claim would owe money, or the other
 *                         calendar cannot be protected)
 *   gold     -> openToEveryone: the head start is over (or ended by a booking
 *                         or the barber); everyone else with the app is chosen
 *   everyone -> sendToEveryone: a batch of pushes per sweep, each person once,
 *                         until all are told or the time is gone
 *   silver   -> (the old second stage) finishes the way gold does
 *
 * The waitlist's own held offers (waitlistOffer.ts) get the time only when a
 * run cannot reach anyone - no app clients, the shop's gates, too late, night.
 * A waitlister with the app hears in the everyone stage like anyone else; a
 * hold for one person would hide the time from everyone just told about it.
 *
 * A hold ends early only by setting heldUntil = now, which every reader of a
 * hold already understands. Lock order (bookingWrite.ts header): staff ->
 * wloffer -> TierOpening row -> AutoFillRun row, never the reverse.
 *
 * Shop.autoFillEnabled is the barber's switch (Booking -> Settings), off by
 * default.
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
/**
 * A time starting sooner than this gets no Gold head start: everyone hears at
 * once. Fifteen minutes is a real share of two hours, and a short-notice
 * opening is filled by whoever can come, not by whoever ranks highest.
 */
export const AUTO_FILL_SHORT_NOTICE_MS = 2 * 60 * 60_000;
/** Everyone-stage pushes per run per sweep tick; the rest go on the next tick. */
const EVERYONE_PER_TICK = 150;
/** Re-read whether the time is still on the booking page after this many pushes. */
const RECHECK_EVERY = 10;

export type AutoFillOutcome =
  /** A Gold member booked it in the app during the head start. */
  | "claimed"
  /** Someone booked it on the booking page while everyone was being told. */
  | "filled"
  /** Everyone was told; the time stays on the booking page for whoever books first. */
  | "broadcast"
  /** The barber ended it, booked over it, or the shop changed so a claim was refused. */
  | "released"
  /** Nobody in the tiers took it in time: handed to the waitlist (the old Silver stage only). */
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
  /** Nobody with the app can be reached: handed to the waitlist. */
  | "no_members"
  | "error";

type RunState = "queued" | "gold" | "silver" | "everyone";

/** A run's identity: one per cancellation, never two. */
export function autoFillTriggerKey(appointmentId: string, cancellationRevision: number): string {
  return `cancel:${appointmentId}:r${cancellationRevision}`;
}

const SHOP_SELECT = {
  id: true,
  name: true,
  slug: true,
  publicPageEnabled: true,
  timezone: true,
  bookingMode: true,
  bookingLeadMinutes: true,
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

export type AutoFillShop = Prisma.ShopGetPayload<{ select: typeof SHOP_SELECT }>;

/** What autoFillBlockers reads: any Shop row has it. */
export type AutoFillGateShop = Pick<AutoFillShop, "bookingMode" | "publicPageEnabled" | "slug" | "rewardsEnabled"> &
  PlanShop &
  ReceptionistShop;

function loadShop(shopId: string): Promise<AutoFillShop | null> {
  // Owner read: a tenant session sees no Shop rows.
  return prisma.shop.findUnique({ where: { id: shopId }, select: SHOP_SELECT });
}

/**
 * Why this shop's switch would do nothing right now - everything that does
 * not depend on the particular time: a calendar ChairBack keeps, a booking
 * page anyone can book on, rewards (Gold is a rewards tier), the plan, the
 * receptionist not already owning freed slots by text, and a push that would
 * really be sent. Empty = it runs when switched on. The dashboard shows these
 * beside the switch (config/fillCancellations.ts says them in words), so a
 * barber never turns on a switch that silently does nothing.
 */
export function autoFillBlockers(shop: AutoFillGateShop, now: Date = new Date()): AutoFillBlocker[] {
  const out: AutoFillBlocker[] = [];
  if (shop.bookingMode !== "native") out.push("not_native");
  else if (!shop.publicPageEnabled || !shop.slug) out.push("booking_page_off");
  if (!shop.rewardsEnabled) out.push("rewards_off");
  if (!hasPremiumAccess(shop, { now })) out.push("plan");
  if (receptionistConfigured() && receptionistEnabledForShop(shop, { now }) && smsEnabled()) {
    out.push("receptionist_texting");
  }
  if (pushDispatchMode() !== "live") out.push("pushes_paused");
  return out;
}

/** Does this shop run Auto-fill right now? Switched on, and nothing in the way. */
function shopRunsAutoFill(shop: AutoFillShop | null, now: Date): shop is AutoFillShop {
  return !!shop && shop.autoFillEnabled && autoFillBlockers(shop, now).length === 0;
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
      else if (run.state === "gold" || run.state === "silver") await openToEveryone(run, run.state, now);
      else if (run.state === "everyone") await sendToEveryone(run, now);
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

/** Come back to this run at `at`, from the state it was read in. */
async function reschedule(run: RunRow, from: string, at: Date): Promise<void> {
  await runAsOwner((tx) => tx.autoFillRun.updateMany({ where: { id: run.id, state: from }, data: { nextAt: at } }));
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
    return done.count === 1 ? { run: { ...run, openingId: fresh.openingId }, state: fresh.state } : null;
  });
  if (!closed) return;
  await noteAvailabilityChanged(run.shopId);
  // 🔴 Not once everyone is being told: a waitlist hold would take the time
  // off the booking page under the people who just heard it is open.
  if (closed.state !== "everyone") await handToWaitlist(closed.run, now);
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

/**
 * May this time be offered to anyone at all? The shop's switch and gates, and
 * a service the booking page shows. 🔴 Only what the booking page offers: the
 * visibility rule is kept out of the slot engine on purpose
 * (serviceVisibility.ts), so it is asked here - a barber-only or retired
 * service is never pushed to anyone.
 */
async function offerStop(
  shop: AutoFillShop | null,
  run: RunRow,
  now: Date,
): Promise<{ stop: AutoFillOutcome } | { stop: null; shop: AutoFillShop; price: number | null }> {
  if (!shopRunsAutoFill(shop, now)) return { stop: "gates" };
  const service = await prisma.service.findFirst({
    where: { id: run.serviceId, shopId: run.shopId, ...PUBLIC_SERVICE },
    select: { price: true, priceOverrides: true, dateOverrides: true, timeOverrides: true },
  });
  if (!service) return { stop: "service_hidden" };
  return { stop: null, shop, price: slotPrice(service, run.startsAt, shop.timezone) };
}

/**
 * May Gold be given a HOLD on it? A claim in the app takes no payment and
 * holds only this calendar, so a time that would owe money, or a chair whose
 * other calendar cannot be protected, gets no head start - it goes straight
 * to everyone, who book it through the booking page and its own checkout.
 */
async function holdStop(shop: AutoFillShop, price: number | null, run: RunRow): Promise<AutoFillOutcome | null> {
  if (claimWouldRequirePayment(shop, price)) return "requires_payment";
  if (await staffMirrorBlocked(run.shopId, run.staffId)) return "mirror_blocked";
  return null;
}

/** Is this exact time on the booking page right now - free, open, far enough ahead? */
async function slotStillOpen(run: RunRow, now: Date): Promise<boolean> {
  const target = run.startsAt.getTime();
  const slots = await computeOpenSlots({
    shopId: run.shopId,
    staffId: run.staffId,
    serviceId: run.serviceId,
    fromDate: new Date(target - 24 * 60 * 60_000),
    toDate: new Date(target + 24 * 60 * 60_000),
    now,
  });
  return slots.some((s) => s.startsAt.getTime() === target);
}

/** The time left the booking page: was it booked, or closed some other way? */
async function takenOutcome(run: RunRow): Promise<AutoFillOutcome> {
  const booked = await runAsOwner((tx) =>
    tx.appointment.count({
      where: {
        shopId: run.shopId,
        staffId: run.staffId,
        status: "BOOKED",
        startsAt: { lt: run.endsAt },
        endsAt: { gt: run.startsAt },
      },
    }),
  );
  return booked > 0 ? "filled" : "unavailable";
}

/** Stage 1: is this worth offering? Then a head start for Gold, or straight to everyone. */
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
  const offer = await offerStop(shop, run, now);
  if (offer.stop !== null) {
    await closeAndMaybeHandOff(run, "queued", offer.stop, now, true);
    return;
  }

  const deadline = autoFillDeadline(run.startsAt, offer.shop.bookingLeadMinutes);
  const windowMs = deadline.getTime() - now.getTime();
  if (windowMs < MIN_WINDOW_MS) {
    await closeAndMaybeHandOff(run, "queued", "too_soon", now, true);
    return;
  }
  // 🔴 No one is woken up. A cancellation at night waits for 08:00 if there
  // is still time then; if there is not, it goes the way a cancellation went
  // before Auto-fill.
  if (inQuietHours(offer.shop.timezone, now)) {
    const wake = nextQuietEnd(offer.shop.timezone, now);
    if (deadline.getTime() - wake.getTime() >= MIN_WINDOW_MS) {
      await reschedule(run, "queued", wake);
      return;
    }
    await closeAndMaybeHandOff(run, "queued", "quiet_hours", now, true);
    return;
  }

  // The exact time, as the booking page would offer it right now: closed,
  // taken, past or off the grid is refused before anything is held or sent,
  // and the hold's end comes from the same duration rules the picker uses.
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

  // 🔴 THE HEAD START. Gold gets the time to itself for AUTO_FILL_STAGE_MS
  // only when that leaves a real chance for everyone after it: the time is at
  // least AUTO_FILL_SHORT_NOTICE_MS away, the window outlasts the head start
  // by a usable margin, and the push to everyone would not land in quiet
  // hours (with room for the sweep that sends it running a tick or two late).
  // A hold must also be possible (holdStop). Otherwise everyone hears now.
  const headStart =
    (await holdStop(offer.shop, offer.price, run)) === null &&
    target - now.getTime() >= AUTO_FILL_SHORT_NOTICE_MS &&
    windowMs >= AUTO_FILL_STAGE_MS + MIN_WINDOW_MS &&
    !inQuietHours(offer.shop.timezone, new Date(now.getTime() + AUTO_FILL_STAGE_MS + SWEEP_SLACK_MS));
  if (!headStart) {
    await openToEveryone({ ...run, deadline }, "queued", now);
    return;
  }

  let plan: { kind: "gone" } | { kind: "no_gold" } | { kind: "held"; openingId: string };
  try {
    plan = await runAsOwner(async (tx) => {
      // The guard every booking takes, with a CUSTOMER's rules: a member is
      // who will book it.
      await lockStaffAndAssertSlotFree(tx, {
        staffId: run.staffId,
        shopId: run.shopId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: offer.shop.bookingBufferMin,
        bookedServiceId: run.serviceId,
        serviceDayLimit: { serviceId: run.serviceId, timezone: offer.shop.timezone },
        walkInCapacity: "enforce",
        now,
      });
      // The per-shop invitation cap is read and written under this lock.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${offerLockKey(run.shopId)}))`);
      const [mine] = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "AutoFillRun" WHERE id = ${run.id} AND state = 'queued' FOR UPDATE`,
      );
      if (!mine) return { kind: "gone" }; // another sweep got here first

      const gold = await autoFillInvitees(tx, {
        shopId: run.shopId,
        minTier: "GOLD",
        canceller: { clientId: appt.clientId, email: appt.email },
        openingId: null,
        runId: null,
        now,
      });
      // Nobody Gold to give a head start to: nothing written, everyone hears now.
      if (gold.length === 0) return { kind: "no_gold" };

      const heldUntil = new Date(Math.min(now.getTime() + AUTO_FILL_STAGE_MS, deadline.getTime()));
      const opening = await tx.tierOpening.create({
        data: {
          shopId: run.shopId,
          staffId: run.staffId,
          serviceId: run.serviceId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          minTier: "GOLD",
          heldUntil,
          source: "auto",
          recipientCount: gold.length,
        },
        select: { id: true },
      });
      await tx.tierOpeningRecipient.createMany({
        data: gold.map((p) => ({
          openingId: opening.id,
          accountId: p.accountId,
          clientId: p.clientId,
          wave: "gold",
          createdAt: now,
        })),
      });
      await tx.autoFillRun.update({
        where: { id: run.id },
        data: { state: "gold", nextAt: heldUntil, openingId: opening.id, deadline },
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

  if (plan.kind === "no_gold") {
    await openToEveryone({ ...run, deadline }, "queued", now);
    return;
  }
  if (plan.kind === "held") {
    await noteAvailabilityChanged(run.shopId);
    logger.info({ shopId: run.shopId, runId: run.id, openingId: plan.openingId }, "auto-fill: Gold head start");
    await pushInvitations(run, plan.openingId, now);
  }
}

/**
 * Stage 2: Gold's head start is over (or there was none). The time is on the
 * booking page for anyone; choose everyone else with the app and start
 * telling them. Writes no hold and no booking - only who is to be told.
 *
 * `from` is the state the run was read in: "queued" (no head start), "gold",
 * or "silver" (a run begun by the build before this one).
 */
async function openToEveryone(run: RunRow, from: RunState, now: Date): Promise<void> {
  // The head start, if there was one. Read unlocked first: the decisions
  // below are re-made under the locks before anything is written.
  if (run.openingId) {
    const held = await prisma.tierOpening.findUnique({
      where: { id: run.openingId },
      select: { status: true, heldUntil: true },
    });
    if (!held || held.status === "RELEASED") {
      // The barber ended it or booked over it: the time is theirs again.
      await closeAndMaybeHandOff(run, from, "released", now, false);
      return;
    }
    if (held.status === "CLAIMED") {
      await closeAndMaybeHandOff(run, from, "claimed", now, false);
      return;
    }
    if (held.heldUntil.getTime() > now.getTime()) {
      // The sweep ran early: come back when the head start is over.
      await reschedule(run, from, held.heldUntil);
      return;
    }
  }

  const shop = await loadShop(run.shopId);
  const offer = await offerStop(shop, run, now);
  if (offer.stop !== null) {
    await closeAndMaybeHandOff(run, from, offer.stop, now, true);
    return;
  }
  const tz = offer.shop.timezone;
  const deadline = run.deadline ?? autoFillDeadline(run.startsAt, offer.shop.bookingLeadMinutes);
  if (deadline.getTime() - now.getTime() < MIN_WINDOW_MS) {
    await closeAndMaybeHandOff(run, from, "too_soon", now, true);
    return;
  }
  if (inQuietHours(tz, now)) {
    // The sweep reached a Gold stage after 21:00. Everyone hears at 08:00 if
    // there is still time then.
    const wake = nextQuietEnd(tz, now);
    if (deadline.getTime() - wake.getTime() >= MIN_WINDOW_MS) {
      await reschedule(run, from, wake);
      return;
    }
    await closeAndMaybeHandOff(run, from, "quiet_hours", now, true);
    return;
  }
  // 🔴 Never tell anyone about a time the booking page would not give them.
  if (!(await slotStillOpen(run, now))) {
    await closeAndMaybeHandOff(run, from, await takenOutcome(run), now, false);
    return;
  }
  const appt = await runAsOwner((tx) =>
    tx.appointment.findUnique({ where: { id: run.appointmentId }, select: { clientId: true, email: true } }),
  );

  const step = await runAsOwner(async (tx) => {
    // wloffer, then the opening row, then the run row: the order every other
    // writer takes them in.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${offerLockKey(run.shopId)}))`);
    if (run.openingId) {
      const [opening] = await tx.$queryRaw<{ status: string }[]>(
        Prisma.sql`SELECT status FROM "TierOpening" WHERE id = ${run.openingId} FOR UPDATE`,
      );
      if (opening?.status === "CLAIMED") {
        return (await closeRun(tx, run, from, "claimed")) ? ("closed" as const) : ("gone" as const);
      }
    }
    const [mine] = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM "AutoFillRun" WHERE id = ${run.id} AND state = ${from} FOR UPDATE`,
    );
    if (!mine) return "gone" as const; // another sweep moved it first

    const people = await autoFillInvitees(tx, {
      shopId: run.shopId,
      minTier: null,
      canceller: { clientId: appt?.clientId ?? null, email: appt?.email ?? null },
      // Gold members told during the head start are not told twice.
      openingId: run.openingId,
      runId: run.id,
      now,
    });
    if (people.length === 0) {
      return (await closeRun(tx, run, from, "no_members")) ? ("nobody" as const) : ("gone" as const);
    }
    await tx.autoFillRecipient.createMany({
      data: people.map((p) => ({
        runId: run.id,
        shopId: run.shopId,
        accountId: p.accountId,
        clientId: p.clientId,
        createdAt: now,
      })),
      skipDuplicates: true,
    });
    await tx.autoFillRun.update({
      where: { id: run.id },
      data: { state: "everyone", nextAt: now, deadline },
    });
    return "everyone" as const;
  });

  if (step === "nobody") {
    logger.info({ shopId: run.shopId, runId: run.id, outcome: "no_members" }, "auto-fill: run closed");
    await handToWaitlist(run, now);
    return;
  }
  if (step === "everyone") {
    // A head start that just ended put the time back on the booking page.
    if (run.openingId) await noteAvailabilityChanged(run.shopId);
    logger.info({ shopId: run.shopId, runId: run.id }, "auto-fill: open to everyone");
    await sendToEveryone({ ...run, state: "everyone", deadline }, now);
  }
}

/** Where the push takes them: the shop's booking page, on this service and barber. */
function bookingLink(shop: AutoFillShop, run: RunRow): string {
  const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
  const q = new URLSearchParams({ service: run.serviceId, staff: run.staffId });
  return `${base}/book/${encodeURIComponent(shop.slug ?? "")}?${q.toString()}`;
}

/**
 * Stage 3: tell the chosen people, a batch per sweep tick, each exactly once.
 * 🔴 Stops the moment the time is no longer on the booking page - asked
 * before the batch and again every RECHECK_EVERY pushes - so nobody is sent
 * to a time someone else has just booked. Never hands the time to the
 * waitlist: everyone told is free to book it, and a waitlist hold would take
 * it away from them.
 */
async function sendToEveryone(run: RunRow, now: Date): Promise<void> {
  const shop = await loadShop(run.shopId);
  const offer = await offerStop(shop, run, now);
  if (offer.stop !== null) {
    await closeAndMaybeHandOff(run, "everyone", offer.stop, now, false);
    return;
  }
  const tz = offer.shop.timezone;
  const deadline = run.deadline ?? autoFillDeadline(run.startsAt, offer.shop.bookingLeadMinutes);
  if (deadline.getTime() <= now.getTime()) {
    await closeAndMaybeHandOff(run, "everyone", "too_soon", now, false);
    return;
  }
  if (inQuietHours(tz, now)) {
    const wake = nextQuietEnd(tz, now);
    if (deadline.getTime() - wake.getTime() >= MIN_WINDOW_MS) await reschedule(run, "everyone", wake);
    else await closeAndMaybeHandOff(run, "everyone", "quiet_hours", now, false);
    return;
  }
  if (!(await slotStillOpen(run, now))) {
    await closeAndMaybeHandOff(run, "everyone", await takenOutcome(run), now, false);
    return;
  }

  const unsent = await runAsOwner((tx) =>
    tx.autoFillRecipient.findMany({
      where: { runId: run.id, notifiedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: EVERYONE_PER_TICK,
      select: { id: true, clientId: true },
    }),
  );
  const message = buildAutoFillEveryonePush({
    shopName: offer.shop.name,
    when: formatOpeningWhen(run.startsAt, tz),
  });
  const url = bookingLink(offer.shop, run);
  let sent = 0;
  for (const [i, r] of unsent.entries()) {
    if (i > 0 && i % RECHECK_EVERY === 0 && !(await slotStillOpen(run, now))) {
      logger.info({ shopId: run.shopId, runId: run.id, sent, left: unsent.length - i }, "auto-fill: time taken mid-send");
      await closeAndMaybeHandOff(run, "everyone", await takenOutcome(run), now, false);
      return;
    }
    // 🔴 THE ONE-PUSH GUARD: whoever stamps the row tells the person; a
    // second sweep on the same run finds it stamped and moves on.
    const claimed = await runAsOwner((tx) =>
      tx.autoFillRecipient.updateMany({ where: { id: r.id, notifiedAt: null }, data: { notifiedAt: now } }),
    );
    if (claimed.count === 0) continue;
    const result = await sendPushToClient({
      shopId: run.shopId,
      clientId: r.clientId,
      kind: "promo",
      // Not marketing, and its action is in the app (messaging/push.ts).
      ledger: false,
      appOnly: true,
      payload: { title: message.title, body: message.body, url, tag: `auto-fill-${run.id}` },
    });
    sent += 1;
    await runAsOwner((tx) =>
      tx.autoFillRecipient.update({ where: { id: r.id }, data: { delivered: result.anyDelivered } }),
    ).catch((err: unknown) => {
      // The push already went out (or didn't); a stamp failure must not throw.
      logger.error({ err, shopId: run.shopId, runId: run.id }, "auto-fill: delivery stamp failed");
    });
  }
  logger.info({ shopId: run.shopId, runId: run.id, sent }, "auto-fill: told everyone (batch)");
  if (unsent.length < EVERYONE_PER_TICK) {
    // Everyone has been told. The time stays on the booking page for whoever books first.
    await closeAndMaybeHandOff(run, "everyone", "broadcast", now, false);
  } else {
    await reschedule(run, "everyone", now);
  }
}

export interface AutoFillInvitee {
  accountId: string;
  /** The record they are invited as - their highest-tier one at this shop. */
  clientId: string;
  /** Null for a client with no rewards tier yet (told in the everyone stage only). */
  tier: LoyaltyTier | null;
}

/**
 * Who Auto-fill may offer a time to: My ChairBack accounts actively linked
 * to a live (not archived), unblocked record at THIS shop - whose tier
 * qualifies, when a tier is asked for (Gold's head start); any tier, or none,
 * when it is not (everyone) - never a demo account, and then, because nobody
 * chose these people by hand:
 *
 *   - never the person who just cancelled it - through ANY record of theirs
 *     here, matched by the record they cancelled or its email (never a phone
 *     alone: a shared phone is not the same person);
 *   - never someone already invited to this opening, or already chosen in
 *     this run's everyone stage;
 *   - never someone the shop has blocked, by record, phone or email;
 *   - never someone who already has an upcoming visit here: an extra
 *     appointment is not what they asked for;
 *   - only someone a push can reach: their own push switch on, and a phone
 *     registered to their account;
 *   - and at most CAP_PER_DAY invitations in 24 hours and CAP_PER_WEEK in 7
 *     days from this shop, counting manual openings and everyone-stage
 *     pushes too. Read under the
 *     shop's wloffer lock, which every invitation is written under.
 *
 * Runs on an owner transaction: the links, devices and invitations are
 * platform-owned.
 */
export async function autoFillInvitees(
  tx: Prisma.TransactionClient,
  p: {
    shopId: string;
    /** The lowest tier invited; null = every client, tier or not. */
    minTier: LoyaltyTier | null;
    canceller: { clientId: string | null; email: string | null };
    /** Leave out everyone already invited to this opening. */
    openingId: string | null;
    /** Leave out everyone already chosen in this run's everyone stage. */
    runId?: string | null;
    now: Date;
  },
): Promise<AutoFillInvitee[]> {
  const rank = (t: LoyaltyTier | null) => (t ? ["BRONZE", "SILVER", "GOLD"].indexOf(t) : -1);
  const links = await tx.customerClientLink.findMany({
    where: {
      shopId: p.shopId,
      status: "active",
      account: { isDemo: false, pushEnabled: true },
      client: {
        shopId: p.shopId,
        archivedAt: null,
        bookingBlockedAt: null,
        ...(p.minTier ? { loyaltyTier: { in: tiersAtOrAbove(p.minTier) } } : {}),
      },
    },
    orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
    select: {
      accountId: true,
      clientId: true,
      client: { select: { loyaltyTier: true, phone: true, email: true } },
    },
  });
  if (links.length === 0) return [];
  const best = new Map<string, { clientId: string; tier: LoyaltyTier | null; phone: string | null; email: string | null }>();
  for (const l of links) {
    const tier = l.client.loyaltyTier ?? null;
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

  const weekAgo = new Date(p.now.getTime() - 7 * 24 * 60 * 60_000);
  const [already, chosen, blocks, upcoming, devices, recent, recentEveryone] = await Promise.all([
    p.openingId
      ? tx.tierOpeningRecipient.findMany({ where: { openingId: p.openingId }, select: { accountId: true } })
      : Promise.resolve([] as { accountId: string }[]),
    p.runId
      ? tx.autoFillRecipient.findMany({ where: { runId: p.runId }, select: { accountId: true } })
      : Promise.resolve([] as { accountId: string }[]),
    loadBookingBlocks(tx, p.shopId),
    clientsWithUpcomingBooking(tx, p.shopId, [...new Set(allLinks.map((l) => l.clientId))], p.now),
    tx.customerDevice.findMany({ where: { accountId: { in: accountIds } }, select: { accountId: true } }),
    tx.tierOpeningRecipient.findMany({
      where: {
        accountId: { in: accountIds },
        createdAt: { gt: weekAgo },
        opening: { shopId: p.shopId },
        // An invitation that was never delivered does not count against them;
        // one not sent yet does, because it is about to be.
        OR: [{ delivered: true }, { notifiedAt: null }],
      },
      select: { accountId: true, createdAt: true },
    }),
    // An everyone-stage push counts the same way: one opening, one push.
    tx.autoFillRecipient.findMany({
      where: {
        accountId: { in: accountIds },
        shopId: p.shopId,
        createdAt: { gt: weekAgo },
        OR: [{ delivered: true }, { notifiedAt: null }],
      },
      select: { accountId: true, createdAt: true },
    }),
  ]);
  for (const a of already) out.add(a.accountId);
  for (const a of chosen) out.add(a.accountId);
  const reachable = new Set(devices.map((d) => d.accountId));
  const dayAgo = p.now.getTime() - 24 * 60 * 60_000;
  const perDay = new Map<string, number>();
  const perWeek = new Map<string, number>();
  for (const r of [...recent, ...recentEveryone]) {
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
