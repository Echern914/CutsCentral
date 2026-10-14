/**
 * WHICH SERVICES A BLOCK STOPS - the one rule, for the slot grid
 * (apps/api engines/slots.ts), the booking write guard (engines/bookingWrite.ts),
 * the save's "bookings in the way" check, and the words the barber reads.
 *
 * A block (AvailabilityException with isBlock) carries `serviceIds`:
 *   []          every service - the barber is not there. Every block written
 *               before service scopes existed reads this way, unchanged.
 *   [a, b, ...] only those services are refused over the span. The chair is
 *               still open for everything else: "no Shape-ups or Kids' cuts
 *               3-6 PM, Haircuts as usual".
 *
 * Add-ons are not services here: they ride on the booked service, so a
 * Haircut + Beard is a Haircut. They still lengthen the appointment, and the
 * longer span is what is checked against a block of its service.
 *
 * 🔴 A question that cannot name its service (serviceId null: walk-in mode,
 * a writer with no service) counts EVERY block as in the way. Refusing is the
 * safe answer; offering a Shape-up into a Shape-up block is the failure.
 */

/** Does a block with these `serviceIds` stop a booking of `serviceId`? */
export function blockAppliesToService(
  blockServiceIds: readonly string[] | null | undefined,
  serviceId: string | null | undefined,
): boolean {
  if (!blockServiceIds || blockServiceIds.length === 0) return true;
  if (!serviceId) return true;
  return blockServiceIds.includes(serviceId);
}

/** True when the block stops every service (the whole chair). */
export function blocksAllServices(blockServiceIds: readonly string[] | null | undefined): boolean {
  return !blockServiceIds || blockServiceIds.length === 0;
}

/** The most services one block may name. Far above any real menu. */
export const MAX_BLOCK_SERVICES = 100;

/**
 * The list a save stores: trimmed, de-duplicated, sorted (so two saves of the
 * same choice compare equal). `null`/`undefined` = all services = [].
 */
export function normalizeBlockServiceIds(ids: readonly unknown[] | null | undefined): string[] {
  if (!ids) return [];
  const out = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const t = id.trim();
    if (t) out.add(t);
  }
  return [...out].sort();
}

/**
 * The scope in words, for the calendar band, the review step and the edit
 * sheet: "All services", or the services' names. A name the caller no longer
 * has (a deleted service) is left out; if none survive, the block can stop
 * nothing that can still be booked, and it says so instead of claiming "All".
 */
export function describeBlockScope(
  blockServiceIds: readonly string[] | null | undefined,
  nameOf: (id: string) => string | null | undefined,
): string {
  if (blocksAllServices(blockServiceIds)) return "All services";
  const names = blockServiceIds!
    .map((id) => nameOf(id))
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  if (names.length === 0) return "Removed services only";
  if (names.length === 1) return `${names[0]} only`;
  if (names.length === 2) return `${names[0]} and ${names[1]} only`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} only`;
}
