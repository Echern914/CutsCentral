import { CADENCE_KEYS, cadenceToDays, type CadenceKey } from "./constants.js";

/**
 * THE REBOOKING COUNTDOWN - the timer on a client's rewards, wherever they see
 * it: the web rewards page (/r/<token>) and the Rewards tab in the app. One
 * rule, so the two can never show a client different deadlines.
 *
 * - Booked already: no timer - "You're booked", with the next visit's time.
 * - Otherwise the deadline is the last visit + the rebook window, counting
 *   down until it passes, then overdue.
 * - No visit yet: nothing to count from.
 *
 * The window is the client's own cadence when they told us one (a "monthly"
 * client counts down over 30 days), else the shop's rebook window.
 */
export type RebookState = "booked" | "counting" | "overdue" | "none";

export interface RebookInfo {
  state: RebookState;
  /** ISO. When the window closes; null unless counting or overdue. */
  deadline: string | null;
  windowDays: number;
  /** ISO. The next booked visit; null unless booked. */
  upcomingAt: string | null;
}

const DAY_MS = 86_400_000;

function isCadenceKey(v: string): v is CadenceKey {
  return (CADENCE_KEYS as string[]).includes(v);
}

export function rebookCountdown(input: {
  /** The last completed visit. */
  lastVisitAt: Date | null;
  /** The client's self-reported cadence (Client.preferredCadence), if any. */
  preferredCadence: string | null;
  /** Shop.rebookWindowDays. */
  shopWindowDays: number;
  /** The next booked visit, from whichever system holds it. */
  upcomingAt: Date | string | null;
  now: Date;
}): RebookInfo {
  const windowDays =
    input.preferredCadence && isCadenceKey(input.preferredCadence)
      ? cadenceToDays(input.preferredCadence)
      : input.shopWindowDays;
  if (input.upcomingAt) {
    const at = typeof input.upcomingAt === "string" ? input.upcomingAt : input.upcomingAt.toISOString();
    return { state: "booked", deadline: null, windowDays, upcomingAt: at };
  }
  if (input.lastVisitAt) {
    const deadline = new Date(input.lastVisitAt.getTime() + windowDays * DAY_MS);
    return {
      state: deadline.getTime() > input.now.getTime() ? "counting" : "overdue",
      deadline: deadline.toISOString(),
      windowDays,
      upcomingAt: null,
    };
  }
  return { state: "none", deadline: null, windowDays, upcomingAt: null };
}
