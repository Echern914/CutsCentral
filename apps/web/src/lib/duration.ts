/**
 * Durations, written the way a person says them: days, then hours, then
 * minutes — never "202h 56m".
 *
 * Minutes are the stored unit everywhere in the app (service length, open
 * time, blocks), so anything that spans a window ends up as a four-digit
 * number of them. Left as bare hours that reads as arithmetic rather than a
 * length of time: nobody pictures 202 hours, but "8d 10h 56m" is most of a
 * fortnight. So hours roll into days at 24, always.
 *
 * Both formatters lived as private copies in three components before this, and
 * all three had the same >24h problem. One home means the next surface that
 * needs a duration can't reintroduce it.
 */

/** Split minutes into whole days / hours / minutes, rounding ONCE up front. */
function parts(min: number): { d: number; h: number; m: number } {
  // Round the total before splitting, not each part after. Rounding the
  // remainder independently produced "23h 60m" for 1439.7 minutes.
  const total = Math.max(0, Math.round(min));
  return {
    d: Math.floor(total / 1440),
    h: Math.floor((total % 1440) / 60),
    m: total % 60,
  };
}

/**
 * "8d 10h 56m", "2h", "1h 30m", "45m" — trailing zeros dropped.
 *
 * The default. Use it for a standalone duration, where "2h" is plainly two
 * hours and "2h 0m" is just pedantic. Zero reads as "0m".
 */
export function fmtDuration(min: number): string {
  const { d, h, m } = parts(min);
  const out: string[] = [];
  if (d > 0) out.push(`${d}d`);
  if (h > 0) out.push(`${h}h`);
  if (m > 0 || out.length === 0) out.push(`${m}m`);
  return out.join(" ");
}

/**
 * "8d 10h 56m", "8h 0m", "45m" — spelled out to the minute once there's an
 * hour on the clock.
 *
 * Use it where the number sits next to another one it's meant to be compared
 * against (sold vs. open chair time). A bare "14d" beside "11d 1h 25m" reads
 * as a rounded-off estimate; it isn't, and the trailing zeros say so.
 */
export function fmtDurationExact(min: number): string {
  const { d, h, m } = parts(min);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}
