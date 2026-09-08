import { createHash } from "node:crypto";
import type { Prisma } from "@chairback/db";
import { zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";

/**
 * Blocking whole shop-local DAYS, and what a block finds already sitting on
 * the calendar.
 *
 * ── DAYS, NOT INSTANTS ───────────────────────────────────────────────────────
 *
 * "Block off September 9 through 16" is a statement about calendar days in
 * the SHOP's zone, so the API takes the two day keys and resolves the instants
 * here, where the shop's timezone is known and cannot be second-guessed by a
 * device in another zone. Each day becomes ONE AvailabilityException row from
 * its local midnight to the next local midnight - so a range is a run of
 * contiguous rows whose union is exactly "midnight on the first day through
 * midnight after the last", and daylight-saving days come out 23 or 25 hours
 * long because every edge is resolved per instant by zonedWallTimeToUtc.
 *
 * One row PER DAY rather than one row for the range, on purpose: every reader
 * of this table is day-shaped. The agenda lists a block on the day it STARTS
 * (a single eight-day row would show on the 9th and vanish from the 10th), the
 * calendar buckets rows by start day, the utilization maths clips per day, and
 * "Unblock" on a band removes that band. Per-day rows make a vacation appear
 * on every day it covers and let a barber give back Thursday without giving
 * back the week.
 *
 * ── A BLOCK NEVER TOUCHES AN APPOINTMENT ─────────────────────────────────────
 *
 * Blocking time that already holds a booking is allowed - the barber may be
 * recording a day he will spend on that one client, or planning to move
 * things by hand - but never silently. The first attempt answers 409 with the
 * bookings it found and a `confirmation` digest of exactly those rows; the
 * block is written only when that digest comes back. The appointments
 * themselves are never cancelled, moved or edited by this path: the block only
 * stops NEW bookings around them. Same shape as the external-block override
 * in engines/bookingWrite.ts, for the same reason: a boolean would authorise
 * whatever happened to be in the way when the write landed, not what the
 * barber was shown.
 */

/** A vacation is a year at most. Also caps the rows one request may write. */
export const MAX_BLOCK_DAYS = 366;

export interface DayKeyParts {
  year: number;
  month0: number;
  day: number;
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "YYYY-MM-DD" -> its parts, or null when the string is not a real calendar
 * date. A regex accepts "2026-02-30"; only the Date.UTC round trip refuses it.
 */
export function parseDayKey(key: string): DayKeyParts | null {
  const m = DAY_KEY_RE.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (year < 1970 || year > 2200) return null;
  const probe = new Date(Date.UTC(year, month0, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month0 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month0, day };
}

export function dayKeyOf(p: DayKeyParts): string {
  const mm = String(p.month0 + 1).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/** Today's day key in the shop's zone. */
export function todayKeyIn(now: Date, timezone: string): string {
  return dayKeyOf(zonedDateParts(now, timezone));
}

export interface DaySpan {
  dayKey: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Every shop-local day in [from, to] (inclusive), each as local midnight ->
 * the NEXT local midnight. The walk steps in UTC day numbers so month and year
 * boundaries roll over by arithmetic; the edges are resolved in the shop's zone
 * so a DST day is exactly as long as it really is.
 */
export function allDaySpans(from: DayKeyParts, to: DayKeyParts, timezone: string): DaySpan[] {
  const out: DaySpan[] = [];
  const first = Date.UTC(from.year, from.month0, from.day);
  const last = Date.UTC(to.year, to.month0, to.day);
  for (let t = first; t <= last; t += 24 * 60 * 60_000) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m0 = d.getUTCMonth();
    const day = d.getUTCDate();
    out.push({
      dayKey: dayKeyOf({ year: y, month0: m0, day }),
      startsAt: zonedWallTimeToUtc(y, m0, day, 0, timezone),
      // day+1 rather than minute 1440 of the same day: Date.UTC normalises the
      // overflow into the next month/year, and resolving the NEXT day's
      // midnight is what keeps a 23h/25h DST day exactly that long.
      endsAt: zonedWallTimeToUtc(y, m0, day + 1, 0, timezone),
    });
  }
  return out;
}

export type DayRangePlan =
  | { ok: true; spans: DaySpan[] }
  | { ok: false; field: "fromDate" | "toDate"; message: string };

/**
 * Validate a requested day range and resolve it to per-day spans. Refuses a
 * malformed or impossible date, an inverted range, a range longer than a
 * year, and a range that has already ended - a block on days that are gone
 * can do nothing, so asking for one is a mistake worth naming.
 */
export function planAllDayBlock(input: {
  fromDate: string;
  toDate: string;
  timezone: string;
  now: Date;
}): DayRangePlan {
  const from = parseDayKey(input.fromDate);
  if (!from) return { ok: false, field: "fromDate", message: "Pick a real start date." };
  const to = parseDayKey(input.toDate);
  if (!to) return { ok: false, field: "toDate", message: "Pick a real end date." };
  if (input.toDate < input.fromDate) {
    return { ok: false, field: "toDate", message: "The end date must be on or after the start date." };
  }
  const today = todayKeyIn(input.now, input.timezone);
  if (input.toDate < today) {
    return { ok: false, field: "toDate", message: "Those days have already passed." };
  }
  const spans = allDaySpans(from, to, input.timezone);
  if (spans.length > MAX_BLOCK_DAYS) {
    return {
      ok: false,
      field: "toDate",
      message: `Block up to ${MAX_BLOCK_DAYS} days at a time.`,
    };
  }
  return { ok: true, spans };
}

/** An appointment a block would sit on top of. */
export interface BlockConflictRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: "BOOKED" | "PENDING";
  firstName: string;
  lastName: string | null;
  serviceName: string;
}

/** How many conflicts one refusal lists in full; the digest covers them all. */
export const CONFLICTS_DESCRIBED = 10;
const CONFLICTS_READ = 200;

/**
 * The bookings on THIS chair that overlap [startsAt, endsAt): confirmed ones
 * and live requests/holds (a PENDING row whose hold has lapsed no longer
 * holds anything and is not in anyone's way). Read inside the caller's
 * transaction, under the same per-staff advisory lock every appointment
 * write takes, so the list is exact as of commit.
 */
export async function findAppointmentsInSpan(
  tx: Prisma.TransactionClient,
  input: { shopId: string; staffId: string; startsAt: Date; endsAt: Date; now: Date },
): Promise<BlockConflictRow[]> {
  const rows = await tx.appointment.findMany({
    where: {
      shopId: input.shopId,
      staffId: input.staffId,
      startsAt: { lt: input.endsAt },
      endsAt: { gt: input.startsAt },
      OR: [
        { status: "BOOKED" },
        {
          status: "PENDING",
          OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: input.now } }],
        },
      ],
    },
    orderBy: { startsAt: "asc" },
    take: CONFLICTS_READ,
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      firstName: true,
      lastName: true,
      service: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    status: r.status === "PENDING" ? "PENDING" : "BOOKED",
    firstName: r.firstName,
    lastName: r.lastName,
    serviceName: r.service.name,
  }));
}

