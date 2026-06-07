import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

const app = createApp();
let userId: string;
let shopId: string;
let magicToken: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `rw-${randomToken(6)}@test.local`, passwordHash: "x", name: "RW" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Reward Cuts",
      bookingUrl: "https://rw.test",
      rewardThreshold: 10,
      rewardLabel: "Free Cut",
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
  magicToken = randomToken();
  const client = await forShop(shopId).client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: "tel:+13025557777" } },
    create: { acuityClientKey: "tel:+13025557777", magicToken, firstName: "Reward" },
    update: {},
  });
  // Give 3 completed visits -> balance 3.
  for (let i = 0; i < 3; i++) {
    const v = await forShop(shopId).visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: `rw-v${i}` } },
      create: {
        clientId: client.id,
        acuityAppointmentId: `rw-v${i}`,
        status: "COMPLETED",
        scheduledAt: new Date(`2026-0${i + 1}-01T15:00:00Z`),
        serviceName: "Haircut",
      },
      update: {},
    });
    await forShop(shopId).punch.create({
      data: {
        clientId: client.id,
        visitId: v.id,
        punchesEarned: 1,
        runningBalance: i + 1,
        note: "visit",
      },
    });
  }
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("GET /api/rewards/:magicToken", () => {
  it("404s on an unknown token (no probing oracle)", async () => {
    const res = await request(app).get("/api/rewards/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("resolves shop + client + punch balance by magic token", async () => {
    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.name).toBe("Reward Cuts");
    expect(res.body.shop.rewardThreshold).toBe(10);
    expect(res.body.client.firstName).toBe("Reward");
    expect(res.body.punches.balance).toBe(3);
    expect(res.body.punches.towardNext).toBe(3);
    expect(res.body.visits.length).toBe(3);
  });
});
