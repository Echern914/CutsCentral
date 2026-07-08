import {
  addDays,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "@chairback/config";
import { prisma, Prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { isSlotBookable } from "./slots.js";
import { effectivePriceForDate } from "./pricing.js";

/**
 * Recurring-appointment series generation.
 *
 * The rule is stored SHOP-LOCAL (weekday + minutes-from-local-midnight). Each
 * occurrence's concrete UTC instant is recomputed per date via zonedWallTimeToUtc
 * so a "9:00 Tuesday" stays 9:00 local across a DST boundary (13:00Z in winter,
 * 14:00Z in summer) instead of drifting an hour if we naively added 7*24h in UTC.
 *
 * Each occurrence is materialized as a normal Appointment row (seriesId FK) in
 * its OWN transaction, so reminders / promotion / loyalty / slot-opened work
 * unchanged, and a conflict on one occurrence (already booked, blocked day,
 * DST-gap slot, out of horizon) parks THAT occurrence and continues - never
 * fails the whole batch. The caller surfaces the skip report.
 */

// Hard caps (also enforced at the zod boundary) so a bad rule can't generate a
// runaway series.
export const MAX_OCCURRENCES = 52;
const MS_PER_MIN = 60_000;

export interface RecurrencePattern {
  interval: number; // every N weeks (>=1)
  weekday: number; // 0=Sun..6=Sat, shop-local
  startMin: number; // minutes from shop-local midnight
  count?: number; // exactly one of count / untilDate
  untilDate?: Date;
}

export interface OccurrenceInstant {
  index: number; // 0-based position in the series
  startsAt: Date; // UTC instant
}

/**
 * Compute the list of occurrence instants for a series, DST-correctly. `anchor`
 * is the first occurrence's instant (occurrence 0 - already a valid bookable
 * time). Subsequent occurrences advance the shop-LOCAL calendar date by
 * interval*7 days and re-derive the instant at the same local wall time.
 */
export function computeOccurrences(
  pattern: RecurrencePattern,
  anchor: Date,
  timezone: string,
): OccurrenceInstant[] {
  const anchorParts = zonedDateParts(anchor, timezone);
  // A stable noon-local instant for the anchor date. Doing day arithmetic from
  // noon (not the appointment's own hour) means adding whole days can never slip
  // across a midnight DST transition and lose/gain a day.
  const anchorNoonLocal = zonedWallTimeToUtc(
    anchorParts.year,
    anchorParts.month0,
    anchorParts.day,
    12 * 60,
    timezone,
  );

  const hardMax = pattern.count ?? MAX_OCCURRENCES;
  const out: OccurrenceInstant[] = [];
  for (let k = 0; k < Math.min(hardMax, MAX_OCCURRENCES); k++) {
    // Advance the LOCAL date by interval*7*k days from the noon anchor, then
    // re-read Y/M/D in the shop zone and rebuild the wall-clock instant.
    const localDate = addDays(anchorNoonLocal, pattern.interval * 7 * k);
    const p = zonedDateParts(localDate, timezone);
    const startsAt = zonedWallTimeToUtc(
      p.year,
      p.month0,
      p.day,
      pattern.startMin,
      timezone,
    );
    // untilDate terminates the series (inclusive of that day). Stop once an
    // occurrence would start after it.
    if (pattern.untilDate && startsAt.getTime() > pattern.untilDate.getTime()) {
      break;
    }
    out.push({ index: k, startsAt });
  }
  return out;
}

export type SkipReason =
  | "slot_taken"
  | "not_bookable"
  | "outside_horizon"
  | "error";

export interface SeriesResult {
  seriesId: string;
  booked: { index: number; startsAt: Date; appointmentId: string }[];
  skipped: { index: number; startsAt: Date; reason: SkipReason }[];
}

export interface MaterializeInput {
  shopId: string;
  staffId: string;
  serviceId: string;
  clientId: string;
  // Booker snapshot (already resolved by the caller).
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  // Service facts for end/price computation.
  durationMin: number;
  basePrice: number | null;
  priceOverrides: unknown;
  // Shop facts.
  timezone: string;
  bookingBufferMin: number;
  // Gate each occurrence on isSlotBookable (hours/exceptions). false = barber
  // customTime force (overlap is ALWAYS enforced regardless). Matches the
  // single-create dashboard path, which only checks isSlotBookable when not
  // customTime and never enforces lead/max bounds for the barber.
  checkAvailability: boolean;
  pattern: RecurrencePattern;
  anchor: Date; // occurrence 0's instant
  now?: Date;
}

/**
 * Create the RecurringSeries row + every occurrence Appointment. Each occurrence
 * runs the full write-path guard (advisory lock + buffer overlap) in its own
 * transaction; conflicts are skipped and reported, never fatal. The client is
 * already resolved (single upsert by the caller). Returns booked + skipped.
 */
export async function materializeSeries(
  input: MaterializeInput,
): Promise<SeriesResult> {
  const now = input.now ?? new Date();
  const occurrences = computeOccurrences(input.pattern, input.anchor, input.timezone);

  // Create the series row first (owner-scoped inside runWithShop so RLS + the
  // shopId stamp are correct). manageToken enables a login-less "cancel all".
  const series = await runWithShop(input.shopId, (tx) =>
    tx.recurringSeries.create({
      data: {
        shopId: input.shopId,
        staffId: input.staffId,
        serviceId: input.serviceId,
        clientId: input.clientId,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        email: input.email,
        interval: input.pattern.interval,
        weekday: input.pattern.weekday,
        startMin: input.pattern.startMin,
        count: input.pattern.count ?? null,
        untilDate: input.pattern.untilDate ?? null,
        manageToken: randomToken(),
      },
      select: { id: true },
    }),
  );

  const booked: SeriesResult["booked"] = [];
  const skipped: SeriesResult["skipped"] = [];
  const bufferMs = Math.max(0, input.bookingBufferMin) * MS_PER_MIN;

  for (const occ of occurrences) {
    const startsAt = occ.startsAt;
    const endsAt = new Date(startsAt.getTime() + input.durationMin * MS_PER_MIN);

    // Occurrences in the past are always skipped (a "3pm Tuesday" pattern whose
    // anchor is today shouldn't try to book an already-elapsed occurrence 0).
    if (startsAt.getTime() <= now.getTime()) {
      skipped.push({ index: occ.index, startsAt, reason: "outside_horizon" });
      continue;
    }
    // Availability (hours/exceptions). A DST-gap slot that doesn't match the grid
    // also fails here and is reported, not fatal. Skipped for barber customTime.
    if (input.checkAvailability) {
      const bookable = await isSlotBookable({
        shopId: input.shopId,
        staffId: input.staffId,
        serviceId: input.serviceId,
        startsAt,
        now,
      });
      if (!bookable) {
        skipped.push({ index: occ.index, startsAt, reason: "not_bookable" });
        continue;
      }
    }

    const price = effectivePriceForDate(
      input.basePrice,
      input.priceOverrides,
      startsAt,
      input.timezone,
    );

    try {
      const appt = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`appt:${input.staffId}`}))`,
        );
        const overlapStart = new Date(startsAt.getTime() - bufferMs);
        const overlapEnd = new Date(endsAt.getTime() + bufferMs);
        const overlap = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT id FROM "Appointment"
                     WHERE "staffId" = ${input.staffId}
                       AND "status" IN ('BOOKED', 'PENDING')
                       AND "startsAt" < ${overlapEnd}
                       AND "endsAt" > ${overlapStart}`,
        );
        if (overlap.length > 0) throw new Error("slot_taken");
        return tx.appointment.create({
          data: {
            shopId: input.shopId,
            staffId: input.staffId,
            serviceId: input.serviceId,
            clientId: input.clientId,
            firstName: input.firstName || "Client",
            lastName: input.lastName,
            phone: input.phone,
            email: input.email,
            status: "BOOKED",
            startsAt,
            endsAt,
            priceAtBooking: price ?? undefined,
            manageToken: randomToken(),
            seriesId: series.id,
            seriesOccurrenceIndex: occ.index,
          },
          select: { id: true },
        });
      });
      booked.push({ index: occ.index, startsAt, appointmentId: appt.id });
    } catch (err) {
      const msg = (err as Error).message;
      // slot_taken (our overlap throw) or P2002 (exact-start unique backstop,
      // incl. a series colliding with itself on a bad cadence) => skip, not fail.
      if (
        msg === "slot_taken" ||
        (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      ) {
        skipped.push({ index: occ.index, startsAt, reason: "slot_taken" });
      } else {
        logger.error(
          { err, shopId: input.shopId, seriesId: series.id, index: occ.index },
          "recurring occurrence create failed",
        );
        skipped.push({ index: occ.index, startsAt, reason: "error" });
      }
    }
  }

  // If nothing landed in the future / everything conflicted, the series is
  // effectively dead on arrival - mark it ENDED so it isn't shown as active.
  if (booked.length === 0) {
    await runWithShop(input.shopId, (tx) =>
      tx.recurringSeries.update({
        where: { id: series.id },
        data: { status: "ENDED" },
      }),
    ).catch(() => {});
  }

  return { seriesId: series.id, booked, skipped };
}
