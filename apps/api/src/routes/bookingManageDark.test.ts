import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The DARK half of the appointment-pass contract, in a file that deliberately
 * sets NO WALLET_APPT_* env (unlike appointmentPassRoutes.test.ts):
 *
 *   - "Add to Calendar" works from the moment the code deploys - it needs no
 *     certificate, no vendor, nothing.
 *   - the wallet download 404s, exactly as the email hides its button, so an
 *     unconfigured deploy exposes no dead link and no probe-able surface.
 */
const app = createApp();
let userId: string;
let shopId: string;
let manageToken: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `dark-${randomToken(6)}@test.local`, passwordHash: "x", name: "D" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Dark Cuts",
      slug: `dark-${randomToken(5)}`.toLowerCase(),
      bookingMode: "native",
      webhookSecret: randomToken(),
      compAccess: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Skin Fade", durationMin: 30 },
  });
  const startsAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.id,
      serviceId: service.id,
      firstName: "Casey",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(),
    },
    select: { manageToken: true },
  });
  manageToken = appt.manageToken;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("while the appointment pass type is unconfigured", () => {
  it("🔴 the wallet download 404s - no dead surface, nothing to probe", async () => {
    const res = await request(app).get(`/api/book/manage/${manageToken}/wallet-pass`);
    expect(res.status).toBe(404);
  });

  it("but Add to Calendar works regardless - it depends on nothing", async () => {
    const res = await request(app).get(`/api/book/manage/${manageToken}/calendar.ics`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    expect(res.text).toContain("BEGIN:VEVENT");
  });
});
