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

export interface RewardProgram {
  shop: ShopRef;
  tier: {
    label: string | null;
    visits: number;
    perk: string | null;
    next: { label: string; visitsAway: number; perk: string | null } | null;
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
