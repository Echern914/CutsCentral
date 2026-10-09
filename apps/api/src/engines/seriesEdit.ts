import { createHash } from "node:crypto";
import { Prisma } from "@chairback/db";
import { localMinutesOfDay, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { isSlotBookable } from "./slots.js";
import {
  ExternalBlockError,
  HeldSlotError,
  lockStaffAndAssertSlotFree,
  OverlapError,
  SlotTakenError,
} from "./bookingWrite.js";
import { effectiveDurationAt } from "./pricing.js";
import { appointmentOwnedByPlatform } from "./visitOrigin.js";
import { swapForReschedule } from "./acuityMirror.js";
import { blockSentence, describeOverlap, holdSentence } from "../services/appointmentOverride.js";
import { decimalToCents } from "../services/appointmentPriceLedger.js";

/**
 * EDIT "THIS AND FUTURE" APPOINTMENTS OF A REPEAT - start time, service and
 * provider, nothing else.
 *
 * A repeat is a rule row plus ordinary Appointment rows, and nothing reads the
 * rule's time, service or provider after the rows are made - so an edit is
 * made to the ROWS, judged against the appointment it was started from (the
 * anchor), and the rule is left alone.
 *
 * What is never changed, whatever is asked:
 *  - anything before the anchor, or already over;
 *  - completed, cancelled and no-show visits;
 *  - a visit still waiting for confirmation (a request, or a card step);
 *  - a visit owned by Acuity/Square;
 *  - the PRICE. A different service keeps each visit's price; prices are
 *    changed one visit at a time, where a saved card and a paid booking are
 *    checked (booking.appointmentEdit.ts). Nothing here charges anything.
 * And, unless the barber includes them on purpose: a visit that was already
 * changed on its own (its time, service or provider no longer matches the
 * anchor's) - a deliberate exception is not overwritten by accident.
 *
 * ALL OR NOTHING. Every visit that would change is checked with the same
 * guard a single edit uses (hours unless Custom time, other bookings, blocked
 * time, live holds). One problem anywhere refuses the whole change and names
 * the date; nothing is half-applied. The preview a barber confirmed is pinned
 * by a digest of those rows: if any changed since, the apply is refused and
 * shown again rather than doing something he did not see.
 */

export interface SeriesEditChanges {
  /** New shop-local start time, minutes after midnight. Same day of the week. */
  startMin?: number;
  serviceId?: string;
  staffId?: string;
}

export interface SeriesEditRequest {
  shopId: string;
  timezone: string;
  bufferMin: number;
  seriesId: string;
  fromAppointmentId: string;
  changes: SeriesEditChanges;
  /** Also change visits already changed on their own. */
  includeExceptions: boolean;
  /** Skip the open-times check (the barber's override); overlap still applies. */
  customTime: boolean;
  now: Date;
}

export type SeriesSkipReason =
  | "past"
  | "completed"
  | "cancelled"
  | "not_confirmed"
  | "external"
  | "edited_on_its_own";

export interface SeriesSlotProblem {
  code: "outside_open_times" | "overlap" | "blocked" | "held" | "taken";
  text: string;
}

export interface PlannedVisit {
  id: string;
  from: { startsAt: Date; endsAt: Date; staffId: string; serviceId: string };
  to: { startsAt: Date; endsAt: Date; staffId: string; serviceId: string };
  /** The time or the provider changes - the client would notice. */
  clientVisible: boolean;
  /**
   * What this visit was booked at, and still costs after the change: a
   * different service never re-prices it (the single edit doesn't either).
   * Shown in the review so the barber sees the price stay, not assumes it.
   */
  bookedPriceCents: number | null;
  emailedBefore: boolean;
  problem?: SeriesSlotProblem;
}

export interface SeriesEditPlan {
  anchorId: string;
  change: PlannedVisit[];
  skipped: { id: string; startsAt: Date; reason: SeriesSkipReason }[];
  /** Visits already exactly as asked (a retry of an applied change). */
  alreadyDone: number;
  digest: string;
}

export class SeriesEditError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "anchor_not_editable"
      | "nothing_to_change"
      | "service_not_found"
      | "staff_not_found"
      | "staff_does_not_offer_service",
  ) {
    super(code);
  }
}

