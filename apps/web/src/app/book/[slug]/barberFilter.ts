/**
 * "Any available" or one person: the rules behind the row of people at the top
 * of the booking page.
 *
 * The day view arrives with every person's times merged: each time carries the
 * ids of everyone free then. Picking one person does not ask the API again -
 * it narrows what is already on the page to the times that person is free, and
 * pins each of those times to them, so the booking is written against the
 * person the customer chose and nobody else.
 *
 * Pure (no React), so the rules are tested on their own.
 */
import type { DayBundlesResult, DayService } from "./actions";

/** How many people a shop needs before a customer is asked to choose. */
export const MIN_PEOPLE_TO_CHOOSE = 2;

interface Person {
  id: string;
  /** Weekdays (0-6, shop-local) this person keeps hours. Absent on an older API. */
  weekdays?: number[];
}

/**
 * The people a customer can pick: someone who does at least one service on the
 * menu and keeps hours on at least one day. A chair with no hours, or one that
 * does nothing a client can book, would only ever lead to an empty page.
 *
 * An API that sends no `weekdays` is trusted on hours (the row still works;
 * the calendar just cannot grey that person's days off).
 */
export function pickablePeople<T extends Person>(
  staff: T[],
  offerings: { serviceId: string; staffId: string }[],
  bookableServiceIds: ReadonlySet<string>,
): T[] {
  const doesSomething = new Set(
    offerings.filter((o) => bookableServiceIds.has(o.serviceId)).map((o) => o.staffId),
  );
  return staff.filter(
    (s) => doesSomething.has(s.id) && (s.weekdays === undefined || s.weekdays.length > 0),
  );
}

/**
 * Is a customer offered the choice at all? 🔴 The whole feature hangs on this:
 * a one-person shop must look exactly as it did before, with no row.
 */
export function offersChoice(people: readonly unknown[]): boolean {
  return people.length >= MIN_PEOPLE_TO_CHOOSE;
}

/** Does this person keep hours on this calendar day (YYYY-MM-DD)? */
export function worksOn(person: Person | null | undefined, dayKey: string): boolean {
  if (!person || person.weekdays === undefined) return true;
  return person.weekdays.includes(new Date(`${dayKey}T12:00:00Z`).getUTCDay());
}

/**
 * One day, as one person offers it.
 *
 *  - Every time is kept only if that person is free then, and is PINNED to
 *    them (`staffIds` becomes just them): a tap must book who was chosen.
 *  - A service they have no time for drops off its open card, as the API does
 *    for the whole shop.
 *  - A group left with no times becomes a closed card ("No times this day")
 *    listing only what that person does, so a group never just vanishes - and
 *    a group they do nothing in is not shown at all.
 */
export function narrowDayToStaff(
  day: DayBundlesResult,
  staffId: string,
  offers: (serviceId: string) => boolean,
): DayBundlesResult {
  const narrow = (svc: DayService): DayService => ({
    ...svc,
    slots: svc.slots
      .filter((s) => s.staffIds.includes(staffId))
      .map((s) => ({ ...s, staffIds: [staffId] })),
  });
  const bundles: DayBundlesResult["bundles"] = [];
  const closedGroups: NonNullable<DayBundlesResult["closedGroups"]> = [];
  for (const group of day.bundles) {
    const services = group.services.map(narrow);
    const withTimes = services.filter((s) => s.slots.length > 0);
    if (withTimes.length > 0) {
      bundles.push({ ...group, services: withTimes });
      continue;
    }
    const theirs = services.filter((s) => offers(s.id));
    if (theirs.length > 0) closedGroups.push({ ...group, services: theirs });
  }
  for (const group of day.closedGroups ?? []) {
    const theirs = group.services.filter((s) => offers(s.id));
    if (theirs.length > 0) closedGroups.push({ ...group, services: theirs });
  }
  return {
    ...day,
    bundles,
    closedGroups,
    ungrouped: day.ungrouped.map(narrow).filter((s) => s.slots.length > 0),
  };
}
