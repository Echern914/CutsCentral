import {
  LOYALTY_TIER_KEYS,
  LOYALTY_TIERS,
  TIER_MAX_VISITS,
  TIER_MIN_VISITS,
  parseTierThresholds,
  type LoyaltyTierKey,
  type TierThresholds,
} from "./constants.js";

/**
 * WHAT IT TAKES TO REACH EACH TIER AT ONE SHOP (Shop.tierRules).
 *
 * Tiers started as one number each: lifetime completed visits. That is right
 * for a shop whose regulars come on a rhythm, and wrong for plenty of others -
 * "Gold is someone who spends $300 AND comes in twice a month" cannot be said
 * with a visit count. So each tier now carries up to three requirements, each
 * with its own look-back:
 *
 *   visits     - completed visits, all time or in the last 30/90/180/365 days
 *   spend      - money earned from them, same windows
 *   avgTicket  - the AVERAGE TICKET over the same windows (see below)
 *
 * and says whether it needs ALL of them or ANY one.
 *
 * 🔴 AVERAGE TICKET, EXACTLY. avgTicket = (sum of the amounts of the client's
 * QUALIFYING visits) / (how many qualifying visits), over the same window.
 * Numerator and denominator are the SAME set of visits:
 *   - COMPLETED only. A no-show, a cancellation, and a booking whose time has
 *     passed but was never completed are in neither half.
 *   - Each visit's amount is the per-visit figure revenue already uses
 *     (readChairEvents' earnedCents): the checkout figure plus anything paid
 *     through ChairBack, net of refunds, tips never included; else the ticket.
 *   - A visit whose amount is UNKNOWN (an imported visit with no price, a
 *     native booking with no price and no payment) is left out of BOTH halves
 *     rather than averaged in as $0.
 *   - A native booking and the Visit it was promoted into are one visit.
 * Zero qualifying visits = no average (null), and a tier asking for an average
 * ticket is then NOT met - "no data" is never read as "at least $X".
 *
 * 🔴 ONE EVALUATION, EVERYWHERE. The stored badge (Client.loyaltyTier, written
 * on each visit and by the recompute), the customer's live progress bar, and
 * the barber's preview all call tierForStats / tierRulesProgress below. Two
 * definitions of "Gold" would disagree the first time either changed, and the
 * customer would see a bar that says one thing under a badge that says another.
 *
 * 🔴 A SHOP THAT NEVER TOUCHED THIS BEHAVES EXACTLY AS BEFORE. With no stored
 * rules, the rules are derived from Shop.tierThresholds (lifetime visits only),
 * and tierThresholds.test / tierRules.test prove the two agree at every count.
 *
 * A client EARNS the HIGHEST tier whose rule they meet, and HOLDS that or a
 * higher tier the shop set by hand - effectiveTier(), up only. Money is integer
 * cents, never dollars - see ChairEvent.earnedCents.
 */

/** How far back a requirement looks, in days. 0 = all time. */
export const TIER_WINDOWS = [0, 30, 90, 180, 365] as const;
export type TierWindowDays = (typeof TIER_WINDOWS)[number];

/** Spend bounds: a whole dollar up to $100,000, in cents. */
export const TIER_MIN_SPEND_CENTS = 100;
export const TIER_MAX_SPEND_CENTS = 10_000_000;

/** Average-ticket bounds: a whole dollar up to $10,000 a visit, in cents. */
export const TIER_MIN_AVG_TICKET_CENTS = 100;
export const TIER_MAX_AVG_TICKET_CENTS = 1_000_000;

export interface TierVisitRequirement {
  min: number;
  windowDays: TierWindowDays;
}

export interface TierSpendRequirement {
  minCents: number;
  windowDays: TierWindowDays;
}

/** An average ticket of at least `minCents`, over `windowDays`. */
export interface TierAvgTicketRequirement {
  minCents: number;
  windowDays: TierWindowDays;
}

