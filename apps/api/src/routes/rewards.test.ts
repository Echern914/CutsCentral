import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma, runAsOwner } from "@chairback/db";
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
      rewardsEnabled: true, // rewards are opt-IN for new shops; this suite exercises loyalty
      ownerId: userId,
      name: "Reward Cuts",
      bookingUrl: "https://rw.test",
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
  // A real menu: a big-ticket reward and a small one the client is close to.
  await forShop(shopId).reward.create({
    data: { name: "Free Cut", punchCost: 10, sortOrder: 0 },
  });
  await forShop(shopId).reward.create({
    data: { name: "Free Beard Trim", emoji: "🧔", punchCost: 5, sortOrder: 1 },
  });
  // Inactive rewards must stay hidden from clients.
  await forShop(shopId).reward.create({
    data: { name: "Retired Special", punchCost: 3, active: false, sortOrder: 2 },
  });
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

  it("resolves shop + client + the shop's reward menu by magic token", async () => {
    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.name).toBe("Reward Cuts");
    expect(res.body.client.firstName).toBe("Reward");
    expect(res.body.punches.balance).toBe(3);
    expect(res.body.visits.length).toBe(3);

    // Only ACTIVE rewards, in menu order, with per-reward progress.
    expect(res.body.rewards).toHaveLength(2);
    expect(res.body.rewards.map((r: { name: string }) => r.name)).toEqual([
      "Free Cut",
      "Free Beard Trim",
    ]);
    const beard = res.body.rewards[1];
    expect(beard.punchCost).toBe(5);
    expect(beard.ready).toBe(false);
    expect(beard.remaining).toBe(2);

    // Grid target = cheapest reward not yet affordable.
    expect(res.body.punches.nextTarget).toEqual({
      name: "Free Beard Trim",
      punchCost: 5,
      remaining: 2,
    });
  });

  it("marks rewards ready once the balance covers them", async () => {
    // Bonus punches to 5 -> beard trim affordable, cut not.
    const client = await prisma.client.findUnique({ where: { magicToken } });
    await forShop(shopId).punch.create({
      data: {
        clientId: client!.id,
        punchesEarned: 2,
        runningBalance: 5,
        note: "bonus",
      },
    });

    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.punches.balance).toBe(5);
    const [cut, beard] = res.body.rewards;
    expect(beard.ready).toBe(true);
    expect(cut.ready).toBe(false);
    // Next target moves up to the cut.
    expect(res.body.punches.nextTarget).toEqual({
      name: "Free Cut",
      punchCost: 10,
      remaining: 5,
    });
  });
});

describe("POST /api/rewards/:magicToken/delete", () => {
  it("404s on an unknown token", async () => {
    const res = await request(app).post("/api/rewards/does-not-exist/delete");
    expect(res.status).toBe(404);
  });

  it("anonymizes the client, kills the link, and scrubs PII everywhere - but keeps de-identified history", async () => {
    // A self-contained client (its own token) so the shared fixture above is
    // untouched. Seed it the way production writes - the raw tx inside
    // runAsOwner (RLS off) - with a visit, a push device, a wallet pass, and a
    // nudge whose body carries the first name (the off-row PII we must scrub).
    const delToken = randomToken();
    const { clientId, visitId, nudgeId, convoId } = await runAsOwner(async (tx) => {
      const client = await tx.client.create({
        data: {
          shopId,
          acuityClientKey: `del:${randomToken(6)}`,
          magicToken: delToken,
          firstName: "Deletes",
          lastName: "Herself",
          phone: "+13025550000",
          email: "del@test.local",
          optedOut: false,
          smsConsentAt: new Date(),
          smsConsentSource: "manual",
        },
      });
      const visit = await tx.visit.create({
        data: {
          shopId,
          clientId: client.id,
          acuityAppointmentId: `del-v-${randomToken(6)}`,
          status: "COMPLETED",
          scheduledAt: new Date("2026-05-01T15:00:00Z"),
          serviceName: "Haircut",
        },
      });
      await tx.pushSubscription.create({
        data: { shopId, clientId: client.id, endpoint: `https://push.test/${randomToken()}` },
      });
      await tx.walletPassRegistration.create({
        data: {
          shopId,
          clientId: client.id,
          deviceLibraryIdentifier: randomToken(),
          pushToken: randomToken(),
        },
      });
      const nudge = await tx.nudge.create({
        data: { shopId, clientId: client.id, body: "Hi Deletes, time for your next cut!" },
      });
      // An AI-receptionist SMS thread (phone + transcript) - a PII surface added
      // after this feature was first written; deletion must sweep it too.
      const convo = await tx.receptionistConversation.create({
        data: {
          shopId,
          clientId: client.id,
          phone: "+13025550000",
          messages: { create: { shopId, role: "user", content: "Hi, it's Deletes" } },
        },
      });
      return {
        clientId: client.id,
        visitId: visit.id,
        nudgeId: nudge.id,
        convoId: convo.id,
      };
    });

    const res = await request(app).post(`/api/rewards/${delToken}/delete`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The old link is dead.
    const gone = await request(app).get(`/api/rewards/${delToken}`);
    expect(gone.status).toBe(404);

    // The row survives, but every identifier is stripped and it's locked down.
    const after = await prisma.client.findUnique({ where: { id: clientId } });
    expect(after).not.toBeNull();
    expect(after!.firstName).toBeNull();
    expect(after!.lastName).toBeNull();
    expect(after!.phone).toBeNull();
    expect(after!.email).toBeNull();
    expect(after!.smsConsentAt).toBeNull();
    expect(after!.optedOut).toBe(true);
    expect(after!.optOutSource).toBe("deleted");
    expect(after!.archivedAt).not.toBeNull();
    expect(after!.magicToken).not.toBe(delToken); // rotated -> old link 404s
    expect(after!.acuityClientKey).toBe(`deleted:${clientId}`);

    // Device transports are gone; the nudge body (which held the first name) is
    // scrubbed; de-identified visit history stays.
    const subs = await prisma.pushSubscription.count({ where: { clientId } });
    const passes = await prisma.walletPassRegistration.count({ where: { clientId } });
    expect(subs).toBe(0);
    expect(passes).toBe(0);
    const nudge = await prisma.nudge.findUnique({ where: { id: nudgeId } });
    expect(nudge!.body).toBeNull();
    // The AI-receptionist thread (phone + transcript) is deleted outright.
    const convo = await prisma.receptionistConversation.findUnique({ where: { id: convoId } });
    expect(convo).toBeNull();
    const keptVisit = await prisma.visit.findUnique({ where: { id: visitId } });
    expect(keptVisit).not.toBeNull();
  });
});
