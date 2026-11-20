/**
 * TELLING PROVIDERS APART ON A SHARED CALENDAR.
 *
 * A shop with several people working it had one calendar where every booking
 * looked the same: no name on a card, no way to see just one person's day.
 * These are the three small rules the day planner, the week grid and the
 * dashboard's Today list all share, so the three can never disagree about
 * whose booking a row is.
 *
 * 🔴 A ONE-PERSON SHOP IS UNCHANGED. Everything here returns "nothing to tell
 * apart" until two or more people are active, so a solo calendar gets no
 * filter row and no name on its cards.
 */
export interface ChairLike {
  id: string;
  name: string;
  active: boolean;
}

/** The people worth telling apart: every active one, once there are two. */
export function tellableChairs<T extends ChairLike>(staff: T[]): T[] {
  const active = staff.filter((s) => s.active);
  return active.length >= 2 ? active : [];
}

/**
 * Does this row belong on that person's day?
 *
 * A row that names nobody stays: a shop-wide block (a holiday, an Acuity
 * block) covers everyone, and a synced booking that never said who it is with
 * must not vanish from the owner's screen because a filter is on.
 */
export function onChair(row: { staffId?: string | null }, chairId: string): boolean {
  return row.staffId == null || row.staffId === chairId;
}

/** The name to print on a card: null when there is nobody to tell apart. */
export function chairNameFor(
  row: { source: string; staffId?: string | null },
  chairs: ChairLike[],
): string | null {
  if (row.source === "block" || !row.staffId) return null;
  return chairs.find((c) => c.id === row.staffId)?.name ?? null;
}
