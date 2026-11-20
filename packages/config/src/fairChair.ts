/**
 * WHO GETS AN "ANY AVAILABLE" BOOKING - the one rule, so the booking page and
 * the API can never disagree about whose turn it is.
 *
 * When a shop has several people working and a customer does not pick one, the
 * time they tap is open with more than one of them. The page books the FIRST
 * id in the slot's list. That list used to come out in whatever order the
 * database returned the service links, which in practice is the order the
 * chairs were created in - so the first chair took nearly every "anyone is
 * fine" booking and the newest hire took none.
 *
 * The rule now: the person with the FEWEST bookings that day goes first. A tie
 * is broken by a hash of the day and the person, so no one is first on every
 * tied day (creation order and alphabetical order both hand that to the same
 * person for ever).
 *
 * Pure and deterministic: the same inputs always give the same order, which is
 * what lets a cached day body and a fresh one agree, and what makes this
 * testable without a clock.
 *
 * A list of one comes back as it went in - a one-person shop is untouched.
 */

/**
 * A small, stable string hash (FNV-1a, 32 bit). Not security: it only has to
 * spread ties evenly and give the same answer on the API and in a test.
 */
function tieHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The people open at one time, in the order a booking should go to them.
 *
 * @param staffIds      everyone free at this time (any order)
 * @param countByStaff  bookings each already holds that day; missing = 0
 * @param dayKey        the shop-local day, YYYY-MM-DD - the tie-break seed
 */
export function fairChairOrder(
  staffIds: readonly string[],
  countByStaff: ReadonlyMap<string, number>,
  dayKey: string,
): string[] {
  if (staffIds.length < 2) return [...staffIds];
  return staffIds
    .map((id) => ({
      id,
      count: countByStaff.get(id) ?? 0,
      tie: tieHash(`${dayKey}|${id}`),
    }))
    .sort((a, b) => a.count - b.count || a.tie - b.tie || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}
