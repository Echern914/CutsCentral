import type { Prisma } from "@chairback/db";
import {
  LOYALTY_TIERS,
  loyaltyTierProgress,
  parseTierPerks,
  parseTierThresholds,
  tierPerk,
} from "@chairback/config";

/**
 * WHAT A CUSTOMER'S PUNCH CARDS SAY - computed in ONE place.
 *
 * The storefront's rewards page (GET /api/rewards/:token) and the My ChairBack
 * app (GET /api/me/rewards) both show a customer their balances, the next
 * reward, what is ready, and their tier. This module is the arithmetic for all
 * of it, extracted verbatim from routes/rewards.ts so the two surfaces cannot
 * disagree about a punch. Scope is always ONE client row at ONE shop: nothing
 * here ever adds balances across shops or across rows.
 */

export interface LoyaltyReward {
  id: string;
  name: string;
  description: string | null;
  emoji: string | null;
  punchCost: number;
  cardTypeId: string | null;
}

export interface LoyaltyCardType {
  id: string;
  name: string;
  emoji: string | null;
  accentColor: string | null;
  exclusive: boolean;
  active: boolean;
}

export interface LoyaltyInputs {
  /** Lifetime COMPLETED visits at this shop - drives the tier. */
  completedCount: number;
  rewards: LoyaltyReward[];
  cardTypes: LoyaltyCardType[];
  grants: { cardTypeId: string }[];
  ledgerGroups: {
    cardTypeId: string | null;
    _sum: { punchesEarned: number | null; punchesRedeemed: number | null };
  }[];
}

