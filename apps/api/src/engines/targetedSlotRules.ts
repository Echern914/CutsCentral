import { prisma, runWithShop } from "@chairback/db";
import {
  zonedDateParts,
  zonedWallTimeToUtc,
  localMinutesOfDay,
} from "@chairback/config";
import { logger } from "../logger.js";
import { slotServiceIds } from "./targetedSlotServices.js";

/**
 * Materialization for targeted-slot series ("repeat until I turn it off").
 * A rule stores its anchor + weekly SCHEDULE; concrete TargetedSlot rows are
 * what block the grid and get claimed by bookings, so somebody has to keep
 * creating them as time passes — that's this engine, called from the POST that
 * creates a rule (first horizon) and from the daily roll-forward job (every
 * horizon after).
 *
 * Week k spans the 7 days starting at the anchor's shop-local DATE, k weeks
 * later (DST-stable via zonedWallTimeToUtc). One week can hold many rows now —
 * any set of weekdays x any set of times — so weeksMaterialized counts WEEKS,
 * not rows. It is still the ONLY cursor: we extend from it and advance it in
 * the same transaction as the createMany, so a crashed or double-fired run can
 * never double-create a week. Weeks materialize whole or not at all, which
 * keeps that invariant with multi-row weeks (the horizon is 91 days against a
 * 90-day booking window, so a partially-fitting final week can just wait for
 * tomorrow's run).
 */

/** How far ahead an indefinite series keeps concrete rows. Comfortably past
 *  the max booking window (Shop.bookingMaxDays caps at 90). */
export const TARGETED_RULE_HORIZON_DAYS = 91;

/** One time-of-day in a rule's weekly schedule. durationMin/price fall back to
 *  the rule's base columns. */
export interface RuleTime {
  startMin: number;
  durationMin?: number;
  price?: number;
}
/** {"0".."6": RuleTime[]} — Service.hoursWindows key convention (0=Sun). */
export type RuleSchedule = Record<string, RuleTime[]>;

interface RuleRow {
  id: string;
  shopId: string;
  staffId: string;
  serviceId: string;
  /** The rule's service set. Copied onto every slot it materializes, so an
   *  edit to the set changes FUTURE weeks only - already-created rows keep
   *  the listing they were published with. */
  services?: { serviceId: string }[];
  label: string | null;
  anchor: Date;
  durationMin: number;
  price: unknown; // Prisma.Decimal — passed through to createMany untouched
  schedule: unknown; // Json column — parsed defensively below
  weeksMaterialized: number;
}

/**
 * The rule's weekly schedule, with the pre-schedule fallback: a legacy rule
 * (schedule {}) means exactly its anchor's weekday and wall time. Malformed
 * entries are dropped rather than crashing the roll-forward for every shop.
 */
export function effectiveSchedule(
  rule: { anchor: Date; schedule: unknown },
  timezone: string,
): RuleSchedule {
  const out: RuleSchedule = {};
  const raw = rule.schedule;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const wd = Number(key);
      if (!Number.isInteger(wd) || wd < 0 || wd > 6 || !Array.isArray(value)) continue;
      const times: RuleTime[] = [];
      for (const t of value) {
        if (typeof t !== "object" || t === null) continue;
        const { startMin, durationMin, price } = t as Record<string, unknown>;
        if (typeof startMin !== "number" || startMin < 0 || startMin >= 24 * 60) continue;
        times.push({
          startMin,
          ...(typeof durationMin === "number" && durationMin > 0 ? { durationMin } : {}),
          ...(typeof price === "number" && price >= 0 ? { price } : {}),
        });
      }
      if (times.length > 0) out[String(wd)] = times.sort((a, b) => a.startMin - b.startMin);
    }
  }
  if (Object.keys(out).length > 0) return out;
  // Legacy rule: derive the single occurrence from the anchor.
  const wd = zonedDateParts(rule.anchor, timezone).weekday;
  return { [String(wd)]: [{ startMin: localMinutesOfDay(rule.anchor, timezone) }] };
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
  const schedule = effectiveSchedule(rule, timezone);
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
    // Build week k in full before deciding: whole weeks or nothing (see top).
    const week: (typeof rows)[number][] = [];
    let overHorizon = false;
    for (const [key, times] of Object.entries(schedule)) {
      const wd = Number(key);
      // Days count forward from the anchor's date, so week 0 never reaches
      // back before the series start.
      const offset = (wd - anchor.weekday + 7) % 7;
      for (const t of times) {
        const startsAt = zonedWallTimeToUtc(
          anchor.year,
          anchor.month0,
          anchor.day + k * 7 + offset, // Date.UTC in the helper normalizes overflow
          t.startMin,
          timezone,
        );
        // Week 0 can straddle the series start on the anchor's own day (a
        // morning time when the series was created for tonight): never
        // materialize before the anchor.
        if (startsAt.getTime() < rule.anchor.getTime()) continue;
        if (startsAt.getTime() > horizonEnd.getTime()) {
          overHorizon = true;
          break;
        }
        week.push({
          staffId: rule.staffId,
          serviceId: rule.serviceId,
          label: rule.label,
          startsAt,
          durationMin: t.durationMin ?? rule.durationMin,
          price: t.price ?? rule.price,
          ruleId: rule.id,
        });
      }
      if (overHorizon) break;
    }
    if (overHorizon) break;
    rows.push(...week);
    k++;
    // A schedule that materialized nothing in its first week (all times before
    // the anchor) still advances k - the loop terminates on the horizon.
  }

  if (k === rule.weeksMaterialized) return 0;
  // createMany + cursor advance in ONE tx (shop-scoped for RLS), guarded on the
  // cursor still being where we read it — if a concurrent run already extended,
  // the guard matches 0 rows and we skip instead of duplicating. `active: true`
  // is part of the guard: the roll-forward reads its rule list up front, so a
  // series the barber turns OFF mid-job (delete sets active:false and removes
  // future rows) must not have a fresh batch resurrected under it.
  return runWithShop(rule.shopId, async (tx) => {
    const advanced = await tx.targetedSlotRule.updateMany({
      where: { id: rule.id, active: true, weeksMaterialized: rule.weeksMaterialized },
      data: { weeksMaterialized: k },
    });
    if (advanced.count === 0) return 0;
    if (rows.length > 0) {
      // createManyAndReturn (not createMany): the join rows below need the new
      // slot ids, and doing it in one round trip keeps both inside the same
      // cursor-guarded transaction - a crashed run can still never leave slots
      // without their service listings.
      const created = await tx.targetedSlot.createManyAndReturn({
        data: rows.map((r) => ({ ...r, shopId: rule.shopId, price: r.price as never })),
        select: { id: true },
      });
      const serviceIds = slotServiceIds(rule);
      await tx.targetedSlotService.createMany({
        data: created.flatMap((slot) =>
          serviceIds.map((serviceId) => ({
            shopId: rule.shopId,
            slotId: slot.id,
            serviceId,
          })),
        ),
        // Idempotent against the unique(slotId, serviceId): a retried run
        // cannot duplicate a listing.
        skipDuplicates: true,
      });
    }
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
      services: { select: { serviceId: true } },
      label: true,
      anchor: true,
      durationMin: true,
      price: true,
      schedule: true,
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
