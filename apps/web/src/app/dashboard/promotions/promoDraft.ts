import { LOYALTY_TIER_KEYS, type LoyaltyTierKey } from "@chairback/config/constants";
import type { Promo } from "./page";

/** What a promo is worth, in the words the promotions list shows. */
export function valueLabel(p: Pick<Promo, "kind" | "percentOff" | "amountOff" | "extraPunches">): string {
  switch (p.kind) {
    case "PERCENT_OFF":
      return `${p.percentOff}% off`;
    case "AMOUNT_OFF":
      return `$${p.amountOff} off`;
    case "FREE_ADDON":
      return "Free add-on";
    case "EXTRA_PUNCHES":
      return `+${p.extraPunches} ${p.extraPunches === 1 ? "punch" : "punches"} per visit`;
  }
}

/**
 * The composer opens on App notification, so the draft fits a notification.
 * Mirrors SUBJECT_LIMITS.push / BODY_LIMITS.push in the API's broadcasts route
 * (and FALLBACK_LIMITS in BroadcastCard) - the API stays the authority.
 */
const PUSH_SUBJECT_MAX = 60;
const PUSH_BODY_MAX = 300;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function sentence(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * A promo written out as a message for the Clients-page composer, so "send
 * this promo to only my Gold members" by app notification or email does not
 * start from a blank box. The barber sees and can edit every word before it
 * goes anywhere; nothing here sends.
 */
export function promoBroadcastDraft(p: Promo): { subject: string; body: string } {
  const parts = [sentence(valueLabel(p))];
  if (p.description?.trim()) parts.push(sentence(p.description.trim()));
  if (p.code?.trim()) parts.push(`Show code ${p.code.trim()}.`);
  return { subject: clip(p.title.trim(), PUSH_SUBJECT_MAX), body: clip(parts.join(" "), PUSH_BODY_MAX) };
}

/**
 * Where "Email or notify" on a promo goes: the Clients-page composer, told
 * which promo to write out and (optionally) which tiers to aim at. Only ids
 * travel in the link - the words are rebuilt from the shop's own promo on the
 * other side, so a link cannot put text in the barber's mouth.
 */
export function promoBroadcastHref(promoId: string, tiers: readonly LoyaltyTierKey[] = []): string {
  const qs = new URLSearchParams({ promo: promoId });
  if (tiers.length > 0) qs.set("tiers", tiers.join(","));
  return `/dashboard/clients?${qs.toString()}`;
}

/** The `tiers` half of that link, read back. Anything that is not a tier is dropped. */
export function draftTiersFromParam(raw: string | undefined): LoyaltyTierKey[] {
  if (!raw) return [];
  const known = LOYALTY_TIER_KEYS as readonly string[];
  return [...new Set(raw.split(","))].filter((t): t is LoyaltyTierKey => known.includes(t));
}
