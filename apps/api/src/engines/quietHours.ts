import { QUIET_HOURS, isQuietHours } from "@chairback/config";

/**
 * TCPA quiet-hours gate for outbound SMS. A shop may only text within
 * 8:00am-9:00pm in the recipient's local time; we approximate the recipient's
 * zone with the shop's `timezone` (clients are nearly always local to the shop).
 *
 * Shared by every send path - the sweep, promo blasts, and manual/bulk nudges -
 * so the rule is defined once. `now` is injected for deterministic tests.
 */
export function inQuietHours(timezone: string, now: Date = new Date()): boolean {
  return isQuietHours(now, timezone, QUIET_HOURS.startHour, QUIET_HOURS.endHour);
}
