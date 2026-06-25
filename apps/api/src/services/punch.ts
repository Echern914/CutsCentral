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
export async function liveExtraPunches(
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
 * Result of an earn: how many punches this visit added and the client's balance
 * AFTER it. `null` means nothing was written because the visit had already
 * earned (the idempotent no-op) - callers use this to fire a "you earned a
 * punch" text exactly once per visit, never on a re-delivered webhook or a
 * promotion-job re-run.
 */
export type EarnResult = { earned: number; balance: number } | null;

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
): Promise<EarnResult> {
  const existing = await tx.punchLedger.findUnique({ where: { visitId } });
  if (existing) return null; // already earned

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
  return { earned, balance: balance + earned };
}

/**
 * Tear down a visit's ENTIRE punch-ledger footprint inside an already-open shop
 * transaction. Used whenever a completed visit stops counting: a retroactive
 * Acuity cancel/no-show (ingest) or a barber deleting/re-earning the visit from
 * the dashboard. ONE implementation so the two callers can never drift.
 *
 * A visit's earn can have grown extra rows if the barber corrected it first:
 *   - "undo a punch" (reverseLedgerEntry): a correction row, reversalOfId = earn.id.
 *   - "edit count" (adjustLedgerEntry): a correction row (reversalOfId = earn.id)
 *     PLUS a fresh re-granted earn (correctionOfId = that correction's id).
 * Deleting only the earn would orphan the correction (a standalone -N) and/or the
 * regrant (a standalone +M), throwing the aggregate balance off. So we delete the
 * whole chain deepest-link-first: regrant -> correction -> earn.
 *
 * Balance is always derived from the aggregate (sum earned - sum redeemed), so
 * removing these rows keeps it exactly consistent. The caller is responsible for
 * recomputeCadence afterwards (it reads Visit, not the ledger).
 */
export async function clawBackVisitEarn(
  tx: Prisma.TransactionClient,
  shopId: string,
  visitId: string,
): Promise<void> {
  const earn = await tx.punchLedger.findUnique({
    where: { visitId },
    select: { id: true },
  });
  if (earn) {
    const corrections = await tx.punchLedger.findMany({
      where: { reversalOfId: earn.id },
      select: { id: true },
    });
    const correctionIds = corrections.map((c) => c.id);
    if (correctionIds.length > 0) {
      // Re-granted earns from an "edit count" point at these corrections.
      await tx.punchLedger.deleteMany({
        where: { correctionOfId: { in: correctionIds } },
      });
      await tx.punchLedger.deleteMany({ where: { id: { in: correctionIds } } });
    }
  }
  await tx.punchLedger.deleteMany({ where: { visitId } });
}

