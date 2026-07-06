import { prisma, runWithShop } from "@chairback/db";
import { recomputeCadence } from "../engines/cadence.js";
import {
  clawBackVisitEarn,
  currentBalance,
  earnPunchForVisitInTx,
  liveExtraPunches,
  routeVisitEarn,
} from "./punch.js";

/**
 * Barber edits to a client's past visits. A visit is the source of truth for two
 * derived systems: the punch ledger (a COMPLETED visit earns punches, idempotent
 * via PunchLedger.visitId) and cadence (lastVisitAt / median interval / at-risk,
 * computed from COMPLETED Visit rows). So editing or deleting a completed visit
 * must (1) reconcile the ledger via the SHARED claw-back/re-earn used by ingest,
 * and (2) recompute cadence afterwards.
 *
 * Every mutation runs in one runWithShop transaction with the same client row
 * lock (SELECT ... FOR UPDATE) as the punch service, so a concurrent earn/redeem
 * can't race the balance, and honors the same guardrail: a change that would drive
 * the balance negative (the punch was already spent on a reward) is refused.
 */

/** The shop slice the earn path needs (base rate). */
interface EarnShopSlice {
  id: string;
  punchesPerVisit: number;
}

async function balanceOf(
  tx: Parameters<Parameters<typeof runWithShop>[1]>[0],
  shopId: string,
  clientId: string,
  cardTypeId: string | null,
): Promise<number> {
  const agg = await tx.punchLedger.aggregate({
    where: { shopId, clientId, cardTypeId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}

export type DeleteVisitResult =
  | { ok: true; balance: number; wasCompleted: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "would_go_negative"; balance: number };

/**
 * Delete a past visit. If it was COMPLETED, its punch (and any barber corrections
 * to it) are clawed back FIRST via the shared helper, then the visit row is
 * deleted. We must claw back manually before delete rather than rely on the
 * Visit->PunchLedger cascade, because the cascade would (a) skip the
 * correction/regrant cleanup and (b) bypass the negative-balance guard.
 */
export async function deleteVisit(
  shopId: string,
  clientId: string,
  visitId: string,
): Promise<DeleteVisitResult> {
  const result = await runWithShop(shopId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    const visit = await tx.visit.findFirst({
      where: { id: visitId, shopId, clientId },
    });
    if (!visit) return { ok: false as const, reason: "not_found" as const };

    const wasCompleted = visit.status === "COMPLETED";
    let cardTypeId: string | null = null;
    if (wasCompleted) {
      // The live (non-reversed) earn for this visit, if any.
      const earn = await tx.punchLedger.findUnique({
        where: { visitId },
        select: { punchesEarned: true, reversedAt: true, cardTypeId: true },
      });
      const liveEarned = earn && earn.reversedAt === null ? earn.punchesEarned : 0;
      cardTypeId = earn?.cardTypeId ?? null;
      // Guard the earn's OWN card - the claw-back only touches that balance.
      const balance = await balanceOf(tx, shopId, clientId, cardTypeId);
      if (balance - liveEarned < 0) {
        return { ok: false as const, reason: "would_go_negative" as const, balance };
      }
      await clawBackVisitEarn(tx, shopId, visitId);
    }
    // Now safe: claw-back already removed the earn, so the cascade finds nothing.
    await tx.visit.delete({ where: { id: visit.id } });
    return { ok: true as const, wasCompleted, cardTypeId };
  });

  if (!result.ok) return result;
  // The completed-visit set changed: cadence must be recomputed (outside the tx).
  if (result.wasCompleted) await recomputeCadence(shopId, clientId);
  const balance = await currentBalance(shopId, clientId, result.cardTypeId);
  return { ok: true, balance, wasCompleted: result.wasCompleted };
}

export interface EditVisitInput {
  /** New visit date/time. Undefined = leave unchanged. */
  when?: Date;
  /**
   * New service name. Undefined = leave unchanged; null/"" = clear it (falls back
   * to the shop's base earn rate).
   */
  serviceName?: string | null;
  /**
   * Move the earn to a specific card. Undefined = keep the earn's current card
   * on date-only edits / re-route by service when the service changed; null =
   * force the default card. Callers must validate the id belongs to the shop.
   */
  cardTypeId?: string | null;
}

export type EditVisitResult =
  | { ok: true; balance: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "would_go_negative"; balance: number };

/**
 * Edit a past visit's date and/or service. For a COMPLETED visit, the new service
 * (and even the new date, since EXTRA_PUNCHES promos are time-bounded) can change
 * how many punches the visit should earn. When the amount changes we reconcile by
 * reverse-and-re-earn (claw back the old earn footprint, update the visit, then
 * re-earn at the new amount via the SAME path ingest uses), keeping "one
 * idempotent earn per visit" intact. Unchanged amount = update fields only, no
 * ledger churn. Refuses if the corrected balance would go negative.
 */
export async function editVisit(
  shop: EarnShopSlice,
  clientId: string,
  visitId: string,
  input: EditVisitInput,
): Promise<EditVisitResult> {
  const result = await runWithShop(shop.id, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    const visit = await tx.visit.findFirst({
      where: { id: visitId, shopId: shop.id, clientId },
    });
    if (!visit) return { ok: false as const, reason: "not_found" as const };

    const newService =
      input.serviceName === undefined ? visit.serviceName : input.serviceName || null;
    const newWhen = input.when ?? visit.completedAt ?? visit.scheduledAt;

    const fieldUpdate = {
      scheduledAt: input.when ?? undefined,
      serviceName: input.serviceName === undefined ? undefined : newService,
      // Keep the completed timestamp aligned with the (re)scheduled time for a
      // completed visit, so cadence reads the edited date.
      completedAt:
        visit.status === "COMPLETED" && input.when ? input.when : undefined,
      endAt: input.when ?? undefined,
    };

    if (visit.status !== "COMPLETED") {
      // No punch impact; just update the fields.
      await tx.visit.update({ where: { id: visit.id }, data: fieldUpdate });
      const balance = await balanceOf(tx, shop.id, clientId, null);
      return { ok: true as const, balance, dateChanged: Boolean(input.when) };
    }

    // Completed: does the earn amount - or the card it sits on - change under
    // the new service/date?
    const earn = await tx.punchLedger.findUnique({
      where: { visitId },
      select: { punchesEarned: true, reversedAt: true, cardTypeId: true },
    });
    const currentLiveAmount = earn && earn.reversedAt === null ? earn.punchesEarned : 0;
    const earnCardTypeId = earn?.cardTypeId ?? null;
    const serviceChanged =
      input.serviceName !== undefined && newService !== visit.serviceName;
    // Which card should the edited visit earn on? An explicit input wins; a
    // service change re-routes (the service is the routing signal); a date-only
    // edit keeps the earn's current card (it may have been a barber override).
    const override =
      input.cardTypeId !== undefined
        ? { cardTypeId: input.cardTypeId }
        : serviceChanged || !earn
          ? undefined
          : { cardTypeId: earnCardTypeId };
    const route = await routeVisitEarn(tx, shop, clientId, newService, override);
    const extra = await liveExtraPunches(tx, shop.id, newWhen);
    const newAmount = route.baseAmount + extra;

    if (newAmount === currentLiveAmount && route.cardTypeId === earnCardTypeId) {
      // Amount and card unchanged - just update fields, leave the ledger alone.
      await tx.visit.update({ where: { id: visit.id }, data: fieldUpdate });
      const balance = await balanceOf(tx, shop.id, clientId, earnCardTypeId);
      return { ok: true as const, balance, dateChanged: Boolean(input.when) };
    }

    // Amount or card changes: guard the OLD card (the claw-back drains it; a
    // different destination card only gains), then reverse-and-re-earn.
    const balance = await balanceOf(tx, shop.id, clientId, earnCardTypeId);
    const oldCardAfter =
      route.cardTypeId === earnCardTypeId
        ? balance - currentLiveAmount + newAmount
        : balance - currentLiveAmount;
    if (oldCardAfter < 0) {
      return { ok: false as const, reason: "would_go_negative" as const, balance };
    }
    // Claw back the old earn footprint (frees the visitId @unique slot), update
    // the visit, then re-earn at the new amount via ingest's exact path.
    await clawBackVisitEarn(tx, shop.id, visitId);
    await tx.visit.update({ where: { id: visit.id }, data: fieldUpdate });
    await earnPunchForVisitInTx(tx, shop, clientId, visit.id, newService, newWhen, override);
    const finalBalance = await balanceOf(tx, shop.id, clientId, route.cardTypeId);
    return { ok: true as const, balance: finalBalance, dateChanged: Boolean(input.when) };
  });

  if (!result.ok) return result;
  // A completed visit's date moving changes cadence; recompute to be safe.
  if (result.dateChanged) await recomputeCadence(shop.id, clientId);
  return { ok: true, balance: result.balance };
}

export { prisma };
