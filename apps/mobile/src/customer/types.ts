/**
 * The shapes /api/me answers with. MIRRORS apps/api/src/services/
 * customerPortal.ts - the API owns them; this file only describes them to the
 * app. Every display word the server can decide (status labels, the "waiting
 * on" line, vocabulary) arrives decided: the app renders, it does not re-derive
 * a status or guess a noun.
 */

export type CustomerStatus = "requested" | "booked" | "completed" | "canceled" | "no_show";
export type AppointmentSource = "chairback" | "acuity" | "square" | "manual";

export interface ShopRef {
  key: string;
  name: string;
  logoUrl: string | null;
  city: string | null;
  region: string | null;
  /** The shop's IANA zone: every date about this shop is read on its clock. */
  timezone: string;
}

export interface Appointment {
  id: string;
  source: AppointmentSource;
  status: CustomerStatus;
  statusLabel: string;
  statusDetail: string | null;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  serviceName: string | null;
  providerName: string | null;
  providerImageUrl: string | null;
  shop: ShopRef;
  canManage: boolean;
  manageNote: string | null;
}

export interface AppointmentDetail extends Appointment {
  address: string | null;
  durationMin: number | null;
  priceCents: number | null;
}

/**
 * A shop holding a profile that carries one of this customer's verified
 * contacts, which the API will NOT open on that contact alone - most often a
 * phone number more than one person uses.
 *
 * 🔴 NOTHING ABOUT THE PROFILE IS SENT: no name, no count, no visit, no
 * reward, no link. Only the shop's own public details, so the app can say
 * which shop needs connecting and how. There is nothing more to ask for.
 */
export interface AmbiguousShop {
  key: string;
  name: string;
  logoUrl: string | null;
  city: string | null;
  region: string | null;
}

export interface Shop extends ShopRef {
  heroImageUrl: string | null;
  lastVisitAt: string | null;
  usualService: string | null;
  providerNoun: string;
  serviceNoun: string;
  rewardsEnabled: boolean;
  hasUpcoming: boolean;
}

export interface RewardSummary {
  shop: ShopRef;
  cardName: string | null;
  balance: number;
  unit: "visits" | "punches";
  next: { rewardName: string; cost: number; remaining: number } | null;
  readyRewards: string[];
}

export interface Home {
  firstName: string | null;
  vocabulary: { providerNounPlural: string; serviceNoun: string };
  /** Full detail - carries the address the card's Directions action needs. */
  next: AppointmentDetail | null;
  upcomingCount: number;
  shops: Shop[];
  rewards: RewardSummary[];
  recent: Appointment[];
  /** Shops with a profile that needs the shop's own link to connect. */
  ambiguous: AmbiguousShop[];
  /**
   * Shops added by name ("Add to my shops"). Optional: this app can outlive the
   * API build that answers it, and an older answer simply has none.
   */
  saved?: SavedShop[];
}

/** A shop the customer added by name. Public details only - what "Find a shop" shows. */
export interface SavedShop {
  /** The saved row's id - the key for taking it back off the list. */
  key: string;
  name: string;
  handle: string;
  logoUrl: string | null;
  town: string | null;
  bookUrl: string;
}

export interface History {
  upcoming: Appointment[];
  past: Appointment[];
}

export interface RewardCard {
  name: string | null;
  balance: number;
  unit: "visits" | "punches";
  next: { rewardName: string; cost: number; remaining: number } | null;
  rewards: { name: string; description: string | null; cost: number; ready: boolean; remaining: number }[];
}

export type TierKey = "BRONZE" | "SILVER" | "GOLD";

/**
 * A slot a shop is holding for this customer's tier: theirs to book until
 * `heldUntil`, then anyone's.
 */
export interface Opening {
  id: string;
  shop: { name: string; logoUrl: string | null; timezone: string };
  startsAt: string;
  endsAt: string;
  serviceName: string | null;
  staffName: string | null;
  /** The shop's listed price, in dollars. Null when it has not priced it. */
  price: number | null;
  /** "Gold members", "Silver and Gold members" */
  audience: string;
  tierLabel: string;
  heldUntil: string;
  /** This shop approves bookings: booking sends a request, not a booking. */
  requiresApproval: boolean;
}

/** One requirement of the next tier, as the shop's rules count it. */
export interface TierRequirement {
  kind: "visits" | "spend";
  met: boolean;
  /** "1 of 2 visits in the last 30 days" / "$300 spent" */
  text: string;
}

/** A rung of a shop's ladder: what the tier takes there, and what it gets. */
export interface TierRung {
  tier: TierKey;
  label: string;
  color: string;
  takes: string;
  perk: string | null;
}

export interface RewardProgram {
  shop: ShopRef;
  /**
   * Everything added after the first release is optional: an app build can
   * outlive the API that answers it, and an older answer simply lacks them.
   */
  tier: {
    key?: TierKey | null;
    label: string | null;
    color?: string | null;
    visits: number;
    /** 0..1 toward the next tier; 1 at the top. */
    fraction?: number;
    perk: string | null;
    next: {
      label: string;
      visitsAway: number;
      perk: string | null;
      match?: "all" | "any";
      requirements?: TierRequirement[];
      /** "1 more visit in the last 30 days to reach Gold" */
      summary?: string | null;
    } | null;
    ladder?: TierRung[];
  };
  cards: RewardCard[];
  activity: { date: string; kind: "earned" | "redeemed" | "bonus" | "adjusted"; punches: number; label: string }[];
  otherProfileHasPunches: boolean;
}

export interface Profile {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  pushEnabled: boolean;
  isDemo: boolean;
}

export interface Notifications {
  push: { enabled: boolean };
  texts: { key: string; shopName: string; on: boolean; canTurnOn: boolean }[];
}
