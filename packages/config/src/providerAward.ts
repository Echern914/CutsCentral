/**
 * PROVIDER OF THE MONTH (Eric, 2026-10-17).
 *
 * A shop applies with the stats it chooses to put forward and a short pitch;
 * ChairBack picks the winner and writes why; the winner's public page then
 * shows it. The rules every surface shares live here: which month an award
 * belongs to, what it's called, and how long the page shows it.
 *
 * Pure - no database, no clock of its own.
 */

/** One stat a shop put forward, frozen as text when it applied or won. */
export interface AwardStat {
  key: string;
  label: string;
  value: string;
}

/** What the public page shows. */
export interface PublicAward {
  month: string;
  monthLabel: string;
  title: string;
  winnerName: string;
  /** What they do: "Knotless braids · Boho locs". Null = no line. */
  specialty: string | null;
  headline: string;
  description: string;
  stats: AwardStat[];
}

/** The stats a shop can put forward, all from its own data. */
export const AWARD_STAT_KEYS = ["appointments", "clients", "growth", "rating"] as const;
export type AwardStatKey = (typeof AWARD_STAT_KEYS)[number];

/** Limits on what a shop writes, and what ChairBack writes. */
export const AWARD_LIMITS = {
  pitch: 600,
  credentials: 300,
  title: 60,
  winnerName: 60,
  specialty: 80,
  headline: 100,
  description: 600,
} as const;

/** "2026-10": the month an award or application belongs to (UTC). */
export function awardMonthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month before, as a key. */
export function previousMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "October 2026". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? ""} ${y}`.trim();
}

export function isMonthKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/**
 * "Barber of the Month", "Nail Tech of the Month", "Lash Artist of the Month"
 * - the shop's own word for who does the work, never "barber" for everyone.
 */
export function awardTitle(providerNoun: string): string {
  const noun = providerNoun.trim() || "provider";
  const titled = noun
    .split(/\s+/)
    .map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`)
    .join(" ");
  return `${titled} of the Month`;
}

/**
 * Whether the page still shows an award: through the month it was given for
 * and the whole month after, so a winner announced late in the month still
 * gets a full month on their page.
 */
export function awardIsShowing(month: string, now: Date): boolean {
  const current = awardMonthKey(now);
  return month === current || month === previousMonthKey(current);
}
