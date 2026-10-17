import { prisma } from "@chairback/db";
import {
  AWARD_STAT_KEYS,
  awardIsShowing,
  awardMonthKey,
  monthLabel,
  previousMonthKey,
  type AwardStat,
  type AwardStatKey,
  type PublicAward,
} from "@chairback/config/providerAward";
import { teamNumbers } from "../services/teamLinks.js";

/**
 * PROVIDER OF THE MONTH (config/providerAward.ts) - the API side.
 *
 * The stats a shop can put forward come from its own data, counted the same
 * way the Team page counts a member (services/teamLinks.ts teamNumbers): the
 * last 30 days, and the 30 before for the change. Never revenue - a shop's
 * money is not something it is asked to publish to win.
 */
export async function awardStatsFor(
  shop: { id: string; timezone: string },
  now: Date = new Date(),
): Promise<AwardStat[]> {
  const n = await teamNumbers(
    shop,
    { shareCuts: true, shareClients: true, shareRating: true, shareRevenue: false },
    now,
    "30d",
  );
  const out: AwardStat[] = [];
  // A zero is never put forward: an award card that says "0" helps nobody.
  if (n.cuts) {
    out.push({ key: "appointments", label: "Appointments in the last 30 days", value: String(n.cuts) });
  }
  if (n.clients) {
    out.push({ key: "clients", label: "Clients served in the last 30 days", value: String(n.clients) });
  }
  const before = n.previous.cuts;
  if (n.cuts !== null && before !== null && before > 0) {
    const pct = Math.round(((n.cuts - before) / before) * 100);
    out.push({
      key: "growth",
      label: "Appointments compared with the 30 days before",
      value: `${pct > 0 ? "+" : ""}${pct}%`,
    });
  }
  if (n.rating && n.rating.count > 0 && n.rating.average !== null) {
    out.push({
      key: "rating",
      label: "Rating",
      value: `${n.rating.average.toFixed(1)} stars from ${n.rating.count} review${n.rating.count === 1 ? "" : "s"}`,
    });
  }
  return out;
}

/** Only the stats chosen, in the order the shop sees them. Unknown keys drop. */
export function pickStats(all: AwardStat[], keys: readonly string[] | undefined): AwardStat[] {
  if (!keys) return all;
  const wanted = new Set(keys.filter((k): k is AwardStatKey => (AWARD_STAT_KEYS as readonly string[]).includes(k)));
  return all.filter((s) => wanted.has(s.key as AwardStatKey));
}

/** Tolerant read of a stored stats snapshot. */
export function readStats(raw: unknown): AwardStat[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => {
    if (typeof s !== "object" || s === null) return [];
    const { key, label, value } = s as Record<string, unknown>;
    return typeof key === "string" && typeof label === "string" && typeof value === "string"
      ? [{ key, label, value }]
      : [];
  });
}

/**
 * The award a shop's public page shows right now, or null: the newest one
 * still showing (its month, or the month after - config awardIsShowing).
 * Plain prisma, scoped by shop id: the award tables are default-deny.
 */
export async function publicAwardFor(shopId: string, now: Date = new Date()): Promise<PublicAward | null> {
  const current = awardMonthKey(now);
  const award = await prisma.providerAward.findFirst({
    where: { shopId, month: { in: [current, previousMonthKey(current)] } },
    orderBy: { month: "desc" },
  });
  if (!award || !awardIsShowing(award.month, now)) return null;
  return {
    month: award.month,
    monthLabel: monthLabel(award.month),
    title: award.title,
    winnerName: award.winnerName,
    headline: award.headline,
    description: award.description,
    stats: readStats(award.stats),
  };
}