export interface TierRule {
  visits: TierVisitRequirement | null;
  spend: TierSpendRequirement | null;
  /**
   * OPTIONAL ON PURPOSE: every rule stored before this measure existed has no
   * such key, and validateTierRules leaves it absent when it is not set - so a
   * shop that never uses it stores, returns and compares exactly as before.
   * Read it as `rule.avgTicket ?? null`.
   */
  avgTicket?: TierAvgTicketRequirement | null;
  /** "all": every requirement set here. "any": one is enough. Moot with one. */
  match: "all" | "any";
}

export type TierRules = Record<LoyaltyTierKey, TierRule>;

/** What is stored in Shop.tierRules. Versioned so a later shape can be told apart. */
export interface StoredTierRules {
  version: 1;
  tiers: TierRules;
}

/** The rules a shop has always had: lifetime visits, nothing else. */
export function rulesFromThresholds(t: TierThresholds): TierRules {
  const rules = {} as TierRules;
  for (const key of LOYALTY_TIER_KEYS) {
    rules[key] = { visits: { min: t[key], windowDays: 0 }, spend: null, match: "all" };
  }
  return rules;
}

export type TierRuleError =
  | "no_requirement"
  | "visits_out_of_range"
  | "spend_out_of_range"
  | "avg_ticket_out_of_range"
  | "bad_window"
  | "bad_match"
  | "easier_than_below"
  | "same_as_below";

const isWindow = (v: unknown): v is TierWindowDays =>
  typeof v === "number" && (TIER_WINDOWS as readonly number[]).includes(v);

/**
 * Validate a proposed set. Refuses rather than repairs, for the same reason
 * validateTierThresholds does: a quietly "fixed" rule is one the owner never
 * chose, discovered from a client's badge.
 *
 * The ORDER check is deliberately narrow. Two requirements are compared only
 * when they measure the same thing over the same window ("visits in 30 days"
 * against "visits in 30 days") - then the higher tier may not ask for less.
 * Rules that measure different things cannot be ranked honestly, and a tier
 * identical to the one below it would make the lower one unreachable.
 */
export function validateTierRules(
  input: unknown,
): { ok: true; value: TierRules } | { ok: false; error: TierRuleError; tier: LoyaltyTierKey } {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const value = {} as TierRules;

  for (const key of LOYALTY_TIER_KEYS) {
    const raw = (src[key] && typeof src[key] === "object" ? src[key] : {}) as Record<string, unknown>;
    const match = raw.match ?? "all";
    if (match !== "all" && match !== "any") return { ok: false, error: "bad_match", tier: key };

    let visits: TierVisitRequirement | null = null;
    if (raw.visits != null) {
      const v = raw.visits as Record<string, unknown>;
      if (!isWindow(v.windowDays)) return { ok: false, error: "bad_window", tier: key };
      const min = v.min;
      if (typeof min !== "number" || !Number.isInteger(min) || min < TIER_MIN_VISITS || min > TIER_MAX_VISITS) {
        return { ok: false, error: "visits_out_of_range", tier: key };
      }
      visits = { min, windowDays: v.windowDays };
    }

    let spend: TierSpendRequirement | null = null;
    if (raw.spend != null) {
      const s = raw.spend as Record<string, unknown>;
      if (!isWindow(s.windowDays)) return { ok: false, error: "bad_window", tier: key };
      const minCents = s.minCents;
      if (
        typeof minCents !== "number" ||
        !Number.isInteger(minCents) ||
        minCents < TIER_MIN_SPEND_CENTS ||
        minCents > TIER_MAX_SPEND_CENTS
      ) {
        return { ok: false, error: "spend_out_of_range", tier: key };
      }
      spend = { minCents, windowDays: s.windowDays };
    }

    let avgTicket: TierAvgTicketRequirement | null = null;
    if (raw.avgTicket != null) {
      const a = raw.avgTicket as Record<string, unknown>;
      if (!isWindow(a.windowDays)) return { ok: false, error: "bad_window", tier: key };
      const minCents = a.minCents;
      if (
        typeof minCents !== "number" ||
        !Number.isInteger(minCents) ||
        minCents < TIER_MIN_AVG_TICKET_CENTS ||
        minCents > TIER_MAX_AVG_TICKET_CENTS
      ) {
        return { ok: false, error: "avg_ticket_out_of_range", tier: key };
      }
      avgTicket = { minCents, windowDays: a.windowDays };
    }

    if (!visits && !spend && !avgTicket) return { ok: false, error: "no_requirement", tier: key };
    // The key is present only when the measure is set: a rule without it is
    // byte-for-byte the rule this shop stored before the measure existed.
    value[key] = avgTicket ? { visits, spend, avgTicket, match } : { visits, spend, match };
  }

  for (let i = 1; i < LOYALTY_TIER_KEYS.length; i++) {
    const lower = value[LOYALTY_TIER_KEYS[i - 1]!];
    const key = LOYALTY_TIER_KEYS[i]!;
    const higher = value[key];
    if (
      higher.visits &&
      lower.visits &&
      higher.visits.windowDays === lower.visits.windowDays &&
      higher.visits.min < lower.visits.min
    ) {
      return { ok: false, error: "easier_than_below", tier: key };
    }
    if (
      higher.spend &&
      lower.spend &&
      higher.spend.windowDays === lower.spend.windowDays &&
      higher.spend.minCents < lower.spend.minCents
    ) {
      return { ok: false, error: "easier_than_below", tier: key };
    }
    const hAvg = higher.avgTicket ?? null;
    const lAvg = lower.avgTicket ?? null;
    if (hAvg && lAvg && hAvg.windowDays === lAvg.windowDays && hAvg.minCents < lAvg.minCents) {
      return { ok: false, error: "easier_than_below", tier: key };
    }
    if (sameRule(higher, lower)) return { ok: false, error: "same_as_below", tier: key };
  }
  return { ok: true, value };
}

