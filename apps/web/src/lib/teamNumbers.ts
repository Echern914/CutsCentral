"use client";

// Client module: it calls cap() from VocabProvider (see vocabUseClient.test),
// and only the owner's team card and the barber's Teams page render with it.
import type { BusinessVocabulary } from "@chairback/config";
import { cap } from "@/components/VocabProvider";

/**
 * The numbers an independent member shares with a team's owner, as the API
 * sends them (`services/teamLinks.ts`). `null` = not shared - the API never
 * computes it, and every page shows it as "Hidden".
 */
export interface TeamNumbers {
  cuts: number | null;
  revenueCents: number | null;
  clients: number | null;
  rating: { average: number | null; count: number } | null;
}

export const SHARE_KEYS = ["shareCuts", "shareRevenue", "shareClients", "shareRating"] as const;
export type ShareKey = (typeof SHARE_KEYS)[number];
export type Sharing = Record<ShareKey, boolean>;

export interface TeamStat {
  key: ShareKey;
  label: string;
  /** What the owner reads; null = hidden. */
  value: string | null;
}

/**
 * One row per shareable number, in the member's own vocabulary. The owner's
 * table and the member's "what they see" preview both render from this, so
 * the preview can't word anything differently from the real thing.
 */
export function teamStats(n: TeamNumbers, v: BusinessVocabulary): TeamStat[] {
  return [
    {
      key: "shareCuts",
      label: cap(v.serviceNounPlural),
      value: n.cuts === null ? null : n.cuts.toLocaleString(),
    },
    {
      key: "shareRevenue",
      label: "Revenue",
      // Whole dollars, exactly as their own Insights shows it.
      value:
        n.revenueCents === null ? null : `$${Math.round(n.revenueCents / 100).toLocaleString()}`,
    },
    {
      key: "shareClients",
      label: cap(v.clientNounPlural),
      value: n.clients === null ? null : n.clients.toLocaleString(),
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
    },
  ];
}