/** The reads buildLoyaltyView needs, for one client at one shop. */
export async function loadLoyaltyInputs(
  tx: Prisma.TransactionClient,
  shopId: string,
  clientId: string,
): Promise<LoyaltyInputs> {
  const [rewards, completedCount, cardTypes, grants, ledgerGroups] = await Promise.all([
    tx.reward.findMany({
      where: { shopId, active: true },
      orderBy: [{ sortOrder: "asc" }, { punchCost: "asc" }],
      select: { id: true, name: true, description: true, emoji: true, punchCost: true, cardTypeId: true },
    }),
    tx.visit.count({ where: { shopId, clientId, status: "COMPLETED" } }),
    tx.cardType.findMany({
      where: { shopId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, emoji: true, accentColor: true, exclusive: true, active: true },
    }),
    tx.cardGrant.findMany({ where: { shopId, clientId }, select: { cardTypeId: true } }),
    tx.punchLedger.groupBy({
      by: ["cardTypeId"],
      where: { shopId, clientId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    }),
  ]);
  return { rewards, completedCount, cardTypes, grants, ledgerGroups };
}

export interface LoyaltyCardView {
  id: string | null;
  name: string;
  emoji: string | null;
  accentColor: string | null;
  exclusive: boolean;
  balance: number;
  nextTarget: { name: string; punchCost: number; remaining: number } | null;
  rewards: {
    id: string;
    name: string;
    description: string | null;
    emoji: string | null;
    punchCost: number;
    ready: boolean;
    remaining: number;
  }[];
}

export interface LoyaltyView {
  loyalty: {
    tier: ReturnType<typeof loyaltyTierProgress>["current"];
    label: string | null;
    color: string | null;
    visits: number;
    fraction: number;
    perk: string | null;
    nextTier: { label: string; visitsAway: number; perk: string | null } | null;
  };
  /** The DEFAULT card's balance (cardTypeId null). */
  balance: number;
  /** The default card's next reward out of reach, or null. */
  nextTarget: LoyaltyReward | null;
  /** Rewards on a given card (null = the default card). */
  rewardsFor: (cardTypeId: string | null) => LoyaltyReward[];
  /** One entry per card the client should see, default card first. */
  cards: LoyaltyCardView[];
}

export function buildLoyaltyView(
  shop: { tierThresholds: Prisma.JsonValue | null; tierPerks: Prisma.JsonValue | null },
  inputs: LoyaltyInputs,
): LoyaltyView {
  const { rewards, completedCount, cardTypes, grants, ledgerGroups } = inputs;

  // Per-card balances; the null key is the default card. The top-level
  // punches/rewards fields are the DEFAULT card's view - byte-identical to the
  // pre-cards payload for every shop with no CardTypes (all rows null).
  const balanceByCard = new Map(
    ledgerGroups.map((g) => [
      g.cardTypeId,
      (g._sum.punchesEarned ?? 0) - (g._sum.punchesRedeemed ?? 0),
    ]),
  );
  const balance = balanceByCard.get(null) ?? 0;
  const grantedIds = new Set(grants.map((g) => g.cardTypeId));
  const rewardsFor = (cardTypeId: string | null) =>
    rewards.filter((r) => r.cardTypeId === cardTypeId);

  // Loyalty status tier (Bronze/Silver/Gold by lifetime completed visits), how
  // far to the next one, and what each is worth at this shop.
  //
  // 🔴 The tier arithmetic is loyaltyTierProgress() in @chairback/config, not
  // repeated here - it has to agree with the badge, the bar, and whatever reads
  // it next.
  const progress = loyaltyTierProgress(
    completedCount,
    parseTierThresholds(shop.tierThresholds),
  );
  const perks = parseTierPerks(shop.tierPerks);
  const loyalty = {
    tier: progress.current,
    label: progress.current ? LOYALTY_TIERS[progress.current].label : null,
    color: progress.current ? LOYALTY_TIERS[progress.current].color : null,
    visits: completedCount,
    // 0..1 through the CURRENT band, for the progress bar. Measured band to
    // band rather than from zero, so a client one visit from Gold sees a
    // nearly-full bar instead of a creeping one.
    fraction: progress.fraction,
    // What they get for being where they are. Null when the shop has not said.
    perk: tierPerk(perks, progress.current),
    nextTier: progress.next
      ? {
          label: LOYALTY_TIERS[progress.next].label,
          visitsAway: progress.visitsToNext,
          // What is waiting one tier up - the actual reason to come back.
          perk: tierPerk(perks, progress.next),
        }
      : null,
  };

  // The punch grid counts toward the cheapest reward the client can't afford
  // yet; with everything in reach (or an empty menu) there's no next target.
  // Scoped per card: a card's grid only targets that card's own rewards.
  const nextTargetFor = (cardTypeId: string | null, cardBalance: number) =>
    [...rewardsFor(cardTypeId)]
      .sort((a, b) => a.punchCost - b.punchCost)
      .find((r) => r.punchCost > cardBalance) ?? null;
  const nextTarget = nextTargetFor(null, balance);

  // One stacked-card view per card the client should see: the default card
  // always, a custom card when it's live for everyone (active + not exclusive),
  // granted to this client, or holds any of their history (honesty: an archived
  // or revoked card with punches on it never silently disappears).
  const cardView = (card: {
    id: string | null;
    name: string;
    emoji: string | null;
    accentColor: string | null;
    exclusive: boolean;
  }): LoyaltyCardView => {
    const cardBalance = balanceByCard.get(card.id) ?? 0;
    const target = nextTargetFor(card.id, cardBalance);
    return {
      id: card.id,
      name: card.name,
      emoji: card.emoji,
      accentColor: card.accentColor,
      exclusive: card.exclusive,
      balance: cardBalance,
      nextTarget: target
        ? {
            name: target.name,
            punchCost: target.punchCost,
            remaining: target.punchCost - cardBalance,
          }
        : null,
      rewards: rewardsFor(card.id).map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        emoji: r.emoji,
        punchCost: r.punchCost,
        ready: cardBalance >= r.punchCost,
        remaining: Math.max(0, r.punchCost - cardBalance),
      })),
    };
  };
  const cards = [
    cardView({ id: null, name: "Punch Card", emoji: null, accentColor: null, exclusive: false }),
    ...cardTypes
      .filter(
        (c) =>
          (c.active && !c.exclusive) || grantedIds.has(c.id) || balanceByCard.has(c.id),
      )
      .map((c) => cardView(c)),
  ];

  return { loyalty, balance, nextTarget, rewardsFor, cards };
}
