"use client";

// Client module: it calls cap() from VocabProvider (see vocabUseClient.test),
// and only the owner's team card and the barber's Teams page render with it.
import type { BusinessVocabulary } from "@chairback/config";
import { cap } from "@/components/VocabProvider";

/** The counted numbers for one window, as the API sends them. `null` = not shared. */
export interface WindowNumbers {
  cuts: number | null;
  revenueCents: number | null;
  clients: number | null;
}

/**
 * The numbers an independent member shares with a team's owner, as the API
 * sends them (`services/teamLinks.ts`). `null` = not shared - the API never
 * computes it, and every page shows it as "Hidden".
 */
export interface TeamNumbers extends WindowNumbers {
  rating: { average: number | null; count: number } | null;
  /**
   * The same counts for the window just before, of the same length. Optional:
   * an API a deploy behind doesn't send it, and then there's simply no arrow.
   */
  previous?: WindowNumbers;
}

export const SHARE_KEYS = ["shareCuts", "shareRevenue", "shareClients", "shareRating"] as const;
export type ShareKey = (typeof SHARE_KEYS)[number];
export type Sharing = Record<ShareKey, boolean>;

/** Up, down or level against the window before, as a short tag. */
export interface Change {
  text: string;
  trend: "up" | "down" | "flat";
}

/**
 * "↑ 18%", "↓ 5%", "Same", or "↑ from 0" - against the window just before.
 * Null when there's nothing honest to say: the number is hidden, or the API
 * sent no previous window. Whole percents, rounded.
 */
export function changeOf(current: number | null, previous: number | null | undefined): Change | null {
  if (current === null || previous === null || previous === undefined) return null;
  if (previous === 0) {
    return current === 0 ? { text: "Same", trend: "flat" } : { text: "↑ from 0", trend: "up" };
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "Same", trend: "flat" };
  return pct > 0 ? { text: `↑ ${pct}%`, trend: "up" } : { text: `↓ ${Math.abs(pct)}%`, trend: "down" };
}

export interface TeamStat {
  key: ShareKey;
  label: string;
  /** What the owner reads; null = hidden. */
  value: string | null;
  /** Against the window before; null when hidden or not comparable. */
  change: Change | null;
}

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

/**
 * One row per shareable number, in the member's own vocabulary. The owner's
 * table and the member's "how your row looks" preview both render from this,
 * so the preview can't word anything differently from the real thing.
 */
export function teamStats(n: TeamNumbers, v: BusinessVocabulary): TeamStat[] {
  const p = n.previous;
  return [
    {
      key: "shareCuts",
      label: cap(v.serviceNounPlural),
      value: n.cuts === null ? null : n.cuts.toLocaleString(),
      change: changeOf(n.cuts, p?.cuts),
    },
    {
      key: "shareRevenue",
      label: "Revenue",
      // Whole dollars, exactly as their own Insights shows it.
      value: n.revenueCents === null ? null : dollars(n.revenueCents),
      change: changeOf(n.revenueCents, p?.revenueCents),
    },
    {
      key: "shareClients",
      label: cap(v.clientNounPlural),
      value: n.clients === null ? null : n.clients.toLocaleString(),
      change: changeOf(n.clients, p?.clients),
    },
    {
      key: "shareRating",
      label: "Rating",
      value:
        n.rating === null
          ? null
          : n.rating.average === null
            ? "No ratings yet"
            : `${n.rating.average.toFixed(1)} ★ (${n.rating.count})`,
      // All-time stars: there is no "window before" to compare with.
      change: null,
    },
  ];
}

/* ------------------------------ team totals ------------------------------ */

export interface TeamTotal {
  value: number | null;
  previous: number | null;
  sharedBy: number;
  of: number;
}

export interface TeamTotals {
  cuts: TeamTotal;
  revenueCents: TeamTotal;
  clients: TeamTotal;
  /** Booth rent: members with rent in effect who owe nothing right now. */
  rent: { paidUp: number; of: number };
}

export interface TotalTile {
  key: string;
  label: string;
  /** Null = nobody shares it. */
  value: string | null;
  change: Change | null;
  /** "From 2 of 3" - never read a partial sum as the whole team's. */
  note: string;
}

/** The overview tiles: summed from what's shared, and saying from how many. */
export function totalTiles(t: TeamTotals, v: BusinessVocabulary): TotalTile[] {
  const tile = (key: string, label: string, total: TeamTotal, fmt: (n: number) => string): TotalTile => ({
    key,
    label,
    value: total.value === null ? null : fmt(total.value),
    change: total.value === null ? null : changeOf(total.value, total.previous),
    note:
      total.sharedBy === 0
        ? "No one shares this"
        : total.sharedBy === total.of
          ? `All ${total.of} sharing`
          : `From ${total.sharedBy} of ${total.of} sharing`,
  });
  return [
    tile("cuts", cap(v.serviceNounPlural), t.cuts, (n) => n.toLocaleString()),
    tile("revenue", "Revenue", t.revenueCents, dollars),
    tile("clients", cap(v.clientNounPlural), t.clients, (n) => n.toLocaleString()),
    {
      key: "rent",
      label: "Booth rent",
      value: t.rent.of === 0 ? null : `${t.rent.paidUp} of ${t.rent.of}`,
      change: null,
      note: t.rent.of === 0 ? "No rent set" : t.rent.paidUp === t.rent.of ? "All paid up" : "Paid up",
    },
  ];
}

/* ------------------------------- activity ------------------------------- */

export interface TeamActivityItem {
  id: string;
  at: string;
  business: string;
  kind:
    | "requested"
    | "approved"
    | "declined"
    | "removed"
    | "left"
    | "withdrew"
    | "shared"
    | "hid"
    | "rent_paid";
  metric: string | null;
  amountCents: number | null;
  method: string | null;
}

/** One feed line, in the shop's own words. Never a member's number. */
export function activityLine(i: TeamActivityItem, v: BusinessVocabulary): string {
  const metric =
    i.metric === "cuts"
      ? v.serviceNounPlural
      : i.metric === "clients"
        ? v.clientNounPlural
        : i.metric === "revenue"
          ? "revenue"
          : i.metric === "rating"
            ? "rating"
            : "";
  switch (i.kind) {
    case "requested":
      return `${i.business} asked to join`;
    case "approved":
      return `${i.business} joined the team`;
    case "declined":
      return `You declined ${i.business}`;
    case "removed":
      return `You removed ${i.business}`;
    case "left":
      return `${i.business} left the team`;
    case "withdrew":
      return `${i.business} withdrew their request`;
    case "shared":
      return `${i.business} started sharing ${metric}`;
    case "hid":
      return `${i.business} stopped sharing ${metric}`;
    case "rent_paid":
      return `Rent recorded for ${i.business}: ${dollars(i.amountCents ?? 0)}${i.method ? ` (${i.method})` : ""}`;
  }
}

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function agoLabel(at: string, now: Date = new Date()): string {
  const min = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(at).toLocaleDateString();
}