/** How many requirements a rule sets - 1 to 3. */
function requirementCount(r: TierRule): number {
  return [r.visits, r.spend, r.avgTicket ?? null].filter(Boolean).length;
}

function sameRule(a: TierRule, b: TierRule): boolean {
  return (
    a.visits?.min === b.visits?.min &&
    a.visits?.windowDays === b.visits?.windowDays &&
    a.spend?.minCents === b.spend?.minCents &&
    a.spend?.windowDays === b.spend?.windowDays &&
    a.avgTicket?.minCents === b.avgTicket?.minCents &&
    a.avgTicket?.windowDays === b.avgTicket?.windowDays &&
    // "all" and "any" only differ when there are two or more requirements.
    (requirementCount(a) < 2 || a.match === b.match)
  );
}

/**
 * The rules a shop runs on. Stored rules when they validate; otherwise the
 * shop's visit thresholds (or the platform defaults) as rules - so an old row,
 * a hand-edited row, or no row at all can never throw on a page load.
 */
export function parseTierRules(rawRules: unknown, rawThresholds: unknown): TierRules {
  if (rawRules && typeof rawRules === "object" && !Array.isArray(rawRules)) {
    const stored = rawRules as Partial<StoredTierRules>;
    if (stored.version === 1) {
      const checked = validateTierRules(stored.tiers);
      if (checked.ok) return checked.value;
    }
  }
  return rulesFromThresholds(parseTierThresholds(rawThresholds));
}

export function toStoredTierRules(rules: TierRules): StoredTierRules {
  return { version: 1, tiers: rules };
}

/**
 * True when a tier can change with nothing happening at the shop - a visit
 * ageing out of "the last 30 days" - or when money decides it, which moves on
 * refunds and checkouts rather than only on visits. Those shops need the daily
 * recompute; a lifetime-visits shop is kept exact by the visit writes alone.
 * An average ticket is money too - a refund moves it - so it always needs it.
 */
export function tierRulesNeedDailyRecompute(rules: TierRules): boolean {
  return LOYALTY_TIER_KEYS.some((k) => {
    const r = rules[k];
    return (
      r.spend !== null ||
      (r.avgTicket ?? null) !== null ||
      (r.visits !== null && r.visits.windowDays !== 0)
    );
  });
}

