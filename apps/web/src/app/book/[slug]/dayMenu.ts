/**
 * The day view's group list, and the one question "is anything bookable today?".
 *
 * Groups used to come only from `bundles` - groups with an opening that day -
 * so a group whose services keep narrow hours disappeared on every day it was
 * shut. A barber with "First Time Clients" and "Clients Only" saw only the
 * second one and read it as having replaced the first. The API now also sends
 * `closedGroups`; this merges the two back into the barber's group order.
 *
 * Pure (no React) so the rules are tested on their own.
 */

interface SlotBearing {
  slots: unknown[];
}
interface GroupLike<S extends SlotBearing> {
  id: string;
  name: string;
  position?: number;
  services: S[];
}
interface DayLike<S extends SlotBearing> {
  bundles: GroupLike<S>[];
  closedGroups?: GroupLike<S>[];
  ungrouped: S[];
}

export interface DayMenuGroup<S extends SlotBearing> {
  id: string;
  name: string;
  services: S[];
  /** No member has a time this day: the card says so instead of a count. */
  closed: boolean;
}

/**
 * Open and closed groups in ONE list, in the barber's group order when the
 * API says it (`position`), otherwise open groups first (an older API sends
 * no closed groups at all, so that is simply the old list).
 */
export function dayMenuGroups<S extends SlotBearing>(day: DayLike<S>): DayMenuGroup<S>[] {
  const open = day.bundles.map((b) => ({ ...b, closed: false }));
  const closed = (day.closedGroups ?? [])
    // Defensive: a closed group is only worth a card if it has members, and
    // a group can never be both open and closed.
    .filter((g) => g.services.length > 0 && !day.bundles.some((b) => b.id === g.id))
    .map((g) => ({ ...g, closed: true }));
  const all = [...open, ...closed];
  const ordered = all.every((g) => typeof g.position === "number")
    ? all.slice().sort((a, b) => a.position! - b.position!)
    : all;
  return ordered.map(({ id, name, services, closed: isClosed }) => ({
    id,
    name,
    services,
    closed: isClosed,
  }));
}

/**
 * Does this day have ANY bookable time? Counted in SLOTS, not in groups: a
 * closed group is on the page but offers nothing, and must never suppress the
 * booked-out screen (or the auto-hop past a dead landing day).
 */
export function dayHasTimes<S extends SlotBearing>(day: DayLike<S>): boolean {
  for (const b of day.bundles) for (const s of b.services) if (s.slots.length > 0) return true;
  for (const s of day.ungrouped) if (s.slots.length > 0) return true;
  return false;
}
