import { Router } from "express";
import { prisma } from "@chairback/db";
import { currentBalance } from "../services/punch.js";

/**
 * Public rewards endpoint. The magicToken in the path IS the auth — it resolves
 * both the client AND the shop. No session. 404 (not 403) on a bad token to
 * avoid a token-probing oracle. Never accepts a shopId from the request.
 */
export const rewardsRouter: Router = Router();

rewardsRouter.get("/:magicToken", async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { magicToken: req.params.magicToken },
    include: { shop: true },
  });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const balance = await currentBalance(client.shopId, client.id);
  const visits = await prisma.visit.findMany({
    where: { shopId: client.shopId, clientId: client.id, status: "COMPLETED" },
    orderBy: { scheduledAt: "desc" },
    take: 10,
    select: { scheduledAt: true, serviceName: true },
  });

  const threshold = client.shop.rewardThreshold;
  res.json({
    shop: {
      name: client.shop.name,
      bookingUrl: client.shop.bookingUrl,
      rewardLabel: client.shop.rewardLabel,
      rewardThreshold: threshold,
    },
    client: {
      firstName: client.firstName,
    },
    punches: {
      balance,
      threshold,
      towardNext: balance % threshold,
      rewardsUnlocked: Math.floor(balance / threshold),
    },
    visits: visits.map((v) => ({
      date: v.scheduledAt.toISOString(),
      service: v.serviceName,
    })),
  });
});