/** The preview the barber confirmed no longer matches the rows. */
export class SeriesStaleError extends Error {
  constructor() {
    super("stale_preview");
  }
}

/** At least one visit cannot take the change; nothing was written. */
export class SeriesConflictError extends Error {
  constructor(public readonly plan: SeriesEditPlan) {
    super("series_conflict");
  }
}

const isoMin = (d: Date) => d.toISOString();

/**
 * Work out exactly which visits would change and to what. Reads only. Call
 * inside the transaction that will write, after locking the series' rows, so
 * the plan cannot move under the apply.
 */
export async function planSeriesEdit(
  tx: Prisma.TransactionClient,
  req: SeriesEditRequest,
): Promise<SeriesEditPlan> {
  const { changes, timezone } = req;
  if (changes.startMin === undefined && !changes.serviceId && !changes.staffId) {
    throw new SeriesEditError("nothing_to_change");
  }
  const series = await tx.recurringSeries.findFirst({
    where: { id: req.seriesId, shopId: req.shopId },
    select: { id: true },
  });
  if (!series) throw new SeriesEditError("not_found");

  const anchor = await tx.appointment.findFirst({
    where: { id: req.fromAppointmentId, shopId: req.shopId, seriesId: series.id },
    select: { id: true, startsAt: true, endsAt: true, staffId: true, serviceId: true, status: true },
  });
  if (!anchor) throw new SeriesEditError("not_found");
  if (anchor.status !== "BOOKED" || anchor.startsAt <= req.now) {
    throw new SeriesEditError("anchor_not_editable");
  }

  const serviceId = changes.serviceId ?? anchor.serviceId;
  const staffId = changes.staffId ?? anchor.staffId;
  const service = await tx.service.findFirst({
    where: { id: serviceId, shopId: req.shopId, active: true },
    select: { id: true, durationMin: true, durationOverrides: true, timeOverrides: true },
  });
  if (!service) throw new SeriesEditError("service_not_found");
  const staff = await tx.staff.findFirst({
    where: { id: staffId, shopId: req.shopId, active: true },
    select: { id: true },
  });
  if (!staff) throw new SeriesEditError("staff_not_found");
  const offers = await tx.serviceStaff.findFirst({
    where: { shopId: req.shopId, serviceId, staffId },
    select: { id: true },
  });
  if (!offers) throw new SeriesEditError("staff_does_not_offer_service");

  const rows = await tx.appointment.findMany({
    where: { shopId: req.shopId, seriesId: series.id, startsAt: { gte: anchor.startsAt } },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      staffId: true,
      serviceId: true,
      status: true,
      updatedAt: true,
      priceAtBooking: true,
      confirmationEmailSentAt: true,
      reminderEmailSentAt: true,
      visit: { select: { acuityAppointmentId: true } },
    },
  });

  const anchorMin = localMinutesOfDay(anchor.startsAt, timezone);
  const anchorLength = anchor.endsAt.getTime() - anchor.startsAt.getTime();
  const change: PlannedVisit[] = [];
  const skipped: SeriesEditPlan["skipped"] = [];
  let alreadyDone = 0;
  const digestParts: unknown[] = [req.changes, req.includeExceptions, req.customTime];

  for (const row of rows) {
    if (row.status === "COMPLETED") {
      skipped.push({ id: row.id, startsAt: row.startsAt, reason: "completed" });
      continue;
    }
    if (row.status === "CANCELED" || row.status === "NO_SHOW") {
      skipped.push({ id: row.id, startsAt: row.startsAt, reason: "cancelled" });
      continue;
    }
    if (row.startsAt <= req.now) {
      skipped.push({ id: row.id, startsAt: row.startsAt, reason: "past" });
      continue;
    }
    if (row.status !== "BOOKED") {
      skipped.push({ id: row.id, startsAt: row.startsAt, reason: "not_confirmed" });
      continue;
    }
    if (appointmentOwnedByPlatform({ visit: row.visit })) {
      skipped.push({ id: row.id, startsAt: row.startsAt, reason: "external" });
      continue;
    }

    // Where this visit lands: its OWN shop-local date, at the new (or its own)
    // time of day - rebuilt per date, so a daylight-saving change between
    // visits never moves the wall-clock time.
    const p = zonedDateParts(row.startsAt, timezone);
    const ownMin = localMinutesOfDay(row.startsAt, timezone);
    const startMin = changes.startMin ?? ownMin;
    const startsAt = zonedWallTimeToUtc(p.year, p.month0, p.day, startMin, timezone);
    const lengthMin = changes.serviceId
      ? effectiveDurationAt(service.durationMin, {
          at: startsAt,
          timezone,
          weekdayOverrides: service.durationOverrides,
          timeWindows: service.timeOverrides,
        })
      : Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000);
    const endsAt = new Date(startsAt.getTime() + lengthMin * 60_000);
    const to = { startsAt, endsAt, staffId, serviceId };

    const unchanged =
      startsAt.getTime() === row.startsAt.getTime() &&
      endsAt.getTime() === row.endsAt.getTime() &&
      staffId === row.staffId &&
      serviceId === row.serviceId;
    if (unchanged) {
      alreadyDone++;
      continue;
    }

    // A visit changed on its own earlier no longer looks like the anchor did.
    // It is left as it is unless the barber includes it on purpose.
    const matchesAnchor =
      row.staffId === anchor.staffId &&
      row.serviceId === anchor.serviceId &&
      ownMin === anchorMin &&
      row.endsAt.getTime() - row.startsAt.getTime() === anchorLength;
    if (!matchesAnchor && !req.includeExceptions) {
      skipped.push({ id: row.id, startsAt: row.startsAt, reason: "edited_on_its_own" });
      continue;
    }

    change.push({
      id: row.id,
      from: { startsAt: row.startsAt, endsAt: row.endsAt, staffId: row.staffId, serviceId: row.serviceId },
      to,
      clientVisible: startsAt.getTime() !== row.startsAt.getTime() || staffId !== row.staffId,
      bookedPriceCents: decimalToCents(row.priceAtBooking),
      emailedBefore: row.confirmationEmailSentAt !== null || row.reminderEmailSentAt !== null,
    });
    digestParts.push([row.id, isoMin(row.updatedAt), isoMin(startsAt), isoMin(endsAt), staffId, serviceId]);
  }

  const digest = createHash("sha256").update(JSON.stringify(digestParts)).digest("hex").slice(0, 32);
  return { anchorId: anchor.id, change, skipped, alreadyDone, digest };
}