/** Earn for a visit (status-promotion path). Opens its own locked transaction. */
export async function earnPunchForVisit(
  shop: EarnShop,
  clientId: string,
  visitId: string,
  serviceName: string | null,
  visitedAt: Date = new Date(),
): Promise<EarnResult> {
  return runWithShop(shop.id, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    return earnPunchForVisitInTx(tx, shop, clientId, visitId, serviceName, visitedAt);
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

/**
 * Current punch balance = sum(earned) - sum(redeemed) for a client. Accepts an
 * optional transaction client so a caller that has bypassed RLS (the public
 * rewards endpoint via runAsOwner) can run this aggregate in that same context;
 * defaults to the module prisma for normal callers.
 */
export async function currentBalance(
  shopId: string,
  clientId: string,
  db: Pick<typeof prisma, "punchLedger"> | Prisma.TransactionClient = prisma,
): Promise<number> {
  const agg = await db.punchLedger.aggregate({
    where: { shopId, clientId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}

export type ReverseResult =
  | { ok: true; newBalance: number; correction: { id: string; punchesEarned: number; punchesRedeemed: number } }
  | { ok: false; reason: "entry_not_found" }
  | { ok: false; reason: "already_reversed" }
  | { ok: false; reason: "is_a_correction" };

/**
 * Undo a single ledger entry the barber shouldn't have given (a mis-clicked
 * +1, a visit that didn't happen, a redemption keyed to the wrong client).
 *
 * The ledger is append-only by design - balances are snapshots, and other rows
 * (and the running totals already shown to the client) depend on it - so we
 * never delete. Instead we write ONE offsetting correction row with earned and
 * redeemed swapped, then stamp `reversedAt` on the original. Net effect on the
 * balance is exactly the original entry zeroed out, and both rows remain in the
 * history with a clear link between them.
 *
 * Guards (all inside the lock, so two tabs can't double-undo):
 *  - the entry must belong to this shop+client (foreign ids -> entry_not_found)
 *  - an already-reversed original can't be reversed again (idempotent-ish)
 *  - a correction row itself can't be reversed (no undo-the-undo; the barber
 *    re-grants instead, which reads more honestly in the history)
 */
export async function reverseLedgerEntry(
  shopId: string,
  clientId: string,
  entryId: string,
): Promise<ReverseResult> {
  return runWithShop(shopId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    // Scope by shopId+clientId (not findUnique by id) so a foreign/other-client
    // entry id 404s instead of touching someone else's ledger.
    const entry = await tx.punchLedger.findFirst({
      where: { id: entryId, shopId, clientId },
    });
    if (!entry) return { ok: false, reason: "entry_not_found" as const };
    if (entry.reversalOfId !== null) return { ok: false, reason: "is_a_correction" as const };
    if (entry.reversedAt !== null) return { ok: false, reason: "already_reversed" as const };

    const agg = await tx.punchLedger.aggregate({
      where: { shopId, clientId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const balance =
      (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
    // Swap earned<->redeemed so the correction's net is the original's negation.
    const correctionEarned = entry.punchesRedeemed;
    const correctionRedeemed = entry.punchesEarned;
    const newBalance = balance - entry.punchesEarned + entry.punchesRedeemed;

    const correction = await tx.punchLedger.create({
      data: {
        shopId,
        clientId,
        visitId: null, // not an earn-for-visit; leaves the visit's own earn unique intact
        rewardId: entry.rewardId, // keep the link for redemption reversals (reporting)
        punchesEarned: correctionEarned,
        punchesRedeemed: correctionRedeemed,
        runningBalance: newBalance,
        note: `undo: ${entry.note ?? "entry"}`,
        reversalOfId: entry.id,
      },
    });
    await tx.punchLedger.update({
      where: { id: entry.id },
      data: { reversedAt: new Date() },
    });

    return {
      ok: true as const,
      newBalance,
      correction: {
        id: correction.id,
        punchesEarned: correction.punchesEarned,
        punchesRedeemed: correction.punchesRedeemed,
      },
    };
  });
}

export type AdjustResult =
  | { ok: true; newBalance: number }
  | { ok: false; reason: "entry_not_found" }
  | { ok: false; reason: "already_reversed" }
  | { ok: false; reason: "is_a_correction" }
  | { ok: false; reason: "not_an_earn" }
  | { ok: false; reason: "would_go_negative"; balance: number };

/**
 * Edit how many punches an EARN entry granted (e.g. a visit logged as 1 punch
 * that should have been 2). Modeled as reverse-then-regrant in ONE transaction:
 * the original earn is reversed (offsetting correction + reversedAt) and a fresh
 * earn for `newPunches` is written. History reads "original / undo / corrected",
 * which is the honest trail.
 *
 * Only earns are adjustable - redemptions are tied to a specific reward's cost,
 * so "change the amount" is meaningless there (undo + redeem the right reward
 * instead). Refuses if the corrected balance would go negative (the extra
 * punches were already spent on a reward).
 */
export async function adjustLedgerEntry(
  shopId: string,
  clientId: string,
  entryId: string,
  newPunches: number,
): Promise<AdjustResult> {
  return runWithShop(shopId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    const entry = await tx.punchLedger.findFirst({
      where: { id: entryId, shopId, clientId },
    });
    if (!entry) return { ok: false, reason: "entry_not_found" as const };
    if (entry.reversalOfId !== null) return { ok: false, reason: "is_a_correction" as const };
    if (entry.reversedAt !== null) return { ok: false, reason: "already_reversed" as const };
    // An earn is a row that granted punches and redeemed none. Redemptions
    // (punchesRedeemed > 0) aren't editable this way.
    if (entry.punchesEarned <= 0 || entry.punchesRedeemed !== 0) {
      return { ok: false, reason: "not_an_earn" as const };
    }

    const agg = await tx.punchLedger.aggregate({
      where: { shopId, clientId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const balance =
      (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
    // Net change of replacing `entry.punchesEarned` with `newPunches`.
    const finalBalance = balance - entry.punchesEarned + newPunches;
    if (finalBalance < 0) {
      return { ok: false, reason: "would_go_negative" as const, balance };
    }

    // Step 1: reverse the original (offsetting correction at the pre-regrant
    // balance), then mark it reversed.
    const afterReversal = balance - entry.punchesEarned;
    const correction = await tx.punchLedger.create({
      data: {
        shopId,
        clientId,
        visitId: null,
        rewardId: entry.rewardId,
        punchesEarned: 0,
        punchesRedeemed: entry.punchesEarned,
        runningBalance: afterReversal,
        note: `edit: ${entry.note ?? "entry"}`,
        reversalOfId: entry.id,
      },
    });
    await tx.punchLedger.update({
      where: { id: entry.id },
      data: { reversedAt: new Date() },
    });
    // Step 2: re-grant the corrected amount as a fresh earn. Link it back to the
    // correction (correctionOfId) so that if the underlying visit is later
    // canceled, ingest's claw-back can remove this regrant too instead of
    // orphaning it (which would overstate the balance).
    await tx.punchLedger.create({
      data: {
        shopId,
        clientId,
        visitId: null,
        punchesEarned: newPunches,
        punchesRedeemed: 0,
        runningBalance: finalBalance,
        note: `corrected: ${entry.note ?? "entry"}`,
        correctionOfId: correction.id,
      },
    });

    return { ok: true as const, newBalance: finalBalance };
  });
}
