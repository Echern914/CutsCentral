import { prisma } from "@chairback/db";
import type { ShopRole } from "../auth/roles.js";

/**
 * "Does this user still have a seat at this shop, and as what?"
 *
 * 🔴 ONE IMPLEMENTATION, DELIBERATELY. This question is asked at four different
 * moments in the MCP lifecycle - at consent, at code exchange, at every refresh,
 * and at every single authenticated request - and two of those are the ones that
 * make "losing your seat cuts access immediately" true. Two subtly different
 * answers to "can this person act here" is exactly the shape of a privilege bug,
 * so there is one function and every caller uses it.
 *
 * OWNERSHIP FIRST, then membership. `Shop.ownerId` is the source of truth and an
 * owner's access must never depend on a ShopMember row existing or being
 * correct. This mirrors `resolveShopAccess` in middleware/auth.ts on purpose -
 * the two must never disagree about who may act in a shop.
 *
 * A stored OWNER seat on a shop the user does NOT own does not grant owner
 * powers: that combination is only reachable if ownership were transferred
 * without fixing seats, and it must degrade, not escalate.
 */
export interface McpSeat {
  role: ShopRole;
  /** The chair this seat works, when it is linked to one. Null for an owner. */
  staffId: string | null;
}

export async function resolveMcpSeat(userId: string, shopId: string): Promise<McpSeat | null> {
  const [owned, seat] = await Promise.all([
    prisma.shop.findFirst({ where: { id: shopId, ownerId: userId }, select: { id: true } }),
    prisma.shopMember.findFirst({
      where: { userId, shopId },
      select: { role: true, staffId: true },
    }),
  ]);

  if (owned) return { role: "OWNER", staffId: null };
  if (!seat) return null;
  return { role: (seat.role as ShopRole) ?? "BARBER", staffId: seat.staffId ?? null };
}

/** The boolean form, for the places that only need "still allowed?". */
export async function hasShopAccess(userId: string, shopId: string): Promise<boolean> {
  return (await resolveMcpSeat(userId, shopId)) !== null;
}