/** Which windows the stats have to be counted over for these rules. */
export function tierStatWindows(rules: TierRules): {
  visits: TierWindowDays[];
  spend: TierWindowDays[];
  avgTicket: TierWindowDays[];
} {
  const visits = new Set<TierWindowDays>();
  const spend = new Set<TierWindowDays>();
  const avgTicket = new Set<TierWindowDays>();
  for (const k of LOYALTY_TIER_KEYS) {
    const r = rules[k];
    if (r.visits) visits.add(r.visits.windowDays);
    if (r.spend) spend.add(r.spend.windowDays);
    if (r.avgTicket) avgTicket.add(r.avgTicket.windowDays);
  }
  return { visits: [...visits], spend: [...spend], avgTicket: [...avgTicket] };
}

/** One client's numbers, counted over exactly the windows tierStatWindows named. */
export interface TierStats {
  visits: Partial<Record<TierWindowDays, number>>;
  spendCents: Partial<Record<TierWindowDays, number>>;
  /**
   * The average ticket per window, in cents (see the header for exactly what
   * is averaged), or NULL when the window holds no qualifying visit. Present
   * only when the rules ask about an average - a shop that never does carries
   * the same numbers it always did.
   */
  avgTicketCents?: Partial<Record<TierWindowDays, number | null>>;
}

/**
 * The average ticket over a set of visit amounts (integer cents), rounded to
 * the cent, or null for none. THE one arithmetic for it: the stats loader
 * and anything that previews an average call this, so the two can never round
 * differently. The caller hands over only QUALIFYING amounts - see the header.
 */
export function averageTicketCents(amountsCents: readonly number[]): number | null {
  if (amountsCents.length === 0) return null;
  const total = amountsCents.reduce((a, b) => a + b, 0);
  return Math.round(total / amountsCents.length);
}

export type TierMeasure = "visits" | "spend" | "avgTicket";

export interface TierRequirementProgress {
  kind: TierMeasure;
  /**
   * Completed visits, or cents earned, in the window. For avgTicket the
   * average in cents - 0 when there is none (see `noAverage`).
   */
  have: number;
  need: number;
  windowDays: TierWindowDays;
  met: boolean;
  /** 0..1 toward `need`. */
  fraction: number;
  /** avgTicket only: true when the window holds no qualifying visit at all. */
  noAverage?: boolean;
}

function stat(stats: TierStats, kind: "visits" | "spend", windowDays: TierWindowDays): number {
  const n = kind === "visits" ? stats.visits[windowDays] : stats.spendCents[windowDays];
  // A missing window is a loader that disagrees with the rules - a bug, not a
  // zero. Reading it as 0 would quietly strip clients of tiers they hold.
  if (n === undefined) throw new Error(`tier stats missing ${kind} window ${windowDays}`);
  return Math.max(0, n);
}

/** The average for a window: a number, or null for "no qualifying visit". */
function avgStat(stats: TierStats, windowDays: TierWindowDays): number | null {
  const n = stats.avgTicketCents?.[windowDays];
  // Same rule as stat(): a window the loader never filled is a bug. Null is
  // a real answer (no visits to average); undefined is not.
  if (n === undefined) throw new Error(`tier stats missing avgTicket window ${windowDays}`);
  return n === null ? null : Math.max(0, n);
}

function requirementsOf(rule: TierRule, stats: TierStats): TierRequirementProgress[] {
  const out: TierRequirementProgress[] = [];
  if (rule.visits) {
    const have = Math.floor(stat(stats, "visits", rule.visits.windowDays));
    out.push({
      kind: "visits",
      have,
      need: rule.visits.min,
      windowDays: rule.visits.windowDays,
      met: have >= rule.visits.min,
      fraction: Math.min(1, have / rule.visits.min),
    });
  }
  if (rule.spend) {
    const have = Math.round(stat(stats, "spend", rule.spend.windowDays));
    out.push({
      kind: "spend",
      have,
      need: rule.spend.minCents,
      windowDays: rule.spend.windowDays,
      met: have >= rule.spend.minCents,
      fraction: Math.min(1, have / rule.spend.minCents),
    });
  }
  if (rule.avgTicket) {
    const avg = avgStat(stats, rule.avgTicket.windowDays);
    const have = avg === null ? 0 : Math.round(avg);
    out.push({
      kind: "avgTicket",
      have,
      need: rule.avgTicket.minCents,
      windowDays: rule.avgTicket.windowDays,
      // 🔴 No average is NOT met, whatever the threshold.
      met: avg !== null && have >= rule.avgTicket.minCents,
      fraction: avg === null ? 0 : Math.min(1, have / rule.avgTicket.minCents),
      noAverage: avg === null,
    });
  }
  return out;
}

