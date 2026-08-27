import { z } from "zod";
import { runWithShop } from "@chairback/db";
import {
  readChairEvents,
  serviceKey,
  serviceLabel,
  type ChairEvent,
} from "../../engines/insightsWindow.js";
import {
  INVALID_ARGS,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from "./types.js";
import { shopClock, windowFor, ymdSchema } from "./shopTime.js";

/**
 * How the business did over a window.
 *
 * ── 🔴 THERE IS ONE REVENUE DEFINITION AND THIS FILE DOES NOT OWN IT ─────────
 *
 * `readChairEvents()` owns it. This tool aggregates what that engine returns
 * and invents nothing, because a second answer to "what did I make" is worse
 * than no answer: the barber reads one number on the Insights page and a
 * different one from the assistant, and now neither is trusted.
 *
 * The first version of this file grouped `Appointment` rows directly and was
 * wrong in four ways at once:
 *
 *   1. it MISSED every Acuity/Square booking, because those are `Visit` rows -
 *      an Acuity-first shop would have read as if it had no business at all;
 *   2. it summed `paidAmount` only, ignoring Stripe payments entirely and
 *      ignoring refunds against them, so a fully refunded booking still
 *      counted as revenue;
 *   3. it counted FUTURE `BOOKED` rows as earned, so next month's diary read
 *      as this month's takings;
 *   4. it reported a `bookedValue` that was neither money in hand nor money
 *      owed, and could not be made to mean either. It is gone rather than
 *      renamed.
 *
 * What `earned` means - real collected money net of refunds where the shop
 * takes payment in-app, the chair-side checkout figure where the barber took
 * cash, the ticket where neither exists, and ZERO for a no-show - is documented
 * on `ChairEvent.earned`. Cancelled and pending-approval bookings are excluded
 * by the engine and so are absent here; they were never sold work.
 *
 * ── 🔴 FUTURE WORK IS NOT REVENUE ────────────────────────────────────────────
 *
 * `if (e.start > now) continue` is the Insights engine's rule, applied here
 * identically. A booking that has not happened is capacity, not takings. It is
 * reported separately as `upcoming` so the number is not simply lost.
 *
 * ── 🔴 SYNCED WORK HAS NO CHAIR ──────────────────────────────────────────────
 *
 * `Visit` carries no staffId. Synced work lands in an explicit
 * `unassignedSynced` bucket rather than being dropped - which would stop the
 * per-chair figures summing to the shop total - or spread across chairs, which
 * would be a guess presented as a fact.
 */

const MAX_DAYS = 366;

const schema = z
  .object({
    from: ymdSchema,
    to: ymdSchema,
  })
  .strict();

/** Whole dollars, matching what the Insights page reports. */
const money = (n: number) => Math.round(n);

interface Tally {
  cuts: number;
  noShows: number;
  earned: number;
}
const tally = (): Tally => ({ cuts: 0, noShows: 0, earned: 0 });

function add(t: Tally, e: ChairEvent): void {
  t.cuts += 1;
  if (e.noShow) t.noShows += 1;
  t.earned += e.earned;
}

async function summary(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = schema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;

  const clock = await shopClock(inv.shopId);
  if (!clock) {
    return { ok: false, code: "shop_not_found", message: "That shop is no longer available." };
  }
  const window = windowFor(parsed.data.from, parsed.data.to, clock, MAX_DAYS);
  if (!window) {
    return { ok: false, code: "window_too_wide", message: "Ask for a range of a year or less." };
  }

  const { events, chairs } = await runWithShop(inv.shopId, async (tx) => {
    // ONE read for the whole window, native and synced together, deduplicated
    // by the engine: its `appointment: null` filter keeps a Visit promoted from
    // a native booking from counting the same hour twice.
    const { events } = await readChairEvents(inv.shopId, window.from, window.to, { tx });
    const chairs = await tx.staff.findMany({
      where: { shopId: inv.shopId },
      select: { id: true, name: true },
    });
    return { events, chairs };
  });

  const shop = tally();
  const unassigned = tally();
  const byChair = new Map<string, Tally>();
  const byService = new Map<string, Tally & { serviceId: string | null; name: string }>();

  // Average TICKET, priced non-no-shows only: an unpriced walk-in is not a $0
  // sale and a no-show is not a sale at all. The Insights page's own rule.
  let pricedTotal = 0;
  let pricedCount = 0;
  let upcoming = 0;

  for (const e of events) {
    // 🔴 The Insights rule, applied identically. Not yet happened, not earned.
    if (e.start > inv.now) {
      upcoming += 1;
      continue;
    }

    add(shop, e);
    if (e.price !== null && !e.noShow) {
      pricedTotal += e.price;
      pricedCount += 1;
    }

    if (e.staffId) {
      const t = byChair.get(e.staffId) ?? tally();
      add(t, e);
      byChair.set(e.staffId, t);
    } else {
      add(unassigned, e);
    }

    const key = serviceKey(e);
    const s = byService.get(key) ?? { ...tally(), serviceId: e.serviceId, name: serviceLabel(e) };
    add(s, e);
    byService.set(key, s);
  }

  return {
    ok: true,
    resource: { type: "business_summary", id: null },
    data: {
      timezone: clock.timezone,
      from: parsed.data.from,
      to: parsed.data.to,
      // Everything below counts work that had already STARTED by this instant.
      // Stated on the wire so an assistant reading a part-elapsed window knows
      // the totals are to-date rather than final.
      countedThrough: new Date(Math.min(inv.now.getTime(), window.to.getTime())).toISOString(),
      work: {
        cuts: shop.cuts,
        noShows: shop.noShows,
        // Booked, inside the window, still ahead. Capacity - deliberately kept
        // out of every earned figure above.
        upcoming,
      },
      revenue: {
        earned: money(shop.earned),
        averageTicket: pricedCount > 0 ? money(pricedTotal / pricedCount) : null,
        currency: "USD",
      },
      byChair: chairs.map((c) => {
        const t = byChair.get(c.id) ?? tally();
        return {
          staffId: c.id,
          chair: c.name,
          cuts: t.cuts,
          noShows: t.noShows,
          earned: money(t.earned),
        };
      }),
      // 🔴 Named for exactly what it is. Without it the per-chair figures would
      // not sum to the shop total, and the difference would look like a bug.
      unassignedSynced: {
        cuts: unassigned.cuts,
        noShows: unassigned.noShows,
        earned: money(unassigned.earned),
        why: "Bookings synced from Acuity or Square do not record which chair worked them.",
      },
      byService: [...byService.values()]
        .sort((a, b) => b.cuts - a.cuts || b.earned - a.earned)
        .slice(0, 25)
        .map((s) => ({
          serviceId: s.serviceId,
          service: s.name,
          cuts: s.cuts,
          earned: money(s.earned),
        })),
    },
  };
}

export const businessTools: ToolDefinition[] = [
  {
    name: "business_summary",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD in the shop's timezone." },
        to: { type: "string", description: "Last day, YYYY-MM-DD." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    handler: summary,
  },
];
