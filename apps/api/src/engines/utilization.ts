import { zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";

/**
 * CHAIR UTILIZATION: how much of the time a barber was OPEN did he actually
 * sell?
 *
 * The Insights page could already say "Tuesday is your busiest day" — but a
 * raw booking count can't tell a full Tuesday from a Tuesday he barely worked.
 * Utilization answers the question a barber actually asks: "where am I leaving
 * money on the table?" A 4-booking Saturday at 90% is a great day; a
 * 4-booking Wednesday at 25% is six empty hours.
 *
 * CAPACITY is reconstructed from the CURRENT weekly schedule
 * (AvailabilityRule) minus standing breaks (RecurringBlock), then adjusted per
 * concrete day by the one-off exceptions actually recorded on that date
 * (AvailabilityException: blocks subtract, one-off opens add). We do NOT store
 * historical schedules, so a barber who changed his hours mid-window has older
 * days measured against today's schedule. That's the honest limit of the data
 * and the UI says so — it does not change the ranking of which days run empty.
 *
 * BOOKED time is every appointment that occupied the chair: native
 * appointments AND external synced (Acuity/Square) visits, which are real
 * bookings that also block native slots. Canceled time is not "used" — it was
 * given back. A no-show DID hold the chair (nobody else could book it), so it
 * counts as used; it shows up as lost revenue elsewhere, not as free time.
 *
 * All bucketing is SHOP-LOCAL: a Friday 11pm cut in New York belongs to
 * Friday, not to Saturday UTC.
 */

/** Half-open [start, end) span in minutes from shop-local midnight. */
export interface Span {
  start: number;
  end: number;
}

/** Sort + coalesce overlapping/adjacent spans so nothing is counted twice. */
export function mergeSpans(spans: Span[]): Span[] {
  const valid = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of valid) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      if (s.end > last.end) last.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** `base` minus `cuts` (both may overlap internally; result is merged). */
export function subtractSpans(base: Span[], cuts: Span[]): Span[] {
  const merged = mergeSpans(base);
  const holes = mergeSpans(cuts);
  const out: Span[] = [];
  for (const b of merged) {
    let cursor = b.start;
    for (const h of holes) {
      if (h.end <= cursor || h.start >= b.end) continue; // no overlap
      if (h.start > cursor) out.push({ start: cursor, end: Math.min(h.start, b.end) });
      cursor = Math.max(cursor, h.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

export function spanMinutes(spans: Span[]): number {
  return spans.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}

/** Minutes of [aStart, aEnd) that fall inside any of `spans`. */
export function overlapMinutes(aStart: number, aEnd: number, spans: Span[]): number {
  let total = 0;
  for (const s of spans) {
    total += Math.max(0, Math.min(aEnd, s.end) - Math.max(aStart, s.start));
  }
  return total;
}

export interface WeeklyRule {
  staffId: string;
  weekday: number; // 0-6, Sun-Sat (shop-local)
  startMin: number;
  endMin: number;
}

export interface DatedSpan {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Open minutes for ONE shop-local day, summed across the given staff.
 *
 * Per staffer: weekly rules, minus standing breaks, minus that date's
 * block-offs, plus that date's one-off opens. Summed across staff — two
 * barbers working 9-5 is 16 chair-hours, not 8 — so utilization means the same
 * thing for a one-chair shop and a five-chair shop.
 */
export function openMinutesForDay(input: {
  /** Shop-local midnight for the day, as a UTC instant. */
  dayStartUtc: Date;
  weekday: number;
  staffIds: string[];
  rules: WeeklyRule[];
  recurringBlocks: WeeklyRule[];
  exceptions: (DatedSpan & { isBlock: boolean })[];
  /**
   * Stop counting at this many minutes past shop-local midnight. Used for TODAY,
   * whose remaining hours are still sellable: counting a 9-5 day as 8 open hours
   * at 10am would read as a slump every morning. Omit for a finished day.
   */
  untilMin?: number;
}): number {
  const { dayStartUtc, weekday, staffIds, rules, recurringBlocks, exceptions, untilMin } =
    input;
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60_000);
  const DAY_END_MIN = 24 * 60;
  // The not-yet-happened tail of today is subtracted like any other block.
  const futureTail: Span[] =
    untilMin === undefined || untilMin >= DAY_END_MIN
      ? []
      : [{ start: Math.max(0, untilMin), end: DAY_END_MIN }];

  // A concrete exception -> minutes-from-local-midnight on THIS day, clipped to
  // the day so an overnight block only subtracts the part that lands here.
  const toLocalSpan = (e: DatedSpan): Span | null => {
    if (e.endsAt <= dayStartUtc || e.startsAt >= dayEndUtc) return null;
    const clippedStart = e.startsAt < dayStartUtc ? dayStartUtc : e.startsAt;
    const clippedEnd = e.endsAt > dayEndUtc ? dayEndUtc : e.endsAt;
    return {
      start: Math.round((clippedStart.getTime() - dayStartUtc.getTime()) / 60_000),
      end: Math.round((clippedEnd.getTime() - dayStartUtc.getTime()) / 60_000),
    };
  };

  let total = 0;
  for (const staffId of staffIds) {
    const base = rules
      .filter((r) => r.staffId === staffId && r.weekday === weekday)
      .map((r) => ({ start: r.startMin, end: r.endMin }));
    const standing = recurringBlocks
      .filter((r) => r.staffId === staffId && r.weekday === weekday)
      .map((r) => ({ start: r.startMin, end: r.endMin }));

    const mine = exceptions.filter((e) => e.staffId === staffId);
    const oneOffOpens = mine
      .filter((e) => !e.isBlock)
      .map(toLocalSpan)
      .filter((s): s is Span => s !== null);
    const dayBlocks = mine
      .filter((e) => e.isBlock)
      .map(toLocalSpan)
      .filter((s): s is Span => s !== null);

    // One-off opens are added BEFORE blocks are subtracted: a same-day block
    // must be able to cut into an extra hour the barber opened up.
    const opened = mergeSpans([...base, ...oneOffOpens]);
    total += spanMinutes(
      subtractSpans(opened, [...standing, ...dayBlocks, ...futureTail]),
    );
  }
  return total;
}

/**
 * Shop-local midnights for each day in [from, to] inclusive, with the local
 * weekday already resolved (0-6, Sun-Sat) so callers never re-derive it.
 */
export function shopLocalDays(
  from: Date,
  to: Date,
  timezone: string,
): { dayStartUtc: Date; weekday: number }[] {
  const out: { dayStartUtc: Date; weekday: number }[] = [];
  const first = zonedDateParts(from, timezone);
  let cursor = zonedWallTimeToUtc(first.year, first.month0, first.day, 0, timezone);
  // Guard against a pathological range; a year of days is plenty for Insights.
  for (let i = 0; i < 400 && cursor <= to; i++) {
    const p = zonedDateParts(cursor, timezone);
    out.push({ dayStartUtc: cursor, weekday: p.weekday });
    // Day arithmetic through the wall-clock helper keeps DST days correct:
    // adding 86_400_000ms across a spring-forward boundary drifts an hour.
    cursor = zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 0, timezone);
  }
  return out;
}