/**
 * Check every visit that would change, with the guard a single edit uses, and
 * mark each one's problem. Takes the provider's booking lock(s), so it runs in
 * the writing transaction; a preview runs it in one that is rolled back.
 */
export async function checkSeriesEdit(
  tx: Prisma.TransactionClient,
  req: SeriesEditRequest,
  plan: SeriesEditPlan,
): Promise<boolean> {
  let clean = true;
  for (const visit of plan.change) {
    const timeMoved =
      visit.to.startsAt.getTime() !== visit.from.startsAt.getTime() ||
      visit.to.endsAt.getTime() !== visit.from.endsAt.getTime() ||
      visit.to.staffId !== visit.from.staffId;
    if (!timeMoved) continue; // a service change at the same time and length
    if (!req.customTime) {
      const service = await tx.service.findFirst({
        where: { id: visit.to.serviceId, shopId: req.shopId },
        select: { durationMin: true },
      });
      const lengthMin = Math.round((visit.to.endsAt.getTime() - visit.to.startsAt.getTime()) / 60_000);
      const open = await isSlotBookable({
        shopId: req.shopId,
        staffId: visit.to.staffId,
        serviceId: visit.to.serviceId,
        startsAt: visit.to.startsAt,
        now: req.now,
        excludeAppointmentId: visit.id,
        extraDurationMin: Math.max(0, lengthMin - (service?.durationMin ?? lengthMin)),
        // The barber's own repeat: the online horizon does not bind it.
        ignoreHorizon: true,
      });
      if (!open) {
        visit.problem = { code: "outside_open_times", text: "Outside the open times for that day." };
        clean = false;
        continue;
      }
    }
    try {
      await lockStaffAndAssertSlotFree(tx, {
        externalBlocks: "enforce",
        externalBlockConfirmation: null,
        walkInCapacity: "ignore",
        staffId: visit.to.staffId,
        shopId: req.shopId,
        startsAt: visit.to.startsAt,
        endsAt: visit.to.endsAt,
        bufferMin: req.bufferMin,
        excludeAppointmentId: visit.id,
        statuses: ["BOOKED", "PENDING"],
        serviceDayLimit: null,
        overrideWaitlistHolds: true,
        overlapConfirmation: null,
      });
    } catch (err) {
      clean = false;
      if (err instanceof OverlapError) {
        // Named, like the single edit's refusal: who or what is in the way.
        const described = await describeOverlap(req.shopId, err.rows, req.timezone);
        visit.problem = {
          code: "overlap",
          text: described.lines.length ? `Overlaps ${described.lines.join("; ")}` : described.reason,
        };
      } else if (err instanceof ExternalBlockError) {
        visit.problem = { code: "blocked", text: blockSentence(err.blocks, req.timezone) };
      } else if (err instanceof HeldSlotError) {
        visit.problem = { code: "held", text: holdSentence(err.heldUntil, req.timezone) };
      } else if (err instanceof SlotTakenError) {
        visit.problem = { code: "taken", text: "That time is already taken." };
      } else {
        throw err;
      }
    }
  }
  return clean;
}

