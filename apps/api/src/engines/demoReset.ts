import { prisma } from "@chairback/db";
import { DEMO } from "@chairback/config";
import { logger } from "../logger.js";
import { seedDemoShop } from "../demo/seedDemoShop.js";

/**
 * Nightly restore of the live-demo tenant. The seeder is canonical-state by
 * construction (wipe + recreate), so one call both clears anything tour
 * viewers submitted off-script (reviews, waitlist joins, real bookings that
 * consume demo slots) AND re-rolls every date — the showcase appointment stays
 * "tomorrow", the last visit stays ~5 days ago, the promotion never expires,
 * and the demo client never drifts into nudge/win-back eligibility.
 *
 * No-op on environments that never seeded a demo shop (dev DBs, test DBs):
 * the job must not CREATE the tenant anywhere it wasn't deliberately placed.
 */
export async function runDemoReset(): Promise<void> {
  const demoShop = await prisma.shop.findFirst({
    where: { slug: DEMO.SHOP_SLUG },
    select: { id: true, owner: { select: { email: true } } },
  });
  if (!demoShop) return;
  if (demoShop.owner.email !== DEMO.OWNER_EMAIL) {
    // A real tenant claimed the slug — the seeder would refuse anyway; skip
    // quietly instead of erroring every night.
    logger.warn({ shopId: demoShop.id }, "shop with the demo slug is not the demo tenant; reset skipped");
    return;
  }

  const result = await seedDemoShop();
  logger.info({ shopId: result.shopId }, "demo shop reset to canonical state");
}
