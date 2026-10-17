import { prisma } from "@chairback/db";
import type { OnboardingFacts } from "@chairback/config/onboarding";

/**
 * What a shop has set up, read from its own data (config/onboarding.ts): the
 * ONE definition of these facts, for setup itself (GET /api/onboarding/state)
 * and for a team owner's view of a member's progress (GET /api/team/links).
 *
 * Shop and the connections are default-deny inside a tenant transaction, so
 * this reads with plain prisma, every query scoped by the shop's id.
 */
export async function onboardingFactsFor(shopId: string): Promise<OnboardingFacts> {
  const [shop, acuity, square, staff, serviceCount, clientCount] = await Promise.all([
    prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: { bookingMode: true, bookingUrl: true },
    }),
    prisma.acuityConnection.findUnique({ where: { shopId }, select: { id: true } }),
    prisma.squareConnection.findUnique({ where: { shopId }, select: { id: true } }),
    prisma.staff.findMany({ where: { shopId, active: true }, select: { id: true } }),
    prisma.service.count({ where: { shopId, active: true } }),
    prisma.client.count({ where: { shopId } }),
  ]);
  const withHours =
    staff.length === 0
      ? []
      : await prisma.availabilityRule.findMany({
          where: { shopId, staffId: { in: staff.map((s) => s.id) } },
          distinct: ["staffId"],
          select: { staffId: true },
        });
  return {
    hasShop: true,
    bookingMode: shop.bookingMode as OnboardingFacts["bookingMode"],
    bookingUrl: shop.bookingUrl,
    integrationConnected: Boolean(acuity || square),
    staffCount: staff.length,
    serviceCount,
    staffWithHours: withHours.length,
    clientCount,
  };
}
