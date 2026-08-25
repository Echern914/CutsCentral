import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { claimOffer } from "../engines/waitlistOffer.js";
import { materializeSeries } from "../engines/recurringSeries.js";
import { sha256Hex } from "../engines/waitlistJoin.js";

/**
 * ENFORCING WITH AN UNMAPPED CHAIR, ON EVERY PATH THAT BOOKS ONE.
 *
 * recordMirrorIntent throws MirrorNotConfiguredError from inside the booking
 * transaction when a shop is ENFORCING a chair Acuity cannot protect. That is
 * correct - confirming a booking Acuity still shows as free is the exact state
 * the mirror exists to prevent.
 *
 * 🔴 But exactly ONE of the paths that record a mirror intent caught it: the
 * public booking page. Dashboard create, walk-in, waitlist claim, recurring
 * series and the receptionist all answered a 500.
 *
 * That was never theoretical. Acuity runs in ENFORCE on a live shop, so hiring
 * a barber without mapping their calendar broke booking on five paths at once,
 * with an error that named nothing and read as the product being broken.
 *
 * Each case below fails against the old handling with a 500 or an unhandled
 * rejection; none passes by accident.
 */


const app = createApp();
const password = "Sup3rSecret!pass";

let cookie: string;
let shopId: string;
let serviceId: string;
/** Mapped: every mirror requirement satisfied. */
let mappedStaffId: string;
/** The new hire - present, bookable, and invisible to Acuity. */
let unmappedStaffId: string;
/** materializeSeries takes an already-resolved client. */
let seriesClientId: string;
const emails: string[] = [];

const soon = (min: number) => new Date(Date.now() + min * 60_000);

