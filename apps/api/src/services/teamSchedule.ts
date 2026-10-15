import { runAsOwner, runWithShop } from "@chairback/db";
import { addDays, zonedDateKey, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { mergeRanges, subtractRanges, type TimeRange } from "../engines/slots.js";
import { weekdayWindowsToRanges } from "../engines/blockedTime.js";
import { logger } from "../logger.js";
import { recordTeamEvent } from "./teamLinks.js";

/**
 * TEAM SCHEDULES: a member's day, for the team's owner - when they work, when
 * they're off, when they're booked, and so when they're free.
 *
 * 🔴 PRIVACY IS DECIDED HERE, NOT IN THE PAGE, exactly like teamNumbers. A
 * member who hasn't shared their schedule is never read at all. One who has
 * shares TIMES ONLY: a booked span carries no client, no service, no price and
 * no id, and time off carries no reason. The owner learns "booked 2:00-2:30",
 * never "Marcus, Skin fade".
 *
 * Read in the member's OWN shop (runWithShop on their id), with the same
 * sources the booking grid uses - weekly hours, one-off opens, standing breaks,
 * whole-chair block-offs, Acuity blocks, and what occupies the chair - so the
 * owner's "free now" can't disagree with what the member's booking page sells.
 * A block for SOME services only is not time off: the chair is still working.
 */

/** A span on the day, as ISO instants. */
export interface ScheduleSpan {
  start: string;
  end: string;
}

/** Where one chair is right now. Only on today's schedule. */
export type NowStatus =
  | { kind: "off" }
  | { kind: "starts"; at: string }
  | { kind: "free"; until: string }
  | { kind: "busy"; until: string }
  | { kind: "away"; until: string }
  | { kind: "done" };

/** One chair's day. A solo barber's business has one. */
export interface ChairDay {
  name: string;
  /** When they work: weekly hours plus one-off opens, within the day. */
  hours: ScheduleSpan[];
  /** When someone is in (or booked into) the chair - times only. */
  booked: ScheduleSpan[];
  /** Breaks and time off inside their hours - no reason. */
  off: ScheduleSpan[];
  /** Hours minus booked and off. */
  free: ScheduleSpan[];
  /** Today only; null on any other day. */
  now: NowStatus | null;
}

/** The raw rows one chair's day is built from (all already in the member's shop). */
export interface ChairDayInput {
  name: string;
  rules: { weekday: number; startMin: number; endMin: number }[];
  recurringBlocks: { weekday: number; startMin: number; endMin: number }[];
  /** One-off exceptions: opens (isBlock false) and blocks, with their service scope. */
  exceptions: { startsAt: Date; endsAt: Date; isBlock: boolean; serviceIds: string[] }[];
  /** Shop-wide Acuity blocks: they stop every chair. */
  externalBlocks: { startsAt: Date; endsAt: Date }[];
  /** What occupies this chair: appointments and synced visits. */
  occupied: { startsAt: Date; endsAt: Date }[];
}

const clip = (ranges: TimeRange[], from: number, to: number): TimeRange[] =>
  ranges
    .map((r) => ({ start: Math.max(r.start, from), end: Math.min(r.end, to) }))
    .filter((r) => r.end > r.start);

const iso = (ranges: TimeRange[]): ScheduleSpan[] =>
  ranges.map((r) => ({ start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() }));

const span = (s: { startsAt: Date; endsAt: Date }): TimeRange => ({
  start: s.startsAt.getTime(),
  end: s.endsAt.getTime(),
});

/**
 * Build one chair's day over [from, to) - pure, so every rule above is tested
 * without a database. `timezone` is the MEMBER's: their weekly hours are wall
 * clock in their own zone, whatever zone the team's owner reads them in.
 */
export function buildChairDay(
  input: ChairDayInput,
  window: { from: Date; to: Date },
  timezone: string,
  now: Date,
): ChairDay {
  const from = window.from.getTime();
  const to = window.to.getTime();

  const opens = input.exceptions.filter((e) => !e.isBlock).map(span);
  const hours = mergeRanges(
    clip([...weekdayWindowsToRanges(input.rules, from, to, timezone), ...opens], from, to),
  );

  // Off = standing breaks, WHOLE-chair block-offs and Acuity blocks, inside
  // their hours (a break outside them changes nothing anyone can see).
  const blocks = input.exceptions
    .filter((e) => e.isBlock && e.serviceIds.length === 0)
    .map(span);
  const offRaw = [
    ...weekdayWindowsToRanges(input.recurringBlocks, from, to, timezone),
    ...blocks,
    ...input.externalBlocks.map(span),
  ];
  const booked = mergeRanges(clip(input.occupied.map(span), from, to));
  // Booked time wins over off where both claim a minute: someone is in the
  // chair, so "booked" is what's true.
  const off = subtractRanges(
    hours.flatMap((h) => clip(offRaw, h.start, h.end)),
    booked,
  );
  const free = subtractRanges(hours, [...booked, ...off]);

  const t = now.getTime();
  return {
    name: input.name,
    hours: iso(hours),
    booked: iso(booked),
    off: iso(off),
    free: iso(free),
    now: t >= from && t < to ? nowStatus({ hours, booked, off, free }, t) : null,
  };
}

/** Where the chair is at `t`: in someone's cut, away, free, not started, or done. */
function nowStatus(
  day: { hours: TimeRange[]; booked: TimeRange[]; off: TimeRange[]; free: TimeRange[] },
  t: number,
): NowStatus {
  if (day.hours.length === 0 && day.booked.length === 0) return { kind: "off" };
  const at = (list: TimeRange[]) => list.find((r) => r.start <= t && t < r.end);
  const until = (r: TimeRange) => new Date(r.end).toISOString();
  const busy = at(day.booked);
  if (busy) return { kind: "busy", until: until(busy) };
  const away = at(day.off);
  if (away) return { kind: "away", until: until(away) };
  const free = at(day.free);
  if (free) return { kind: "free", until: until(free) };
  const next = day.hours.find((r) => r.start > t);
  if (next) return { kind: "starts", at: new Date(next.start).toISOString() };
  return day.hours.length === 0 ? { kind: "off" } : { kind: "done" };
}

/**
 * Every active chair's day in the member's business, over [from, to). One
 * shop-scoped transaction for every read. Only ever called for a member who
 * shares their schedule.
 */
export async function memberDay(
  member: { id: string; timezone: string },
  window: { from: Date; to: Date },
  now: Date = new Date(),
): Promise<ChairDay[]> {
  const { from, to } = window;
  // Weekly rows are walked a day either side by weekdayWindowsToRanges; dated
  // rows are read with the same pad so a span crossing midnight is caught.
  const padFrom = addDays(from, -1);
  const padTo = addDays(to, 1);
  const data = await runWithShop(member.id, async (tx) => {
    const staff = await tx.staff.findMany({
      where: { shopId: member.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    });
    if (staff.length === 0) return null;
    const staffIds = staff.map((s) => s.id);
    const [rules, recurring, exceptions, external, appointments, visits] = await Promise.all([
      tx.availabilityRule.findMany({
        where: { shopId: member.id, staffId: { in: staffIds } },
        select: { staffId: true, weekday: true, startMin: true, endMin: true },
      }),
      tx.recurringBlock.findMany({
        where: { shopId: member.id, staffId: { in: staffIds } },
        select: { staffId: true, weekday: true, startMin: true, endMin: true },
      }),
      tx.availabilityException.findMany({
        where: {
          shopId: member.id,
          staffId: { in: staffIds },
          startsAt: { lt: padTo },
          endsAt: { gt: padFrom },
        },
        select: { staffId: true, startsAt: true, endsAt: true, isBlock: true, serviceIds: true },
      }),
      tx.externalBlock.findMany({
        where: { shopId: member.id, startsAt: { lt: padTo }, endsAt: { gt: padFrom } },
        select: { startsAt: true, endsAt: true },
      }),
      // Who was, is or will be in the chair: booked, finished, and requests
      // or holds still holding their time. A cancellation or a no-show left
      // the chair empty, so neither counts.
      tx.appointment.findMany({
        where: {
          shopId: member.id,
          staffId: { in: staffIds },
          startsAt: { lt: to },
          endsAt: { gt: from },
          OR: [
            { status: { in: ["BOOKED", "COMPLETED"] } },
            { status: "PENDING", OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: now } }] },
          ],
        },
        // Times only. Never the client, the service or the price.
        select: { staffId: true, startsAt: true, endsAt: true },
      }),
      // Visits synced from Acuity or Square carry no chair, so - as on the
      // booking grid - each one occupies every chair for its span.
      tx.visit.findMany({
        where: {
          shopId: member.id,
          status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED"] },
          appointment: null,
          scheduledAt: { lt: to },
          endAt: { gt: from },
        },
        select: { scheduledAt: true, endAt: true },
      }),
    ]);
    return { staff, rules, recurring, exceptions, external, appointments, visits };
  });
  if (!data) return [];

  const visitSpans = data.visits.map((v) => ({ startsAt: v.scheduledAt, endsAt: v.endAt ?? v.scheduledAt }));
  return data.staff.map((s) =>
    buildChairDay(
      {
        name: s.name,
        rules: data.rules.filter((r) => r.staffId === s.id),
        recurringBlocks: data.recurring.filter((r) => r.staffId === s.id),
        exceptions: data.exceptions.filter((e) => e.staffId === s.id),
        externalBlocks: data.external,
        occupied: [...data.appointments.filter((a) => a.staffId === s.id), ...visitSpans],
      },
      window,
      member.timezone,
      now,
    ),
  );
}

