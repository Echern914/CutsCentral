import { apiGet } from "@/lib/api";

/**
 * The readiness report as the Assistant reads it.
 *
 * 🔴 NOTHING here recomputes a signal. `/api/readiness` already owns every
 * "what is wrong with this shop" question — it is role-aware, it is the only
 * dashboard router deliberately NOT behind the paywall (a lapsed shop has to be
 * able to read why nobody can book it), and it returns four customer-facing
 * milestones rather than eleven raw checks. Re-deriving any of it here would be
 * a second opinion that drifts.
 *
 * The wire shape is the router's; these are the fields the Assistant renders.
 */

/** A CTA the API already resolved against the caller's seat. */
export interface ReadinessCtaWire {
  label: string;
  /** Registry id, so a client can re-resolve with context the API lacks. */
  featureId: string;
  href: string;
}

export interface ReadinessItemWire {
  id: string;
  milestone: string | null;
  title: string;
  why: string;
  klass: "required" | "conditional" | "recommended" | "info";
  applicable: boolean;
  done: boolean;
  evidence: string;
  blocksLaunch: boolean;
  /** Lowest role that can actually resolve this. */
  role: "owner" | "manager" | "barber";
  /** Absent when the registry withholds the destination from this seat. */
  cta?: ReadinessCtaWire;
  staffId?: string;
}

export interface MilestoneWire {
  id: string;
  title: string;
  done: boolean;
  blocking: ReadinessItemWire[];
  applicableCount: number;
  completeCount: number;
}

export interface ShopReadinessWire {
  scope: "shop";
  liveNow: boolean;
  canGoLive: boolean;
  milestones: MilestoneWire[];
  milestonesComplete: number;
  milestonesBlocking: number;
  blocking: ReadinessItemWire[];
  items: ReadinessItemWire[];
}

export interface BarberReadinessWire {
  scope: "barber";
  staffId: string | null;
  chair: { staffId: string; name: string; applicableCount: number; completeCount: number } | null;
  personal: ReadinessItemWire[];
  managerOwned: ReadinessItemWire[];
  complete: number;
  applicable: number;
}

export type ReadinessWire = ShopReadinessWire | BarberReadinessWire;

/**
 * Fetch the report. Returns null on ANY failure.
 *
 * Silence is the correct behaviour, not a shortcut: the Assistant must render
 * for a shop whose API call failed exactly as it renders for a shop with
 * nothing wrong. A tab that errors because a diagnostic could not be read is
 * worse than one that quietly shows the parts that did load.
 */
export async function getReadiness(): Promise<ReadinessWire | null> {
  const res = await apiGet<ReadinessWire>("/api/readiness");
  return res.ok && res.data ? res.data : null;
}

/**
 * The ONE next thing to do, and the milestone it belongs to.
 *
 * Deliberately one item, not a list. A new shop shown "3 of 11" reads as a
 * chore; the same shop shown "Add a service — about 2 minutes" starts.
 */
export function nextStep(
  r: ReadinessWire | null,
  /** The shop's word for a workspace, for the own-scope milestone title. */
  stationNoun: string,
): {
  milestoneTitle: string;
  item: ReadinessItemWire;
  complete: number;
  total: number;
} | null {
  if (!r) return null;
  if (r.scope === "barber") {
    const item = r.personal.find((i) => !i.done && i.applicable);
    if (!item) return null;
    return {
      milestoneTitle: `Your ${stationNoun}`,
      item,
      complete: r.complete,
      total: r.applicable,
    };
  }
  const milestone = r.milestones.find((m) => !m.done);
  const item = milestone?.blocking.find((i) => !i.done);
  if (!milestone || !item) return null;
  return {
    milestoneTitle: milestone.title,
    item,
    complete: milestone.completeCount,
    total: milestone.applicableCount,
  };
}

/**
 * Everything currently wrong that this seat can see, worst first.
 *
 * `blocking` is the engine's own word for "this stops you taking bookings", so
 * those lead. Applicable-but-incomplete `conditional` items follow: a shop that
 * turned deposits on and never finished configuring them is broken in a way it
 * cannot see from any other screen. `info` items are true things a barber
 * cannot act on and are left out — this list is a to-do, not a status page.
 */
export function problems(
  r: ReadinessWire | null,
  /**
   * The item Continue-setup is already showing, if any. Excluded here so the
   * same fix is not printed twice, three inches apart, with two different
   * buttons that do the same thing.
   */
  excludeId?: string,
): ReadinessItemWire[] {
  if (!r) return [];
  const pool =
    r.scope === "barber" ? [...r.personal, ...r.managerOwned] : [...r.blocking, ...r.items];
  const seen = new Set<string>();
  return pool
    .filter((i) => {
      if (i.done || !i.applicable || i.klass === "info") return false;
      if (i.id === excludeId) return false;
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    })
    .sort((a, b) => Number(b.blocksLaunch) - Number(a.blocksLaunch));
}

/**
 * The CTA to render for an item, dropping one that points at the page we are
 * already on.
 *
 * `shop.preflight` ("everything needed to take a booking") resolves to the
 * Assistant, which is correct everywhere else in the product and circular here
 * — a button labelled "See what's left" that reloads the list it is sitting in.
 * The item keeps its title, its reason and its evidence; it just loses a link
 * to itself.
 */
export function ctaAwayFrom(
  item: ReadinessItemWire,
  ownHref: string,
): ReadinessCtaWire | undefined {
  if (!item.cta) return undefined;
  return item.cta.href === ownHref ? undefined : item.cta;
}
