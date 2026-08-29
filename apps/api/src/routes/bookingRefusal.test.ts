import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { readBookingRefusals, recordBookingRefusal } from "../services/bookingRefusal.js";

/**
 * The booking canary.
 *
 * The property under test is NOT "a counter increments" - it is "a refusal
 * that turns a customer away becomes visible without anyone remembering to
 * make it visible". The create route refuses in seventeen places; the counting
 * lives in one wrapper so the eighteenth is covered the day it is written.
 */

const app = createApp();
const TZ = "America/New_York";
const emails: string[] = [];
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;

const settle = () => new Promise((r) => setTimeout(r, 250));

beforeAll(async () => {
  const email = `canary-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({ data: { email, name: "C" }, select: { id: true } });
  slug = `canary-${randomToken(5)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Canary Cuts",
      slug,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 2,
      bookingMaxDays: 60,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  serviceId = service.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 10 * 60,
      endMin: 20 * 60,
    })),
  });
});

afterEach(async () => {
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "bookRefuse:" } } });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

const countsFor = async (code: string): Promise<number> => {
  const { rows } = await readBookingRefusals(new Date(), 2);
  return rows.filter((r) => r.code === code && r.shopId === shopId).reduce((n, r) => n + r.count, 0);
};

describe("refusals become visible without anyone instrumenting them", () => {
  it("counts an invalid_slot refusal against the shop that refused it", async () => {
    // A well-formed request for a time that is not a slot - exactly the shape
    // that turned customers away for two months in silence (#344).
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: zonedWallTimeToUtc(2026, 8, 12, 15 * 60 + 47, TZ).toISOString(),
        firstName: "Zz",
        lastName: "Canary",
        email: "zz@test.local",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");

    await settle();
    expect(await countsFor("invalid_slot")).toBe(1);
  });

  it("attributes a pre-shop refusal to 'unresolved' rather than losing it", async () => {
    const res = await request(app).post("/api/book/no-such-shop-anywhere").send({
      staffId,
      serviceId,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      firstName: "Zz",
      lastName: "Canary",
      email: "zz@test.local",
    });
    expect(res.status).toBe(404);
    await settle();
    const { rows } = await readBookingRefusals(new Date(), 2);
    expect(rows.some((r) => r.shopId === "unresolved" && r.code === "not_found")).toBe(true);
  });

  it("does NOT count a successful booking", async () => {
    const startsAt = zonedWallTimeToUtc(2026, 8, 12, 11 * 60, TZ);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: startsAt.toISOString(),
        firstName: "Zz",
        lastName: "Success",
        email: "zz@test.local",
      });
    expect(res.status).toBe(201);
    await settle();
    const { total } = await readBookingRefusals(new Date(), 2);
    expect(total).toBe(0);
    await prisma.appointment.deleteMany({ where: { shopId } });
  });
});

describe("alerting on the shapes that mean WE are broken", () => {
  it("alerts on the third invalid_slot in an hour - the parity canary", async () => {
    const { logger } = await import("../logger.js");
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      const now = new Date();
      recordBookingRefusal(shopId, "invalid_slot", now);
      await settle();
      expect(errSpy).not.toHaveBeenCalled(); // one is a stale page, not an outage
      recordBookingRefusal(shopId, "invalid_slot", now);
      await settle();
      expect(errSpy).not.toHaveBeenCalled();

      recordBookingRefusal(shopId, "invalid_slot", now);
      await settle();
      expect(errSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(errSpy.mock.calls);
      expect(logged).toContain("invalid_slot");
      expect(logged).toContain(shopId);

      // Fires on the CROSSING only - a broken shop reports hourly, not per
      // request, so the signal survives contact with a real outage.
      recordBookingRefusal(shopId, "invalid_slot", now);
      await settle();
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("alerts on the FIRST create_failed - a 500 is never routine", async () => {
    const { logger } = await import("../logger.js");
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      recordBookingRefusal(shopId, "create_failed", new Date());
      await settle();
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("stays SILENT for slot_taken - two customers racing is healthy", async () => {
    const { logger } = await import("../logger.js");
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      const now = new Date();
      for (let i = 0; i < 25; i++) recordBookingRefusal(shopId, "slot_taken", now);
      await settle();
      expect(errSpy).not.toHaveBeenCalled();
      // Still COUNTED though - visible on the board, just not an alarm.
      expect(await countsFor("slot_taken")).toBe(25);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("the board carries counts and nothing else", () => {
  it("stores no customer, phone, name or slot time in its keys", async () => {
    await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: zonedWallTimeToUtc(2026, 8, 12, 15 * 60 + 47, TZ).toISOString(),
        firstName: "Zebediah",
        lastName: "Quill",
        phone: "+12125557788",
        email: "zeb@test.local",
      });
    await settle();
    const rows = await prisma.rateLimitCounter.findMany({
      where: { key: { startsWith: "bookRefuse:" } },
      select: { key: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    const flat = JSON.stringify(rows);
    for (const secret of ["Zebediah", "Quill", "+12125557788", "zeb@test.local", "15:47"]) {
      expect(flat).not.toContain(secret);
    }
  });
});