/* --------------------------------- days --------------------------------- */

/** How far ahead the owner can look: today and the six days after. */
export const SCHEDULE_DAYS = 7;

/** The team's own day `key` ("YYYY-MM-DD") as a half-open UTC window. */
export function dayWindow(key: string, timezone: string): { from: Date; to: Date } {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return {
    from: zonedWallTimeToUtc(y, m - 1, d, 0, timezone),
    // day + 1 is safe: Date.UTC rolls the 32nd into the next month.
    to: zonedWallTimeToUtc(y, m - 1, d + 1, 0, timezone),
  };
}

/** Today and the next six days, in the team's own calendar. */
export function scheduleDays(now: Date, timezone: string): string[] {
  const out: string[] = [];
  const today = zonedDateParts(now, timezone);
  for (let i = 0; i < SCHEDULE_DAYS; i++) {
    // Noon on each calendar day, so a DST change can't land the key on the
    // wrong date.
    const noon = zonedWallTimeToUtc(today.year, today.month0, today.day + i, 12 * 60, timezone);
    out.push(zonedDateKey(noon, timezone));
  }
  return out;
}

/**
 * The member's TODAY as the team's owner sees it - the team's calendar day,
 * so the member's preview and the owner's first page show the same day.
 */
export function memberToday(
  member: { id: string; timezone: string },
  teamTimezone: string,
  now: Date = new Date(),
): Promise<ChairDay[]> {
  return memberDay(member, dayWindow(zonedDateKey(now, teamTimezone), teamTimezone), now);
}

