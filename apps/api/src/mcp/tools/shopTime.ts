import { z } from "zod";
import { prisma } from "@chairback/db";
import { zonedWallTimeToUtc } from "@chairback/config";

/**
 * Turning "Tuesday" into two UTC instants, once, for every tool that needs it.
 *
 * 🔴 THE BUG THIS EXISTS TO PREVENT. `new Date("2026-08-27")` is midnight UTC,
 * not midnight in the shop's timezone — so a shop in New York asking for
 * "today" gets a window that starts at 8pm the previous evening and ends at 8pm
 * today. Every appointment after 8pm falls out of the answer and the assistant
 * reports an empty evening. This repo has already shipped that bug once
 * (booking timezone, #125); the fix was `zonedWallTimeToUtc` and it is the only
 * way a wall-clock date becomes an instant here.
 */

/** `YYYY-MM-DD`, validated as a real calendar date rather than just a shape. */
export const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    // Round-trip through UTC to reject 2026-02-30 and friends.
    const probe = new Date(Date.UTC(y, m - 1, d));
    return (
      probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
    );
  }, "not a real date");

export interface ShopClock {
  timezone: string;
}

/**
 * The shop's timezone.
 *
 * 🔴 Read on the OWNER connection, outside any `forShop` transaction. Shop
 * carries RLS with no policy for the app role, so the same read inside a
 * tenant transaction silently returns null — which would look like "no such
 * shop" in production and nowhere else.
 */
export async function shopClock(shopId: string): Promise<ShopClock | null> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true },
  });
  return shop ? { timezone: shop.timezone } : null;
}

export interface UtcWindow {
  from: Date;
  to: Date;
}

/**
 * `[from 00:00, to 24:00)` in shop-local time, as UTC instants.
 *
 * Returns null when the range is backwards or wider than `maxDays`. Refusing is
 * deliberate: silently clamping a too-wide range returns a partial answer that
 * looks complete, which is worse than being told to ask for less.
 */
export function windowFor(
  fromYmd: string,
  toYmd: string,
  clock: ShopClock,
  maxDays: number,
): UtcWindow | null {
  const [fy, fm, fd] = fromYmd.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = toYmd.split("-").map(Number) as [number, number, number];

  const from = zonedWallTimeToUtc(fy, fm - 1, fd, 0, clock.timezone);
  // 24 * 60 minutes past midnight on the LAST day, so the window is inclusive
  // of that whole day. Expressed in minutes-from-midnight rather than by adding
  // 86_400_000ms, so a DST boundary inside the range resolves correctly.
  const to = zonedWallTimeToUtc(ty, tm - 1, td, 24 * 60, clock.timezone);

  if (to.getTime() <= from.getTime()) return null;
  if (to.getTime() - from.getTime() > maxDays * 86_400_000) return null;
  return { from, to };
}

/**
 * A person, reduced to what an answer actually needs.
 *
 * "Ricky T." is enough for a barber to know who their 2:15 is. The full surname
 * is not, and neither is anything else on the row. See the header of
 * mcp/tools/calendar.ts for why this matters more here than on a dashboard the
 * barber is looking at themselves.
 */
export function initialOnly(firstName: string | null, lastName: string | null): string {
  const first = (firstName ?? "").trim();
  const last = (lastName ?? "").trim();
  const initial = last ? `${last[0]!.toUpperCase()}.` : "";
  return [first, initial].filter(Boolean).join(" ") || "(no name)";
}
