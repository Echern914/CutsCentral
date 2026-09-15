import { zonedWallTimeToUtc } from "@chairback/config";

/** A calendar day as a shop in `timeZone` names it. */
export interface ShopDay {
  y: number;
  /** ZERO-based month - the shape zonedWallTimeToUtc takes. */
  m0: number;
  d: number;
  /** "YYYY-MM-DD" in the shop's zone. */
  key: string;
}

const DAY_MS = 86_400_000;

function dayIn(instant: Date, timeZone: string): ShopDay {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const y = part("year");
  const m = part("month");
  const d = part("day");
  return { y, m0: m - 1, d, key: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/** Local noon of a shop day, as an instant. Noon is never skipped or repeated by DST. */
function noonOf(day: ShopDay, timeZone: string): number {
  return zonedWallTimeToUtc(day.y, day.m0, day.d, 12 * 60, timeZone).getTime();
}

/** The shop day `n` days after `day` (negative walks back). */
export function dayAfter(day: ShopDay, n: number, timeZone: string): ShopDay {
  return dayIn(new Date(noonOf(day, timeZone) + n * DAY_MS), timeZone);
}

/**
 * 🔴 A shop-local calendar day counted FROM NOW - for any test that drives a
 * route on the real clock.
 *
 * A hard-coded date passes for weeks and then fails on every branch the same
 * morning, in a file nobody touched: bookingRefusal.test.ts booked 2026-09-12
 * and went red on the 13th, with the API rightly calling that booking too soon.
 *
 * `avoidDstChange` steps forward past any day whose neighbour is 23 or 25 hours
 * away, for a test whose premise is the zone's offset holding still.
 */
export function shopDayAhead(
  daysAhead: number,
  timeZone: string,
  opts: { now?: Date; avoidDstChange?: boolean } = {},
): ShopDay {
  const now = opts.now ?? new Date();
  let day = dayIn(new Date(now.getTime() + daysAhead * DAY_MS), timeZone);
  if (opts.avoidDstChange) {
    for (let i = 0; i < 7; i++) {
      const noon = noonOf(day, timeZone);
      const steady =
        noon - noonOf(dayAfter(day, -1, timeZone), timeZone) === DAY_MS &&
        noonOf(dayAfter(day, 1, timeZone), timeZone) - noon === DAY_MS;
      if (steady) break;
      day = dayAfter(day, 1, timeZone);
    }
  }
  return day;
}
