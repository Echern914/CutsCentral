import { z } from "zod";
import { forShop, runWithShop } from "@chairback/db";
import { openingSpansForWeekday, parseServiceHours } from "../engines/pricing.js";

/**
 * One person's weekly hours: the read and the replace-all write.
 *
 * Moved out of routes/booking.dashboard.ts, bodies unchanged, because two
 * surfaces now edit hours: the owner's dashboard (any person in the shop) and
 * a team member's own calendar (their own, and only their own - see
 * routes/barberCalendar.ts). One copy, so the two can never disagree about
 * what a valid week is or what the editor is told.
 *
 * 🔴 Neither function decides WHOSE hours these are. The caller passes the
 * staff id, and it is the caller's job to have taken it from somewhere it can
 * trust: the dashboard takes it from the URL behind the manager gate, a team
 * member's surface takes it from the session and never from the request.
 */

const ruleSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startMin: z.number().int().min(0).max(1440),
  endMin: z.number().int().min(0).max(1440),
});
// A recurring weekly block-off: same shape as a rule + an optional label.
const blockSchema = ruleSchema.extend({
  reason: z.string().trim().max(200).optional(),
});
export const availabilitySchema = z
  .object({
    rules: z.array(ruleSchema).max(100),
    // Recurring weekly block-offs (standing breaks). Replace-all like rules.
    recurringBlocks: z.array(blockSchema).max(100).optional().default([]),
  })
  .strict()
  .refine(
    (d) =>
      d.rules.every((r) => r.endMin > r.startMin) &&
      d.recurringBlocks.every((b) => b.endMin > b.startMin),
    { message: "Each rule/block's end must be after its start." },
  );

export type AvailabilityInput = z.infer<typeof availabilitySchema>;

export interface StaffAvailability {
  rules: { id: string; weekday: number; startMin: number; endMin: number }[];
  recurringBlocks: {
    id: string;
    weekday: number;
    startMin: number;
    endMin: number;
    reason: string | null;
  }[];
  exceptions: {
    id: string;
    startsAt: string;
    endsAt: string;
    isBlock: boolean;
    reason: string | null;
  }[];
  weekdaysWithNoService: number[];
}

/** The week as the hours editor shows it, or null when the person is not in this shop. */
export async function readStaffAvailability(
  shopId: string,
  staffId: string,
): Promise<StaffAvailability | null> {
  const db = forShop(shopId);
  const staff = await db.staff.findFirst({
    where: { id: staffId },
    select: { id: true },
  });
  if (!staff) return null;
  const [rules, recurringBlocks, exceptions] = await Promise.all([
    db.availabilityRule.findMany({
      where: { staffId },
      orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
    }),
    db.recurringBlock.findMany({
      where: { staffId },
      orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
    }),
    db.availabilityException.findMany({
      where: { staffId, endsAt: { gt: new Date() } },
      orderBy: { startsAt: "asc" },
    }),
  ]);
  return {
    rules: rules.map((r) => ({
      id: r.id,
      weekday: r.weekday,
      startMin: r.startMin,
      endMin: r.endMin,
    })),
    recurringBlocks: recurringBlocks.map((b) => ({
      id: b.id,
      weekday: b.weekday,
      startMin: b.startMin,
      endMin: b.endMin,
      reason: b.reason,
    })),
    exceptions: exceptions.map((e) => ({
      id: e.id,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      isBlock: e.isBlock,
      reason: e.reason,
    })),
    // 🔴 THE DAY THE BARBER TURNS ON THAT STILL SHOWS NOTHING.
    //
    // Two gates decide a bookable day and only one of them is in this editor:
    // the staff schedule says WHEN this person works, and each service's own
    // hours say WHETHER that service is offered that weekday. A weekday
    // present-but-empty in a service's hoursWindows means "not offered", and
    // that veto is applied AFTER the staff hours - so a barber can tick
    // Sunday, see it ticked, and watch the public page keep showing Sunday
    // struck through, with nothing anywhere saying why. That is a real support
    // text (2026-09-17, a barber who had turned Sunday on twice).
    //
    // So the API says which weekdays have no service behind them, and the
    // editor can warn on exactly the days the barber just enabled.
    weekdaysWithNoService: await weekdaysWithNoServiceFor(shopId, staffId),
  };
}

/**
 * Weekdays on which NOT ONE of this staff member's active services is offered.
 *
 * Mirrors engines/slots.ts exactly, by calling the same two parsers rather than
 * restating their rules: a weekday ABSENT from hoursWindows is unrestricted,
 * PRESENT-and-empty is closed, and an "also open these hours" window
 * (timeOverrides) opens the day back up regardless of the restriction.
 */
async function weekdaysWithNoServiceFor(shopId: string, staffId: string): Promise<number[]> {
  const db = forShop(shopId);
  const links = await db.serviceStaff.findMany({
    where: { staffId },
    select: { serviceId: true },
  });
  if (links.length === 0) return []; // no services at all is its own readiness item
  const services = await db.service.findMany({
    where: { id: { in: links.map((l) => l.serviceId) }, active: true },
    select: { hoursWindows: true, timeOverrides: true },
  });
  if (services.length === 0) return [];
  const out: number[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    const covered = services.some((s) => {
      const map = parseServiceHours(s.hoursWindows);
      const windows = map.get(weekday);
      // Absent = unrestricted; present with windows = offered within them.
      if (windows === undefined || windows.length > 0) return true;
      // Present but empty: only an explicit opening window can still open it.
      return openingSpansForWeekday(s.timeOverrides, weekday).length > 0;
    });
    if (!covered) out.push(weekday);
  }
  return out;
}

/**
 * Replace the entire weekly rule set for one person in one transaction.
 * False when the person is not in this shop (nothing was written).
 */
export async function replaceStaffAvailability(
  shopId: string,
  staffId: string,
  data: AvailabilityInput,
): Promise<boolean> {
  return runWithShop(shopId, async (tx) => {
    const staff = await tx.staff.findFirst({
      where: { id: staffId, shopId },
      select: { id: true },
    });
    if (!staff) return false;
    // Replace-all for BOTH rules and recurring blocks, atomically.
    await tx.availabilityRule.deleteMany({ where: { shopId, staffId } });
    if (data.rules.length > 0) {
      await tx.availabilityRule.createMany({
        data: data.rules.map((r) => ({ ...r, shopId, staffId })),
      });
    }
    await tx.recurringBlock.deleteMany({ where: { shopId, staffId } });
    if (data.recurringBlocks.length > 0) {
      await tx.recurringBlock.createMany({
        data: data.recurringBlocks.map((b) => ({
          weekday: b.weekday,
          startMin: b.startMin,
          endMin: b.endMin,
          reason: b.reason ?? null,
          shopId,
          staffId,
        })),
      });
    }
    return true;
  });
}