/**
 * Write the change to every planned visit and record each one's calendar
 * move. In the transaction that planned and checked it. Returns the mirror
 * outbox ids per visit, for completeReschedule after commit.
 */
export async function writeSeriesEdit(
  tx: Prisma.TransactionClient,
  req: SeriesEditRequest,
  plan: SeriesEditPlan,
): Promise<Map<string, string[]>> {
  const outbox = new Map<string, string[]>();
  for (const visit of plan.change) {
    const timeMoved =
      visit.to.startsAt.getTime() !== visit.from.startsAt.getTime() ||
      visit.to.endsAt.getTime() !== visit.from.endsAt.getTime() ||
      visit.to.staffId !== visit.from.staffId;
    await tx.appointment.update({
      where: { id: visit.id },
      data: {
        staffId: visit.to.staffId,
        serviceId: visit.to.serviceId,
        startsAt: visit.to.startsAt,
        endsAt: visit.to.endsAt,
        // Same send-state rules as a single edit: what the client can see
        // changed, so every message about this visit is due again.
        ...(visit.clientVisible ? { confirmationEmailSentAt: null, reminderEmailSentAt: null } : {}),
        ...(timeMoved
          ? {
              confirmationSentAt: null,
              reminderSentAt: null,
              reminder24hPushSentAt: null,
              reminder2hPushSentAt: null,
              checkInStatus: null,
              checkedInAt: null,
              etaMinutes: null,
              runningLate: false,
              overlapForcedAt: null,
              overlapForcedByUserId: null,
            }
          : {}),
      },
    });
    if (timeMoved) {
      outbox.set(
        visit.id,
        await swapForReschedule(tx, {
          shopId: req.shopId,
          now: req.now,
          appointmentId: visit.id,
          staffId: visit.to.staffId,
          startsAt: visit.to.startsAt,
          endsAt: visit.to.endsAt,
          occupancy: {
            status: "BOOKED",
            startsAt: visit.to.startsAt,
            endsAt: visit.to.endsAt,
            holdExpiresAt: null,
            visitId: null,
          },
        }),
      );
    }
  }
  return outbox;
}