function ruleMet(rule: TierRule, stats: TierStats): boolean {
  const reqs = requirementsOf(rule, stats);
  return rule.match === "any" ? reqs.some((r) => r.met) : reqs.every((r) => r.met);
}

/**
 * The tier these numbers EARN under these rules: the highest one met, or null.
 * Pure - it knows nothing of a tier set by hand. What a client HOLDS is
 * effectiveTier(earned, floor) below.
 */
export function tierForStats(stats: TierStats, rules: TierRules): LoyaltyTierKey | null {
  for (let i = LOYALTY_TIER_KEYS.length - 1; i >= 0; i--) {
    const key = LOYALTY_TIER_KEYS[i]!;
    if (ruleMet(rules[key], stats)) return key;
  }
  return null;
}

/** A tier's place on the ladder, low to high: -1 for none (or a key this build does not know). */
export function tierRank(tier: LoyaltyTierKey | null | undefined): number {
  return tier ? LOYALTY_TIER_KEYS.indexOf(tier) : -1;
}

/**
 * THE TIER A CLIENT HOLDS: what they earned, or the tier the shop raised them
 * to by hand (Client.loyaltyTierFloor), whichever is HIGHER.
 *
 * 🔴 UP ONLY, AND IT STICKS. The floor never replaces the earned tier - the
 * rules can still lift the client past it - and nothing the rules do can drop
 * them below it. Every writer of the stored Client.loyaltyTier (a completed
 * visit, the rules recompute, the daily job, the setter) stamps THIS, so every
 * reader of the column (list filters, broadcast audiences, tier openings, the
 * waitlist) sees the shop's choice without knowing a floor exists.
 *
 * A floor this build does not recognise ranks as none, so it can never lift
 * anyone by accident.
 */
export function effectiveTier(
  earned: LoyaltyTierKey | null,
  floor: LoyaltyTierKey | null | undefined,
): LoyaltyTierKey | null {
  return tierRank(floor) > tierRank(earned) ? floor! : earned;
}

export interface TierRulesProgress {
  /**
   * The tier HELD: effectiveTier(earned, floor). Everything below - next,
   * requirements, fraction - is measured from here, so a client raised to
   * Silver by hand is shown the road to Gold, not the road to Silver.
   */
  current: LoyaltyTierKey | null;
  /** What the rules alone give them (tierForStats), whatever the floor. */
  earned: LoyaltyTierKey | null;
  /**
   * True only when the floor is what holds them up - it is ABOVE what they
   * earned. A floor they have since earned their way past is dormant (it still
   * catches them if they slip), and reads false.
   */
  setByHand: boolean;
  next: LoyaltyTierKey | null;
  /** How the next tier combines its requirements. */
  match: "all" | "any";
  /** The next tier's requirements against these numbers. Empty at the top. */
  requirements: TierRequirementProgress[];
  /**
   * 0..1 toward the next tier, for one bar. "all": the average of what is
   * left, because every piece has to be finished. "any": the closest one,
   * because that is the one that will get them there. 1 at the top.
   *
   * A lone visits requirement measures band to band - from the tier held to
   * the one chased - exactly as loyaltyTierProgress always has, so a client one
   * visit from Gold sees a nearly full bar rather than a creeping one.
   */
  fraction: number;
  /** Visits still needed for the next tier's visit requirement; 0 if it has none. */
  visitsToNext: number;
}

