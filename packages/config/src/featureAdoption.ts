/**
 * "What other shops use": platform-wide feature adoption, shown on Insights.
 *
 * A shop asked to see which features are popular ("lots of shops use this, how
 * do I get it?" / "hardly anyone uses this, should I keep it?"). The owner
 * approved TOTALS ONLY. So this is the one place that says what a total is
 * allowed to look like, and both the API (which computes it) and the web
 * (which draws it) read it from here.
 *
 * 🔴 THE PRIVACY FLOOR. Small numbers re-identify shops: with three shops on
 * the platform, "33% use a custom domain" tells a shop exactly what one of the
 * other two does. Below `minPopulation` qualifying shops the API returns NO
 * rows at all and the card is not drawn. Above it, every figure is a
 * percentage rounded to `roundToPct`, and no count, name, id or per-shop row
 * ever leaves the server. The one-shop rule still holds: nothing here lets a
 * shop learn that another specific shop exists or what it does.
 *
 * Who counts (the population) is decided in apps/api/src/engines/
 * featureAdoption.ts: real, active shops only - not the demo tenant, not
 * seeded or test accounts, and not a shop with no booking in
 * `activeWindowDays`. The viewing shop is one of them, never singled out.
 */
import { DEMO } from "./demo.js";

export const FEATURE_ADOPTION = {
  /** Fewest qualifying shops before any figure is shown. Below it: nothing. */
  minPopulation: 10,
  /** Every percentage is rounded to the nearest multiple of this. */
  roundToPct: 5,
  /** "Active" = a booking made or held within this many days. */
  activeWindowDays: 30,
  /** How long one platform-wide computation is reused before it is redone. */
  cacheTtlMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * Owner accounts that are never a real shop: the live-demo tenant (DEMO in
 * ./demo.ts), the App Store review account (apps/api/scripts/seed-appreview.ts)
 * and the local dev seed (packages/db/prisma/seed.ts). Lowercase.
 */
export const ADOPTION_EXCLUDED_OWNER_EMAILS: readonly string[] = [
  DEMO.OWNER_EMAIL,
  "appreview@getchairback.com",
  "drick@example.com",
];

/**
 * Owner email domains that only ever hold test or seed data: `test.local` is
 * what the API test suite signs up with, `example.com` is the seed domain.
 */
export const ADOPTION_EXCLUDED_OWNER_DOMAINS = ["test.local", "example.com"] as const;

export type FeatureAdoptionId =
  | "rewards"
  | "rebook_nudges"
  | "auto_fill"
  | "waitlist"
  | "card_at_booking"
  | "service_groups"
  | "special_pricing"
  | "client_messages"
  | "online_booking"
  | "custom_domain";

/**
 * Which plans include a feature. Mirrors what the SERVER enforces, never the
 * marketing copy (see the `tier` note in ./features.ts): "premium" features
 * are refused or skipped for a shop without hasPremiumAccess (Starter, after
 * its trial). Everything else works on every plan.
 */
export type AdoptionPlanGate = "all" | "premium";

export interface AdoptionFeature {
  id: FeatureAdoptionId;
  /** Short row label. */
  label: string;
  /** Where a shop turns it on. */
  href: string;
  gate: AdoptionPlanGate;
}

/**
 * The features measured, in the order the card lists them. Each one is a
 * signal ChairBack already stores - the exact SQL is in the API engine.
 */
export const ADOPTION_FEATURES: readonly AdoptionFeature[] = [
  { id: "online_booking", label: "Online booking", href: "/dashboard/booking?tab=Settings", gate: "all" },
  { id: "rewards", label: "Rewards & punch cards", href: "/dashboard/rewards", gate: "all" },
  { id: "card_at_booking", label: "Card or deposit at booking", href: "/dashboard/payments", gate: "all" },
  { id: "client_messages", label: "Messages or promos to clients", href: "/dashboard/clients", gate: "all" },
  { id: "service_groups", label: "Service groups", href: "/dashboard/booking?tab=Services", gate: "all" },
  { id: "special_pricing", label: "Holiday, weekday or time-of-day pricing", href: "/dashboard/booking?tab=Services", gate: "all" },
  { id: "custom_domain", label: "Your own domain", href: "/dashboard/site", gate: "all" },
  { id: "rebook_nudges", label: "Rebooking nudges", href: "/dashboard/nudges", gate: "premium" },
  { id: "waitlist", label: "Waitlist", href: "/dashboard/booking?tab=Waitlist", gate: "premium" },
  { id: "auto_fill", label: "Auto-fill cancellations", href: "/dashboard/booking?tab=Settings", gate: "premium" },
] as const;

/** Is a population big enough to show anything at all? */
export function adoptionPopulationVisible(population: number): boolean {
  return Number.isFinite(population) && population >= FEATURE_ADOPTION.minPopulation;
}

/**
 * `count` of `population` as a percentage rounded to the nearest
 * FEATURE_ADOPTION.roundToPct, clamped to 0..100. Halves round up.
 */
export function roundAdoptionPct(count: number, population: number): number {
  if (!(population > 0) || !(count > 0)) return 0;
  const step = FEATURE_ADOPTION.roundToPct;
  const raw = (Math.min(count, population) / population) * 100;
  return Math.min(100, Math.max(0, Math.round(raw / step) * step));
}

/** One row of GET /api/insights/feature-adoption. Nothing else per row, ever. */
export interface FeatureAdoptionRow {
  id: FeatureAdoptionId;
  label: string;
  href: string;
  /** Share of qualifying shops using it, rounded to FEATURE_ADOPTION.roundToPct. */
  pct: number;
  /** The viewing shop uses it. */
  youUseIt: boolean;
  /** The viewing shop's plan includes it. */
  inYourPlan: boolean;
}

/** `features` is EMPTY below the privacy floor; the card then draws nothing. */
export interface FeatureAdoptionResponse {
  features: FeatureAdoptionRow[];
}
