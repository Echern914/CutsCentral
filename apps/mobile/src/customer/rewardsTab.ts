import type { Promotion, RebookInfo, RewardProgram, RewardsSection } from "./types";

/**
 * THE REWARDS TAB'S DECISIONS - what the client's rewards page shows, brought
 * into the app: the rebooking timer, the punch stamps, the shop's deals and
 * the rewards they've claimed. Pure, so it is tested here; the screen only
 * draws what these say.
 *
 * The owner: "the client rewards under book appointment in public page to be
 * in rewards in the client side ... with the timer and everything with it".
 */

export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
}

/** Time left until `deadline` (ISO), never below zero. */
export function countdown(deadline: string, now: number): Countdown {
  const totalMs = Math.max(0, Date.parse(deadline) - now);
  const s = Math.floor(totalMs / 1000);
  return {
    days: Math.floor(s / 86_400),
    hours: Math.floor((s % 86_400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
    totalMs,
  };
}

/** What the timer shows right now. */
export type TimerView =
  | { kind: "booked"; upcomingAt: string }
  | { kind: "counting"; left: Countdown; urgent: boolean; windowDays: number }
  | { kind: "overdue" }
  | { kind: "hidden" };

/**
 * Booked: no clock - the next visit. Counting: the clock, urgent under two
 * days. Past the deadline: overdue. No visit yet (or an older API): nothing.
 * The same states and the same two-day line as the rewards page.
 */
export function timerView(rebook: RebookInfo | undefined, now: number): TimerView {
  if (!rebook) return { kind: "hidden" };
  if (rebook.state === "booked") return rebook.upcomingAt ? { kind: "booked", upcomingAt: rebook.upcomingAt } : { kind: "hidden" };
  if (rebook.state === "none" || !rebook.deadline) return { kind: "hidden" };
  const left = countdown(rebook.deadline, now);
  if (rebook.state === "overdue" || left.totalMs === 0) return { kind: "overdue" };
  return { kind: "counting", left, urgent: left.days < 2, windowDays: rebook.windowDays };
}

/** The line under the clock - the rewards page's words. */
export function timerNote(view: TimerView): string | null {
  if (view.kind === "counting") {
    return view.urgent ? "Your window closes soon. Grab a slot." : `Rebook within ${view.windowDays} days to keep your streak.`;
  }
  if (view.kind === "overdue") return "Book now to stay on track.";
  return null;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * The clock, spoken - to the minute. A screen reader re-reading a label that
 * changes every second would never stop talking.
 */
export function countdownSpoken(left: Countdown): string {
  const parts = [
    left.days > 0 ? plural(left.days, "day") : null,
    left.hours > 0 ? plural(left.hours, "hour") : null,
    plural(left.minutes, "minute"),
  ].filter(Boolean) as string[];
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return `${said} left to rebook`;
}

/** Two digits, as the clock shows them. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The shop shows this section. An older API sends no list: everything shows, as it always did. */
export function shows(program: RewardProgram, section: RewardsSection): boolean {
  return !program.sections || program.sections.includes(section);
}

/**
 * The punch stamps toward the next reward: one per punch it costs, filled up to
 * the balance. Only for a card small enough to read as stamps - 20 or fewer,
 * the rewards page's limit - else null and the bar alone carries it.
 */
export function stamps(balance: number, cost: number): boolean[] | null {
  if (!Number.isFinite(cost) || cost <= 0 || cost > 20) return null;
  const filled = Math.max(0, Math.min(balance, cost));
  return Array.from({ length: cost }, (_, i) => i < filled);
}

/** The rewards they have claimed, newest first - from the activity the tab already has. */
export function claimed(program: RewardProgram): { date: string; label: string }[] {
  return program.activity.filter((a) => a.kind === "redeemed").map(({ date, label }) => ({ date, label }));
}

/** A deal's value in words, as the shop's page says it. */
export function dealValue(p: Promotion): string | null {
  switch (p.kind) {
    case "PERCENT_OFF":
      return p.percentOff ? `${p.percentOff}% off` : null;
    case "AMOUNT_OFF":
      return p.amountOff ? `$${p.amountOff} off` : null;
    case "FREE_ADDON":
      return null;
    case "EXTRA_PUNCHES":
      return p.extraPunches ? `+${p.extraPunches} ${p.extraPunches === 1 ? "punch" : "punches"} per visit` : null;
  }
}

/** When a deal ends, as the shop's page says it: "last day", "ends in 3 days", else the date. */
export function dealEnds(endsAt: string | null, now: number, timeZone?: string): string | null {
  if (!endsAt) return null;
  const days = Math.ceil((Date.parse(endsAt) - now) / 86_400_000);
  if (days <= 0) return null;
  if (days === 1) return "last day";
  if (days <= 14) return `ends in ${days} days`;
  return `ends ${new Date(endsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) })}`;
}