/**
 * @param floor Client.loyaltyTierFloor - a tier set by hand. Omit (or null)
 *              and this is exactly the earned view it always was.
 */
export function tierRulesProgress(
  stats: TierStats,
  rules: TierRules,
  floor?: LoyaltyTierKey | null,
): TierRulesProgress {
  const earned = tierForStats(stats, rules);
  const current = effectiveTier(earned, floor);
  const setByHand = current !== earned;
  const next = LOYALTY_TIER_KEYS[tierRank(current) + 1] ?? null;
  if (!next) {
    return { current, earned, setByHand, next: null, match: "all", requirements: [], fraction: 1, visitsToNext: 0 };
  }

  const rule = rules[next];
  const requirements = requirementsOf(rule, stats);
  const held = current ? rules[current] : null;
  const banded = requirements.map((r) => {
    // The floor of the band: what the held tier asked of the same measure over
    // the same window, else zero.
    const floorReq =
      r.kind === "visits"
        ? held?.visits?.windowDays === r.windowDays
          ? held.visits.min
          : 0
        : r.kind === "spend"
          ? held?.spend?.windowDays === r.windowDays
            ? held.spend.minCents
            : 0
          : held?.avgTicket?.windowDays === r.windowDays
            ? held.avgTicket.minCents
            : 0;
    // No average at all is no progress toward one.
    if (r.noAverage) return 0;
    const from = floorReq < r.need ? floorReq : 0;
    const span = Math.max(1, r.need - from);
    return Math.min(Math.max(r.have - from, 0), span) / span;
  });
  const fraction =
    banded.length === 0
      ? 0
      : rule.match === "any"
        ? Math.max(...banded)
        : banded.reduce((a, b) => a + b, 0) / banded.length;
  const visitReq = requirements.find((r) => r.kind === "visits");
  return {
    current,
    earned,
    setByHand,
    next,
    match: rule.match,
    requirements,
    fraction,
    visitsToNext: visitReq ? Math.max(0, visitReq.need - visitReq.have) : 0,
  };
}

//  Words - one phrasing for the barber's editor, the customer's app and the page

export function tierWindowPhrase(windowDays: TierWindowDays): string {
  switch (windowDays) {
    case 0:
      return "all time";
    case 30:
      return "in the last 30 days";
    case 90:
      return "in the last 3 months";
    case 180:
      return "in the last 6 months";
    case 365:
      return "in the last year";
  }
}

