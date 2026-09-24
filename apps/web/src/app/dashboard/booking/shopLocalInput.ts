/**
 * An instant as the value a `<input type="datetime-local">` expects -
 * "YYYY-MM-DDTHH:mm" - read in the SHOP's timezone, not the device's.
 *
 * The Custom time picker writes its value back through zonedWallTimeToUtc in
 * the shop's zone, so it must be seeded the same way or the two halves disagree
 * whenever the barber's phone is not in the shop's zone. Seeding it at all is
 * the actual fix: an empty picker on iOS opens on today, which silently turned
 * "Fri Sep 25, 8:00 PM" into Thu Sep 24.
 */
export function shopLocalInputValue(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
