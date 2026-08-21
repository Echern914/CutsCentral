/**
 * Which service groups the booking page should open by itself.
 *
 * Groups collapse by default so a long menu stays scannable. On a BUSY day
 * that is right. On a quiet one it hides everything: the customer picks a
 * date, lands on two closed accordions, and sees no times at all.
 *
 * That is what a barber reported as "my published after-hours slots aren't
 * appearing". They were appearing - one click inside a closed card. On the day
 * we checked, the whole shop had four bookable slots and three of them were
 * after-hours specials, so the page read as completely empty.
 *
 * Two cases open a group, both meaning "there is nothing to scan past":
 *   1. It is the ONLY thing on the page. /day already omits groups with no
 *      openings, so a single returned group with no loose services below it
 *      means the customer's only possible next tap is that card.
 *   2. The whole day is sparse. Hiding four chips behind an accordion buys no
 *      scannability and costs the booking.
 *
 * Deliberately NOT "always expand": the collapsed design exists because a shop
 * with a long menu and a full day is unreadable otherwise, and that shop is
 * still served by the default.
 */

/** At or below this many bookable chips in a day, nothing needs hiding. */
export const SPARSE_DAY_CHIP_LIMIT = 6;

interface SlotBearing {
  slots: unknown[];
}
interface Bundle {
  id: string;
  services: SlotBearing[];
}

/** Every bookable chip on the day, across grouped and loose services. */
function chipCount(bundles: Bundle[], ungrouped: SlotBearing[]): number {
  let n = 0;
  for (const b of bundles) for (const s of b.services) n += s.slots.length;
  for (const s of ungrouped) n += s.slots.length;
  return n;
}

/**
 * The group ids to open for this day. Empty means "leave them all closed",
 * which is the busy-day default.
 */
export function groupsToAutoExpand(
  bundles: Bundle[],
  ungrouped: SlotBearing[],
): string[] {
  if (bundles.length === 0) return [];

  // 1. The only card on the page.
  if (bundles.length === 1 && ungrouped.length === 0) return [bundles[0]!.id];

  // 2. A quiet day - open everything, there is nothing to scroll past.
  if (chipCount(bundles, ungrouped) <= SPARSE_DAY_CHIP_LIMIT) {
    return bundles.map((b) => b.id);
  }

  return [];
}