/** "$300" for whole dollars, "$12.50" otherwise. */
export function formatTierMoney(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function requirementPhrase(kind: TierMeasure, amount: number, windowDays: TierWindowDays): string {
  const what =
    kind === "visits"
      ? `${amount} ${amount === 1 ? "visit" : "visits"}`
      : kind === "spend"
        ? `${formatTierMoney(amount)} spent`
        : `an average ticket of ${formatTierMoney(amount)}`;
  return windowDays === 0 ? what : `${what} ${tierWindowPhrase(windowDays)}`;
}

/**
 * "4 visits in the last 30 days and $300 spent" - what a tier takes, in a
 * sentence. With an average: "... and an average ticket of $60".
 */
export function describeTierRule(rule: TierRule): string {
  const parts: string[] = [];
  if (rule.visits) parts.push(requirementPhrase("visits", rule.visits.min, rule.visits.windowDays));
  if (rule.spend) parts.push(requirementPhrase("spend", rule.spend.minCents, rule.spend.windowDays));
  if (rule.avgTicket) {
    parts.push(requirementPhrase("avgTicket", rule.avgTicket.minCents, rule.avgTicket.windowDays));
  }
  return parts.join(rule.match === "any" ? " or " : " and ");
}

/**
 * "2 of 4 visits in the last 30 days" / "$120 of $300 spent" - one requirement's
 * standing. A met one states what they have ("$340 spent"): "$340 of $300"
 * reads like arithmetic, not like done.
 */
export function describeRequirementProgress(r: TierRequirementProgress): string {
  const window = r.windowDays === 0 ? "" : ` ${tierWindowPhrase(r.windowDays)}`;
  if (r.kind === "visits") {
    return r.met
      ? `${r.have} ${r.have === 1 ? "visit" : "visits"}${window}`
      : `${r.have} of ${r.need} ${r.need === 1 ? "visit" : "visits"}${window}`;
  }
  if (r.kind === "avgTicket") {
    if (r.noAverage) return `No average ticket yet${window}`;
    return r.met
      ? `${formatTierMoney(r.have)} average ticket${window}`
      : `${formatTierMoney(r.have)} of a ${formatTierMoney(r.need)} average ticket${window}`;
  }
  return r.met
    ? `${formatTierMoney(r.have)} spent${window}`
    : `${formatTierMoney(r.have)} of ${formatTierMoney(r.need)} spent${window}`;
}

/**
 * What is left to reach the next tier, in one line: "2 more visits to Silver",
 * "1 more visit in the last 30 days and $150 more spent to reach Gold".
 *
 * Only what is still missing is named - a requirement already met is done, and
 * listing it reads as though it were not. With "any", every requirement is
 * named, because finishing any one of them is enough.
 */
export function describeTierGap(
  progress: Pick<TierRulesProgress, "next" | "match" | "requirements">,
): string | null {
  if (!progress.next) return null;
  const label = LOYALTY_TIERS[progress.next].label;
  const open = progress.requirements.filter((r) => !r.met);
  if (open.length === 0) return null;
  const parts = open.map((r) => {
    const window = r.windowDays === 0 ? "" : ` ${tierWindowPhrase(r.windowDays)}`;
    const left = r.need - r.have;
    // An average is not topped up like a total - "$12 more" of an average
    // means nothing a client can act on - so the target itself is named.
    if (r.kind === "avgTicket") return `an average ticket of ${formatTierMoney(r.need)}${window}`;
    return r.kind === "visits"
      ? `${left} more ${left === 1 ? "visit" : "visits"}${window}`
      : `${formatTierMoney(left)} more spent${window}`;
  });
  const lone = open.length === 1 && open[0]!.windowDays === 0 && open[0]!.kind !== "avgTicket";
  return `${parts.join(progress.match === "any" ? " or " : " and ")} ${lone ? "to" : "to reach"} ${label}`;
}

/**
 * Where a client stands on each rung of the ladder, for the "Your status"
 * card: the tier they hold is "here", the ones below it "reached", the one
 * right above it "next" (the first rung, before any tier), the rest "ahead".
 * The ladder arrives low to high (loyaltyView's `ladder`); a held tier the
 * ladder doesn't list marks nothing as here.
 */
export type LadderState = "here" | "reached" | "next" | "ahead";
export function ladderStates<T extends { tier: string }>(ladder: readonly T[], held: string | null): Array<T & { state: LadderState }> {
  const at = held ? ladder.findIndex((r) => r.tier === held) : -1;
  if (held && at === -1) return ladder.map((r) => ({ ...r, state: "ahead" as const }));
  return ladder.map((r, i) => ({ ...r, state: i < at ? "reached" : i === at ? "here" : i === at + 1 ? "next" : "ahead" }));
}

/** The tier's display label, for callers that hold only the key. */
export function tierLabel(key: LoyaltyTierKey): string {
  return LOYALTY_TIERS[key].label;
}

/**
 * Who a tier-aimed message goes to, in words: "Gold members", "Gold and Silver
 * members". Highest tier first, whatever order they were picked in, so the
 * same audience always reads the same way - in the composer, the preview and
 * the history line afterwards.
 *
 * A key this build does not know (history written by a later release) still
 * reads as a tier audience rather than vanishing: a blank would make a message
 * to the Gold members look like one to everyone.
 */
export function describeTierAudience(tiers: readonly string[]): string {
  if (tiers.length === 0) return "";
  const labels = [...LOYALTY_TIER_KEYS]
    .reverse()
    .filter((k) => tiers.includes(k))
    .map((k) => LOYALTY_TIERS[k].label);
  if (labels.length === 0) return "Loyalty tier members";
  const list =
    labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `${list} members`;
}
