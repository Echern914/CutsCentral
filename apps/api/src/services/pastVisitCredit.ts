import { prisma, runWithShop } from "@chairback/db";
import { earnPunchForVisitInTx, liveExtraPunches, routeVisitEarn } from "./punch.js";

/**
 * CREDITING PAST VISITS: the owner's choice, previewed first, never automatic.
 *
 * A visit that ended before the shop turned rewards on does not earn by itself
 * (punch.ts). From the Rewards page the owner picks how far back - 3, 6 or 12
 * months before rewards started - sees what that would give, and confirms.
 *
 *  - Same earn rules as any visit. The preview asks routeVisitEarn and
 *    liveExtraPunches what each visit would earn (its card, the punches per
 *    visit, a promotion running the day it ended); the credit writes it
 *    through earnPunchForVisitInTx itself, so the two cannot disagree.
 *  - Silent. Nothing here texts, emails or pushes anyone - a message about
 *    visits from months ago is exactly what imported history must never send
 *    (engines/syncedVisitTrust.ts, rule 2). Balances are simply higher.
 *  - Never twice. A visit with any ledger row - earned, credited before, or
 *    undone by staff - is left out, and PunchLedger.visitId is unique besides.
 *  - Two confirms at once credit once. Each customer is locked (FOR UPDATE,
 *    like every ledger write) while their visits are credited, so the second
 *    confirm waits, then finds those visits earned and adds nothing.
 *
 * The credit commits one customer at a time. If it stops part way, confirming
 * again finishes the rest - nothing already credited is credited again.
 */

export const PAST_VISIT_MONTHS = [3, 6, 12] as const;
export type PastVisitMonths = (typeof PAST_VISIT_MONTHS)[number];

export type PastVisitCredit =
  | {
      ok: true;
      /** When rewards started; the credit covers [from, startedAt). */
      startedAt: Date;
      from: Date;
      visits: number;
      punches: number;
      customers: number;
    }
  | { ok: false; reason: "rewards_off" };

/** Generous: a year of a busy shop's visits, one or two queries each. */
const PREVIEW_TIMEOUT_MS = 60_000;

/**
 * `preview` counts what crediting would give and writes nothing; `credit`
 * writes it and counts what it actually wrote (anything credited in between,
 * say by a second tab, is not counted twice).
 */
export async function creditPastVisits(
  shopId: string,
  months: PastVisitMonths,
  mode: "preview" | "credit",
): Promise<PastVisitCredit> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, punchesPerVisit: true, rewardsEnabled: true, rewardsStartedAt: true },
  });
  if (!shop?.rewardsEnabled || !shop.rewardsStartedAt) return { ok: false, reason: "rewards_off" };
  const startedAt = shop.rewardsStartedAt;
  const from = new Date(startedAt);
  from.setUTCMonth(from.getUTCMonth() - months);

  // Completed visits that ENDED in the window and have never been punched.
  const visits = await runWithShop(shop.id, (tx) =>
    tx.visit.findMany({
      where: {
        shopId: shop.id,
        status: "COMPLETED",
        canceledAt: null,
        noShow: false,
        punch: { is: null },
        OR: [
          { endAt: { gte: from, lt: startedAt } },
          { endAt: null, scheduledAt: { gte: from, lt: startedAt } },
        ],
      },
      select: { id: true, clientId: true, serviceName: true, endAt: true, scheduledAt: true },
      orderBy: [{ clientId: "asc" }, { scheduledAt: "asc" }],
    }),
  );

  let credited = 0;
  let punches = 0;
  const customers = new Set<string>();

  if (mode === "preview") {
    punches = await runWithShop(
      shop.id,
      async (tx) => {
        let sum = 0;
        for (const v of visits) {
          const route = await routeVisitEarn(tx, shop, v.clientId, v.serviceName);
          sum += route.baseAmount + (await liveExtraPunches(tx, shop.id, v.endAt ?? v.scheduledAt));
        }
        return sum;
      },
      { timeout: PREVIEW_TIMEOUT_MS },
    );
    credited = visits.length;
    for (const v of visits) customers.add(v.clientId);
  } else {
    const byClient = new Map<string, typeof visits>();
    for (const v of visits) byClient.set(v.clientId, [...(byClient.get(v.clientId) ?? []), v]);
    for (const [clientId, theirs] of byClient) {
      const done = await runWithShop(shop.id, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
        let n = 0;
        let p = 0;
        for (const v of theirs) {
          const earn = await earnPunchForVisitInTx(
            tx,
            shop,
            clientId,
            v.id,
            v.serviceName,
            v.endAt ?? v.scheduledAt,
            { evenBeforeStart: true },
          );
          if (earn) {
            n++;
            p += earn.earned;
          }
        }
        return { n, p };
      });
      credited += done.n;
      punches += done.p;
      if (done.n > 0) customers.add(clientId);
    }
  }

  return { ok: true, startedAt, from, visits: credited, punches, customers: customers.size };
}