beforeAll(async () => {
  const email = `mnc-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Mirror Op", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

  const created = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Mirror Guard Cuts", smsAttested: true });
  shopId = created.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });

  // ENFORCING Acuity, which is the configuration that is live in production.
  await prisma.shop.update({
    where: { id: shopId },
    data: { acuityOutboundMode: "ENFORCE" },
  });
  await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: `ACC_${randomToken(6)}`,
      accessToken: "enc",
      refreshToken: "enc",
    },
  });

  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
  });
  serviceId = service.id;

  const conn = await prisma.acuityConnection.findUniqueOrThrow({
    where: { shopId },
    select: { connectedAt: true },
  });
  // 🔴 Derived from connectedAt, never `new Date()`: Postgres now() is
  // microsecond and JS Date is millisecond-truncated, so a fresh stamp reads
  // STALE about half the time.
  const mappedAt = new Date(conn.connectedAt.getTime() + 1000);

  const mapped = await prisma.staff.create({
    data: { shopId, name: "Mapped Marcus", acuityCalendarId: "4242", acuityCalendarMappedAt: mappedAt },
  });
  mappedStaffId = mapped.id;
  const unmapped = await prisma.staff.create({ data: { shopId, name: "New Hire Nia" } });
  unmappedStaffId = unmapped.id;

  const seriesClient = await prisma.client.create({
    data: {
      shopId,
      firstName: "Series",
      lastName: "Client",
      phone: "+15555550114",
      acuityClientKey: `series-${randomToken(8)}`,
      magicToken: randomToken(),
    },
    select: { id: true },
  });
  seriesClientId = seriesClient.id;

  for (const staffId of [mappedStaffId, unmappedStaffId]) {
    await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        shopId,
        staffId,
        weekday,
        startMin: 0,
        endMin: 24 * 60 - 1,
      })),
    });
  }
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  if (shopId) {
    await prisma.waitlistOffer.deleteMany({ where: { entry: { shopId } } });
    await prisma.waitlistEntry.deleteMany({ where: { shopId } });
    await prisma.appointment.deleteMany({ where: { shopId } });
    await prisma.recurringSeries.deleteMany({ where: { shopId } });
    await prisma.client.deleteMany({ where: { shopId } });
    await prisma.availabilityRule.deleteMany({ where: { shopId } });
    await prisma.serviceStaff.deleteMany({ where: { shopId } });
    await prisma.acuityConnection.deleteMany({ where: { shopId } });
    await prisma.staff.deleteMany({ where: { shopId } });
    await prisma.service.deleteMany({ where: { shopId } });
    await prisma.shop.deleteMany({ where: { id: shopId } });
  }
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("dashboard create", () => {
  it("refuses the unmapped barber with a clean 409, not a 500", async () => {
    const startsAt = soon(120);
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId: unmappedStaffId,
        serviceId,
        startsAt: startsAt.toISOString(),
        firstName: "Walk",
        lastName: "In",
        customTime: true,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_unavailable_external");
  });

  it("still books the MAPPED barber at the same moment", async () => {
    // The refusal is per chair. Disarming the shop, or refusing everyone,
    // would strip protection from the barbers who ARE mapped.
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId: mappedStaffId,
        serviceId,
        startsAt: soon(180).toISOString(),
        firstName: "Real",
        lastName: "Client",
        customTime: true,
      });
    expect(res.status).toBe(201);
  });
});

describe("walk-in", () => {
  it("RECORDS the walk-in anyway rather than refusing it", async () => {
    // Deliberately different from every other path. The money is already in
    // the till and the client is already in the chair - rolling the
    // transaction back to protect a calendar slot would lose a real payment
    // to protect a slot that is being physically occupied regardless.
    const res = await request(app)
      .post("/api/booking/appointments/walk-in")
      .set("Cookie", cookie)
      .send({ staffId: unmappedStaffId, amount: 35, method: "cash" });

    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirstOrThrow({
      where: { shopId, staffId: unmappedStaffId },
      select: { paidAmount: true, status: true },
    });
    expect(appt.status).toBe("COMPLETED");
    expect(Number(appt.paidAmount)).toBe(35);
  });
});

describe("waitlist claim", () => {
  it("answers unavailable_external instead of throwing", async () => {
    const entry = await prisma.waitlistEntry.create({
      data: {
        shopId,
        staffId: unmappedStaffId,
        serviceId,
        firstName: "Wait",
        lastName: "Lister",
        phone: "+15555550113",
        status: "CONTACTED",
      },
      select: { id: true },
    });
    const token = randomToken();
    const startsAt = soon(240);
    await prisma.waitlistOffer.create({
      data: {
        entryId: entry.id,
        shopId,
        staffId: unmappedStaffId,
        serviceId,
        tokenHash: sha256Hex(token),
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        status: "OFFERED",
        expiresAt: soon(300),
      },
    });

    const result = await claimOffer({ token });
    expect(result.outcome).toBe("unavailable_external");
  });
});

describe("recurring series", () => {
  it("skips every occurrence with a reason instead of failing the series", async () => {
    const anchor = soon(60 * 24 * 3);
    const result = await materializeSeries({
      shopId,
      staffId: unmappedStaffId,
      serviceId,
      clientId: seriesClientId,
      firstName: "Series",
      lastName: "Client",
      phone: "+15555550114",
      email: null,
      durationMin: 30,
      durationOverrides: null,
      timeOverrides: null,
      basePrice: 40,
      priceOverrides: null,
      dateOverrides: null,
      timezone: "UTC",
      bookingBufferMin: 0,
      // The barber forcing a time, exactly as the dashboard path does - the
      // availability gate is not what this test is about.
      checkAvailability: false,
      pattern: {
        interval: 1,
        weekday: anchor.getUTCDay(),
        startMin: anchor.getUTCHours() * 60 + anchor.getUTCMinutes(),
        count: 3,
      },
      anchor,
    });

    expect(result.booked).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    // A diagnosis, not "error" - every occurrence names the same real cause.
    expect(result.skipped.every((s) => s.reason === "unavailable_external")).toBe(true);
  });
});
