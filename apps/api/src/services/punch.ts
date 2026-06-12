import { prisma, runWithShop, type Prisma } from "@chairback/db";

/**
 * Punch ledger writes. Earning is idempotent via PunchLedger.visitId @unique:
 * a visit can never earn twice even if ingest/promotion fire repeatedly.
 *
 * HOW MUCH a visit earns is shop-designed: the shop's base punchesPerVisit,
 * unless an active EarnRule matches the visit's service name (first match by
 * sortOrder wins) - e.g. "Cut + Beard" earns 2. Redemption is against a
 * specific Reward on the shop's menu, deducting that reward's punchCost.
 *
 * runningBalance is a snapshot after each entry (earned - redeemed cumulative).
 *
 * Mutations run inside ONE runWithShop transaction with a row lock on the
 * client (SELECT ... FOR UPDATE), so concurrent earns/redeems for the same
 * client serialize: a double-clicked "Redeem" can't pass the balance check
 * twice and drive the ledger negative.
 */

/** The slice of Shop the earn path needs (callers already hold the row). */
export interface EarnShop {
  id: string;
  punchesPerVisit: number;
}

/**
 * Punches from the first matching active service rule, or null when none
 * matches (the caller falls back to the shop's base rate). Clamped to >=1 so a
 * misconfigured rule can never make a real visit earn nothing.
 */
export async function visitEarnAmount(
  tx: Prisma.TransactionClient,
  shopId: string,
  serviceName: string | null,
): Promise<number | null> {
  if (!serviceName) return null;
  const rules = await tx.earnRule.findMany({
    where: { shopId, active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const service = serviceName.toLowerCase();
  const match = rules.find(
    (r) => r.serviceMatch.trim() !== "" && service.includes(r.serviceMatch.trim().toLowerCase()),
  );
  return match ? Math.max(1, match.punches) : null;
}

/**
 * Extra punches per visit from LIVE "extra punches" promotions (double-punch
 * weeks etc.). Stacks on top of the rule/base amount.
 */
async function liveExtraPunches(
  tx: Prisma.TransactionClient,
  shopId: string,
  now: Date,
): Promise<number> {
  const promos = await tx.promotion.findMany({
    where: {
      shopId,
      kind: "EXTRA_PUNCHES",
      active: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    select: { extraPunches: true },
  });
  return promos.reduce((sum, p) => sum + Math.max(0, p.extraPunches ?? 0), 0);
}

/**
 * Earn inside an ALREADY-OPEN shop transaction (ingest path - its tx already
 * wrote the client + visit). Idempotent via the visitId unique. `visitedAt` is
 * when the visit actually happened - promo windows are checked against IT, so
 * a backfill of last year's visits can't collect this week's double-punch.
 */
export async function earnPunchForVisitInTx(
  tx: Prisma.TransactionClient,
  shop: EarnShop,
  clientId: string,
  visitId: string,
  serviceName: string | null,
  visitedAt: Date,
): Promise<void> {
  const existing = await tx.punchLedger.findUnique({ where: { visitId } });
  if (existing) return; // already earned

  const ruleAmount = await visitEarnAmount(tx, shop.id, serviceName);
  const extra = await liveExtraPunches(tx, shop.id, visitedAt);
  const earned = (ruleAmount ?? Math.max(1, shop.punchesPerVisit)) + extra;

  const agg = await tx.punchLedger.aggregate({
    where: { shopId: shop.id, clientId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  const balance =
    (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
  await tx.punchLedger.create({
    data: {
      shopId: shop.id,
      clientId,
      visitId,
      punchesEarned: earned,
      punchesRedeemed: 0,
      runningBalance: balance + earned,
      note: "visit",
    },
  });
}

/** Earn for a visit (status-promotion path). Opens its own locked transaction. */
export async function earnPunchForVisit(
  shop: EarnShop,
  clientId: string,
  visitId: string,
  serviceName: string | null,
  visitedAt: Date = new Date(),
): Promise<void> {
  await runWithShop(shop.id, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    await earnPunchForVisitInTx(tx, shop, clientId, visitId, serviceName, visitedAt);
  });
}

export type RedeemResult =
  | { ok: true; newBalance: number; reward: { id: string; name: string; punchCost: number } }
  | { ok: false; reason: "reward_not_found" }
  | { ok: false; reason: "insufficient_punches"; balance: number; required: number };

/**
 * Redeem a specific menu reward from the dashboard. Atomic: the reward lookup
 * and balance check happen inside the same locked transaction that writes the
 * redemption row. Inactive rewards are still redeemable - the barber may honor
 * one they just retired - but unknown/foreign ids are not.
 */
export async function redeemReward(
  shopId: string,
  clientId: string,
  rewardId: string,
): Promise<RedeemResult> {
  return runWithShop(shopId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    // findFirst with shopId (not findUnique by id) so a foreign reward id 404s.
    const reward = await tx.reward.findFirst({ where: { id: rewardId, shopId } });
    if (!reward) return { ok: false, reason: "reward_not_found" as const };

    const agg = await tx.punchLedger.aggregate({
      where: { shopId, clientId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const balance =
      (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
    if (balance < reward.punchCost) {
      return {
        ok: false,
        reason: "insufficient_punches" as const,
        balance,
        required: reward.punchCost,
      };
    }

    await tx.punchLedger.create({
      data: {
        shopId,
        clientId,
        visitId: null,
        rewardId: reward.id,
        punchesEarned: 0,
        punchesRedeemed: reward.punchCost,
        runningBalance: balance - reward.punchCost,
        // The reward's name, so the ledger reads naturally even if the reward
        // row is later deleted (rewardId then goes null via SetNull).
        note: reward.name,
      },
    });
    return {
      ok: true,
      newBalance: balance - reward.punchCost,
      reward: { id: reward.id, name: reward.name, punchCost: reward.punchCost },
    };
  });
}

/** Bonus punches (referrals etc). Same locked-transaction pattern as redeem. */
export async function grantBonusPunches(
  shopId: string,
  clientId: string,
  count: number,
): Promise<{ newBalance: number }> {
  return runWithShop(shopId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    const agg = await tx.punchLedger.aggregate({
      where: { shopId, clientId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const balance =
      (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
    await tx.punchLedger.create({
      data: {
        shopId,
        clientId,
        visitId: null,
        punchesEarned: count,
        punchesRedeemed: 0,
        runningBalance: balance + count,
        note: "bonus",
      },
    });
    return { newBalance: balance + count };
  });
}

/** Current punch balance = sum(earned) - sum(redeemed) for a client. */
export async function currentBalance(
  shopId: string,
  clientId: string,
): Promise<number> {
  const agg = await prisma.punchLedger.aggregate({
    where: { shopId, clientId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}