/* ------------------------------ the feed line ------------------------------ */

/** A run of edits is ONE feed line: at most one "updated availability" an hour per member. */
export const AVAILABILITY_EVENT_GAP_MS = 60 * 60 * 1000;

/**
 * A member changed their hours or time off: tell each team they share their
 * schedule with, as one line in the owner's feed ("Chris updated their
 * availability") - never what changed. Called AFTER the member's save has
 * committed, and never throws: the feed is a nicety, and a failure here must
 * never undo or fail the barber's own save.
 *
 * Best effort on the hourly limit: two saves in the same instant can each
 * write a line. That costs a duplicate line, nothing else.
 */
export async function noteTeamScheduleChanged(memberShopId: string, now: Date = new Date()): Promise<void> {
  try {
    await runAsOwner(async (tx) => {
      const links = await tx.teamLink.findMany({
        where: { memberShopId, status: "ACTIVE", shareSchedule: true },
        select: { id: true, teamShopId: true },
      });
      for (const link of links) {
        const recent = await tx.teamLinkEvent.findFirst({
          where: {
            linkId: link.id,
            kind: "availability",
            createdAt: { gt: new Date(now.getTime() - AVAILABILITY_EVENT_GAP_MS) },
          },
          select: { id: true },
        });
        if (!recent) await recordTeamEvent(tx, link, "availability");
      }
    });
  } catch (err) {
    logger.warn({ err, memberShopId }, "team schedule feed line failed");
  }
}