/**
 * The digest that authorises blocking over EXACTLY these bookings. Ids and
 * spans, sorted, so the same conflict always yields the same answer on every
 * replica with no shared state; a booking that moved, was cancelled, or
 * arrived since changes it. A binding, not a secret - the router's
 * requireManager is what authorises the write.
 */
export function blockOverAppointmentsConfirmation(rows: BlockConflictRow[]): string {
  const canonical = rows
    .map((r) => `${r.id}|${r.startsAt.toISOString()}|${r.endsAt.toISOString()}`)
    .sort()
    .join(";");
  return createHash("sha256")
    .update(`block_over_appointments:v1:${canonical}`)
    .digest("hex")
    .slice(0, 32);
}

/** The one-line headline of a refusal: how many, and that nothing moves. */
export function appointmentConflictSentence(rows: BlockConflictRow[]): string {
  const n = rows.length;
  return n === 1
    ? "1 appointment is already booked during this time."
    : `${n} appointments are already booked during this time.`;
}

/**
 * One line per booking, in the SHOP's zone, formatted here so every surface
 * says it the same way and the page never has to rebuild it from instants.
 * "Tue, Sep 10, 2:00–2:30 PM · Marcus Reed · Fade". Requests are marked; past
 * the first CONFLICTS_DESCRIBED a count stands in for the rest.
 */
export function describeAppointmentConflicts(
  rows: BlockConflictRow[],
  timezone: string,
): string[] {
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  });
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  const lines = rows.slice(0, CONFLICTS_DESCRIBED).map((r) => {
    const who = [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || "Client";
    const request = r.status === "PENDING" ? " (request)" : "";
    return `${day.format(r.startsAt)}, ${time.format(r.startsAt)}–${time.format(r.endsAt)} · ${who} · ${r.serviceName}${request}`;
  });
  const rest = rows.length - lines.length;
  if (rest > 0) lines.push(`+${rest} more`);
  return lines;
}
