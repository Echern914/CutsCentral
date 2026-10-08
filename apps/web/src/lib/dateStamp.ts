/**
 * "Oct 8, 6:15 PM" - how a dashboard list stamps a message, review, request or
 * nudge. Pass it to <LocalDate> so it renders in the barber's own time zone.
 *
 * 🔴 A plain module on purpose: a server page importing a VALUE from a
 * "use client" file gets a client reference, not the object.
 */
export const DATE_TIME_STAMP: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};
