import { forShop, prisma } from "@chairback/db";

/**
 * Punch ledger writes. Earning is idempotent via PunchLedger.visitId @unique:
 * a visit can never earn twice even if ingest/promotion fire repeatedly.
 *
 * runningBalance is a snapshot after each entry (earned - redeemed cumulative).
 */
export async function earnPunchForVisit(
  shopId: string,
  clientId: string,
  visitId: string,
): Promise<void> {
  const existing = await prisma.punchLedger.findUnique({ where: { visitId } });
  if (existing) return; // already earned

  const balance = await currentBalance(shopId, clientId);
  await forShop(shopId).punch.create({
    data: {
      clientId,
      visitId,
      punchesEarned: 1,
      punchesRedeemed: 0,
      runningBalance: balance + 1,
      note: "visit",
    },
  });
}

/** Manual redemption from the dashboard. Reduces balance by `count` punches. */
export async function redeemPunches(
  shopId: string,
  clientId: string,
  count: number,
): Promise<void> {
  const balance = await currentBalance(shopId, clientId);
  await forShop(shopId).punch.create({
    data: {
      clientId,
      visitId: null,
      punchesEarned: 0,
      punchesRedeemed: count,
      runningBalance: balance - count,
      note: "redeem",
    },
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
