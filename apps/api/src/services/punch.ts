import { prisma, runWithShop } from "@chairback/db";

/**
 * Punch ledger writes. Earning is idempotent via PunchLedger.visitId @unique:
 * a visit can never earn twice even if ingest/promotion fire repeatedly.
 *
 * runningBalance is a snapshot after each entry (earned - redeemed cumulative).
 *
 * Both mutations run inside ONE runWithShop transaction with a row lock on the
 * client (SELECT ... FOR UPDATE), so concurrent earns/redeems for the same
 * client serialize: a double-clicked "Redeem" can't pass the balance check
 * twice and drive the ledger negative.
 */
export async function earnPunchForVisit(
  shopId: string,
  clientId: string,
  visitId: string,
): Promise<void> {
  await runWithShop(shopId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    const existing = await tx.punchLedger.findUnique({ where: { visitId } });
    if (existing) return; // already earned

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
        visitId,
        punchesEarned: 1,
        punchesRedeemed: 0,
        runningBalance: balance + 1,
        note: "visit",
      },
    });
  });
}

export type RedeemResult =
  | { ok: true; newBalance: number }
  | { ok: false; balance: number };

/** Manual redemption from the dashboard. Atomic: re-checks the balance inside
 * the same locked transaction that writes the redemption row. */
export async function redeemPunches(
  shopId: string,
  clientId: string,
  count: number,
): Promise<RedeemResult> {
  return runWithShop(shopId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    const agg = await tx.punchLedger.aggregate({
      where: { shopId, clientId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const balance =
      (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
    if (balance < count) return { ok: false, balance };

    await tx.punchLedger.create({
      data: {
        shopId,
        clientId,
        visitId: null,
        punchesEarned: 0,
        punchesRedeemed: count,
        runningBalance: balance - count,
        note: "redeem",
      },
    });
    return { ok: true, newBalance: balance - count };
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
