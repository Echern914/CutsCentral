import { prisma, runWithShop } from "@chairback/db";
import {
  zonedDateParts,
  zonedWallTimeToUtc,
  localMinutesOfDay,
} from "@chairback/config";
import { logger } from "../logger.js";

/**
 * Materialization for INDEFINITE targeted-slot series ("repeat until I turn it
 * off"). A rule stores only its anchor occurrence; concrete TargetedSlot rows
 * are what block the grid and get claimed by bookings, so somebody has to keep
 * creating them as time passes — that's this engine, called from the POST that
 * creates a rule (first horizon) and from the daily roll-forward job (every
 * horizon after).
 *
 * Occurrence k = anchor's shop-local wall time, k weeks later (DST-stable via
 * zonedWallTimeToUtc). weeksMaterialized is the ONLY cursor: we extend from it
 * and advance it in the same transaction as the createMany, so a crashed or
 * double-fired run can never double-create a week.
 */

/** How far ahead an indefinite series keeps concrete rows. Comfortably past
 *  the max booking window (Shop.bookingMaxDays caps at 90). */
export const TARGETED_RULE_HORIZON_DAYS = 91;

interface RuleRow {
  id: string;
  shopId: string;
  staffId: string;
  serviceId: string;
  label: string | null;
  anchor: Date;
  durationMin: number;
  price: unknown; // Prisma.Decimal — passed through to createMany untouched
  weeksMaterialized: number;
}

/**
 * Extend one rule's materialized rows up to `horizonEnd`. Returns how many new
 * rows were created. Idempotent: re-running with the same horizon creates 0.
 */
export async function materializeTargetedRule(
  rule: RuleRow,
  timezone: string,
  horizonEnd: Date,
): Promise<number> {
  const anchor = zonedDateParts(rule.anchor, timezone);
  const wallMin = localMinutesOfDay(rule.anchor, timezone);
  const rows: {
    staffId: string;
    serviceId: string;
    label: string | null;
    startsAt: Date;
    durationMin: number;
    price: unknown;
    ruleId: string;
  }[] = [];
  let k = rule.weeksMaterialized;
  for (;;) {
    const startsAt =
      k === 0
        ? rule.anchor
        : zonedWallTimeToUtc(
            anchor.year,
            anchor.month0,
            anchor.day + k * 7, // Date.UTC in the helper normalizes overflow
            wallMin,
            timezone,
          );
    if (startsAt.getTime() > horizonEnd.getTime()) break;
    rows.push({
      staffId: rule.staffId,
      serviceId: rule.serviceId,
      label: rule.label,
      startsAt,
      durationMin: rule.durationMin,
      price: rule.price,
      ruleId: rule.id,
    });
    k++;
  }
  if (rows.length === 0) return 0;
  // createMany + cursor advance in ONE tx (shop-scoped for RLS), guarded on the
  // cursor still being where we read it — if a concurrent run already extended,
  // the guard matches 0 rows and we skip instead of duplicating.
  return runWithShop(rule.shopId, async (tx) => {
    const advanced = await tx.targetedSlotRule.updateMany({
      where: { id: rule.id, weeksMaterialized: rule.weeksMaterialized },
      data: { weeksMaterialized: k },
    });
    if (advanced.count === 0) return 0;
    await tx.targetedSlot.createMany({
      data: rows.map((r) => ({ ...r, shopId: rule.shopId, price: r.price as never })),
    });
    return rows.length;
  });
}

/**
 * The scheduler entry: roll every active indefinite rule forward to the
 * horizon. Per-shop timezone; one failed rule logs and never blocks the rest.
 */
export async function rollForwardTargetedRules(): Promise<void> {
  const rules = await prisma.targetedSlotRule.findMany({
    where: { active: true, indefinite: true },
    select: {
      id: true,
      shopId: true,
      staffId: true,
      serviceId: true,
      label: true,
      anchor: true,
      durationMin: true,
      price: true,
      weeksMaterialized: true,
      shop: { select: { timezone: true } },
    },
  });
  const horizonEnd = new Date(
    Date.now() + TARGETED_RULE_HORIZON_DAYS * 24 * 60 * 60 * 1000,
  );
  for (const rule of rules) {
    try {
      const created = await materializeTargetedRule(
        rule,
        rule.shop.timezone,
        horizonEnd,
      );
      if (created > 0) {
        logger.info(
          { ruleId: rule.id, shopId: rule.shopId, created },
          "targeted slot series rolled forward",
        );
      }
    } catch (err) {
      logger.error(
        { err, ruleId: rule.id, shopId: rule.shopId },
        "targeted slot roll-forward failed",
      );
    }
  }
}
