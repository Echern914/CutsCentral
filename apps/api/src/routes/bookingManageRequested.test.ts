import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * GET /api/book/manage/:token names WHY a pending appointment is pending.
 *
 * The manage page used to tell every PENDING customer "Confirmed". The page now
 * reads "Requested" from the shared status table; this pins the one extra fact
 * it needs from the API - who the customer is waiting on - and that nothing
 * beyond the reason (not the hold's expiry) crosses the wire.
 */
const app = createApp();
let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let slot = 0;

async function appointment(data: {
  status: "PENDING" | "BOOKED";
  holdReason?: string | null;
  holdExpiresAt?: Date | null;
}): Promise<string> {
  // Distinct start per row: the (staffId, startsAt) partial unique covers
  // BOOKED and PENDING together.
  slot += 1;
  const startsAt = new Date(Date.now() + (24 + slot) * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Casey",
      status: data.status,
      holdReason: data.holdReason ?? null,
      holdExpiresAt: data.holdExpiresAt ?? null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(),
    },
    select: { manageToken: true },
  });
  return appt.manageToken;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `req-${randomToken(6)}@test.local`, passwordHash: "x", name: "R" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Request Cuts",
      slug: `req-${randomToken(5)}`.toLowerCase(),
      bookingMode: "native",
      webhookSecret: randomToken(),
      compAccess: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Skin Fade", durationMin: 30 } })
  ).id;
});

afterAll(async () => {
  if (userId) {
    await prisma.shop.deleteMany({ where: { ownerId: userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

describe("a pending appointment says who the customer is waiting on", () => {
  it("an approval request (no hold expiry) waits on the shop", async () => {
    const token = await appointment({ status: "PENDING" });
    const res = await request(app).get(`/api/book/manage/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.requested).toEqual({ reason: "approval" });
  });

  it("a payment hold waits on the customer's payment", async () => {
    const token = await appointment({
      status: "PENDING",
      holdReason: "payment",
      holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const res = await request(app).get(`/api/book/manage/${token}`);
    expect(res.body.requested).toEqual({ reason: "payment" });
  });

  it("a receptionist hold is being arranged by text", async () => {
    const token = await appointment({
      status: "PENDING",
      holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const res = await request(app).get(`/api/book/manage/${token}`);
    expect(res.body.requested).toEqual({ reason: "arranging" });
  });

  it("a booked appointment is not a request", async () => {
    const token = await appointment({ status: "BOOKED" });
    const res = await request(app).get(`/api/book/manage/${token}`);
    expect(res.body.requested).toBeNull();
  });

  it("the hold's internals never reach the customer", async () => {
    const token = await appointment({
      status: "PENDING",
      holdReason: "payment",
      holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const res = await request(app).get(`/api/book/manage/${token}`);
    expect(res.body).not.toHaveProperty("holdReason");
    expect(res.body).not.toHaveProperty("holdExpiresAt");
  });
});
