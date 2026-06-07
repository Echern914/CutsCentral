import { Router } from "express";
import { prisma } from "@chairback/db";
import { currentBalance } from "../services/punch.js";

/**
 * Public rewards endpoint. The magicToken in the path IS the auth - it resolves
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

  const now = new Date();
  const balance = await currentBalance(client.shopId, client.id);
  const [visits, upcoming] = await Promise.all([
    prisma.visit.findMany({
      where: { shopId: client.shopId, clientId: client.id, status: "COMPLETED" },
      orderBy: { scheduledAt: "desc" },
      take: 10,
      select: { scheduledAt: true, serviceName: true },
    }),
    prisma.visit.findFirst({
      where: {
        shopId: client.shopId,
        clientId: client.id,
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        scheduledAt: { gt: now },
      },
      orderBy: { scheduledAt: "asc" },
      select: { scheduledAt: true },
    }),
  ]);

  const threshold = client.shop.rewardThreshold;

  // Rebooking countdown: deadline = lastVisit + rebookWindowDays. The client-side
  // timer ticks down to this ISO instant. We surface the state so the UI can show
  // the right message (booked / counting down / overdue / no-data).
  const lastVisitAt = client.lastVisitAt ?? visits[0]?.scheduledAt ?? null;
  const windowDays = client.shop.rebookWindowDays;
  let rebook: {
    state: "booked" | "counting" | "overdue" | "none";
    deadline: string | null;
    windowDays: number;
    upcomingAt: string | null;
  };
  if (upcoming) {
    rebook = { state: "booked", deadline: null, windowDays, upcomingAt: upcoming.scheduledAt.toISOString() };
  } else if (lastVisitAt) {
    const deadline = new Date(lastVisitAt.getTime() + windowDays * 86_400_000);
    rebook = {
      state: deadline.getTime() > now.getTime() ? "counting" : "overdue",
      deadline: deadline.toISOString(),
      windowDays,
      upcomingAt: null,
    };
  } else {
    rebook = { state: "none", deadline: null, windowDays, upcomingAt: null };
  }

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
    rebook,
    visits: visits.map((v) => ({
      date: v.scheduledAt.toISOString(),
      service: v.serviceName,
    })),
  });
});
