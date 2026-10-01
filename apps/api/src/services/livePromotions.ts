import type { Prisma } from "@chairback/db";

/**
 * A shop's LIVE deals, as a client sees them: switched on, started, not yet
 * ended - soonest-ending first, at most six. One rule for every client
 * surface: the public page, the web rewards page and the app's Rewards tab.
 */
export interface PublicPromotion {
  id: string;
  kind: "PERCENT_OFF" | "AMOUNT_OFF" | "FREE_ADDON" | "EXTRA_PUNCHES";
  title: string;
  description: string | null;
  code: string | null;
  percentOff: number | null;
  amountOff: number | null;
  extraPunches: number | null;
  /** ISO, or null for a deal with no end. */
  endsAt: string | null;
}

export async function livePromotions(
  db: Pick<Prisma.TransactionClient, "promotion">,
  shopId: string,
  now: Date,
): Promise<PublicPromotion[]> {
  const rows = await db.promotion.findMany({
    where: {
      shopId,
      active: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    orderBy: [{ endsAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 6,
    select: {
      id: true,
      kind: true,
      title: true,
      description: true,
      code: true,
      percentOff: true,
      amountOff: true,
      extraPunches: true,
      endsAt: true,
    },
  });
  return rows.map((p) => ({
    ...p,
    kind: p.kind as PublicPromotion["kind"],
    amountOff: p.amountOff === null ? null : Number(p.amountOff),
    endsAt: p.endsAt?.toISOString() ?? null,
  }));
}
