import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { shopDayAhead } from "../testing/shopDay.js";

/**
 * WHICH START TIMES FIT THE WHOLE PARTY.
 *
 * 🔴 THE FAILURE THIS ENDPOINT EXISTS TO PREVENT. /plan takes a start time as
 * an INPUT; nothing enumerated candidates. A picker built on /slug/slots would
 * offer times sized for ONE service, the customer taps 2:30, and the write
 * refuses - the grid disagreeing with the writer, which is the outage class
 * #344 was about. So the guarantee under test is not "it returns times", it is
 * "every time it returns is one /plan accepts".
 */
const app = createApp();
const TZ = "America/New_York";
const DAY = shopDayAhead(7, TZ, { avoidDstChange: true });
const at = (min: number) => zonedWallTimeToUtc(DAY.y, DAY.m0, DAY.d, min, TZ);

let userId: string;
let slug: string;
let shopId: string;
let staffId: string;
/** 30 min, 20 min, 45 min. */
let cutId: string;
let kidsId: string;
let longId: string;

let otherUserId: string;
let otherStaffId: string;
let otherServiceId: string;
let inactiveId: string;

async function makeService(shop: string, staff: string | null, name: string, dur: number, active = true) {
  const svc = await prisma.service.create({
    data: { shopId: shop, name, durationMin: dur, price: 40, active },
    select: { id: true },
  });
  if (staff) await prisma.serviceStaff.create({ data: { shopId: shop, serviceId: svc.id, staffId: staff } });
  return svc.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `gsl-${randomToken(6)}@test.local`, passwordHash: "x", name: "G" },
  });
  userId = user.id;
  slug = `gsl-${randomToken(5)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Slots Cuts",
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
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 10 * 60,
      endMin: 20 * 60,
    })),
  });
  cutId = await makeService(shopId, staffId, "Haircut", 30);
  kidsId = await makeService(shopId, staffId, "Kids cut", 20);
  longId = await makeService(shopId, staffId, "Colour", 45);
  inactiveId = await makeService(shopId, staffId, "Retired", 30, false);

  const other = await prisma.user.create({
    data: { email: `gslo-${randomToken(6)}@test.local`, passwordHash: "x", name: "O" },
  });
  otherUserId = other.id;
  const oshop = await prisma.shop.create({
    data: {
      ownerId: otherUserId,
      name: "Other",
      slug: `gslo-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
    },
    select: { id: true },
  });
  const ostaff = await prisma.staff.create({
    data: { shopId: oshop.id, name: "Other Sam" },
    select: { id: true },
  });
  otherStaffId = ostaff.id;
  otherServiceId = await makeService(oshop.id, ostaff.id, "Foreign", 30);
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentGroup.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  for (const id of [userId, otherUserId]) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

/**
 * Scoped to the FIXTURE DAY unless the caller says otherwise. Without `from`
 * the endpoint quite correctly starts at `now`, so the first candidates are
 * whatever is left of today - which says nothing about the grid being tested.
 */
const slots = (serviceIds: string[], q: Record<string, string> = {}) =>
  request(app)
    .get(`/api/book/${slug}/group/slots`)
    .query({
      staffId,
      serviceIds: serviceIds.join(","),
      from: at(0).toISOString(),
      to: at(24 * 60).toISOString(),
      ...q,
    });

const hhmm = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );

describe("the grid is sized for the whole party", () => {
  it("two different services: room for 50 minutes, stepped by the first", async () => {
    const res = await slots([cutId, kidsId]);
    expect(res.status).toBe(200);
    expect(res.body.totalDurationMin).toBe(50);
    // Stepped by the FIRST service (30), so starts are :00 and :30 - and the
    // window returned is the whole 50-minute run, not one haircut.
    const first = res.body.slots[0];
    expect(hhmm(first.startsAt)).toBe("10:00 AM");
    expect(
      (new Date(first.endsAt).getTime() - new Date(first.startsAt).getTime()) / 60_000,
    ).toBe(50);
  });

  it("three services add up", async () => {
    const res = await slots([cutId, kidsId, longId]);
    expect(res.status).toBe(200);
    expect(res.body.totalDurationMin).toBe(95); // 30 + 20 + 45
  });

  it("🔴 a REPEATED service id counts once PER ATTENDEE", async () => {
    // Two siblings wanting the same cut is the ordinary case, and the obvious
    // bug is deduplicating the list - which would size the grid for one of
    // them and book the second into thin air.
    const res = await slots([cutId, cutId]);
    expect(res.status).toBe(200);
    expect(res.body.totalDurationMin).toBe(60); // NOT 30

    const three = await slots([cutId, cutId, cutId]);
    expect(three.body.totalDurationMin).toBe(90);
  });

  it("🔴 ORDER is preserved - the first service steps the grid", async () => {
    // Same two services, opposite order. The total is identical but the grid
    // step is not: a 30-minute first service offers :00/:30, a 20-minute one
    // offers :00/:20/:40.
    const cutFirst = await slots([cutId, kidsId]);
    const kidsFirst = await slots([kidsId, cutId]);
    expect(cutFirst.body.totalDurationMin).toBe(kidsFirst.body.totalDurationMin);

    const startsOf = (r: { body: { slots: { startsAt: string }[] } }) =>
      r.body.slots.slice(0, 3).map((s) => hhmm(s.startsAt));
    expect(startsOf(cutFirst)).toEqual(["10:00 AM", "10:30 AM", "11:00 AM"]);
    expect(startsOf(kidsFirst)).toEqual(["10:00 AM", "10:20 AM", "10:40 AM"]);
  });
});

describe("🔴 a hole that fits one service but not the party is excluded", () => {
  it("leaves out the gap that is too small for the whole run", async () => {
    // Book 11:00-11:30 and 12:00-12:30, leaving exactly 30 free minutes
    // between them. That fits ONE haircut and cannot fit a 50-minute party.
    const busy: Array<[number, number]> = [
      [11 * 60, 11 * 60 + 30],
      [12 * 60, 12 * 60 + 30],
    ];
    for (const [startMin, endMin] of busy) {
      await prisma.appointment.create({
        data: {
          shopId,
          staffId,
          serviceId: cutId,
          firstName: "Existing",
          status: "BOOKED",
          startsAt: at(startMin),
          endsAt: at(endMin),
          manageToken: randomToken(),
        },
      });
    }

    const single = await request(app)
      .get(`/api/book/${slug}/slots`)
      .query({ staffId, serviceId: cutId });
    const singleStarts = single.body.slots.map((s: { startsAt: string }) => s.startsAt);
    // The ordinary picker DOES offer 11:30 - one haircut fits there.
    expect(singleStarts).toContain(at(11 * 60 + 30).toISOString());

    const party = await slots([cutId, kidsId]);
    const partyStarts = party.body.slots.map((s: { startsAt: string }) => s.startsAt);
    // 🔴 The party picker does NOT. This is the whole point of the endpoint.
    expect(partyStarts).not.toContain(at(11 * 60 + 30).toISOString());
  });

  it("🔴 every candidate it returns is accepted by /plan", async () => {
    // The guarantee that matters. A grid that offers a time the writer refuses
    // is worse than no grid, because the customer only finds out at confirm.
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId: cutId,
        firstName: "Existing",
        status: "BOOKED",
        startsAt: at(13 * 60),
        endsAt: at(13 * 60 + 30),
        manageToken: randomToken(),
      },
    });
    const res = await slots([cutId, kidsId]);
    const candidates = res.body.slots.slice(0, 8) as { startsAt: string }[];
    expect(candidates.length).toBeGreaterThan(0);

    for (const c of candidates) {
      const plan = await request(app)
        .post(`/api/book/${slug}/group/plan`)
        .send({
          staffId,
          startsAt: c.startsAt,
          attendees: [
            { firstName: "Eric", serviceId: cutId },
            { firstName: "Brother", serviceId: kidsId },
          ],
        });
      expect({ at: hhmm(c.startsAt), status: plan.status }).toEqual({
        at: hhmm(c.startsAt),
        status: 200,
      });
    }
  });

  it("an adjacent booking stays valid - the run may start the moment one ends", async () => {
    // Half-open: an appointment ending at 11:00 does not block an 11:00 start.
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId: cutId,
        firstName: "Existing",
        status: "BOOKED",
        startsAt: at(10 * 60),
        endsAt: at(11 * 60),
        manageToken: randomToken(),
      },
    });
    const res = await slots([cutId, kidsId]);
    const starts = res.body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(starts).toContain(at(11 * 60).toISOString());
  });
});

describe("what it refuses", () => {
  it.each([
    ["one service (that is an ordinary booking)", () => [cutId]],
    ["four services", () => [cutId, kidsId, cutId, kidsId]],
  ])("refuses %s", async (_label, ids) => {
    const res = await slots(ids());
    expect(res.status).toBe(400);
  });

  it("🔴 refuses a service from ANOTHER shop", async () => {
    const res = await slots([cutId, otherServiceId]);
    expect(res.status).toBe(400);
    expect(res.body.slots).toBeUndefined();
  });

  it("🔴 refuses a staff id from another shop", async () => {
    const res = await request(app)
      .get(`/api/book/${slug}/group/slots`)
      .query({ staffId: otherStaffId, serviceIds: [cutId, kidsId].join(",") });
    expect(res.status).toBe(400);
  });

  it("refuses an inactive service", async () => {
    const res = await slots([cutId, inactiveId]);
    expect(res.status).toBe(400);
  });

  it("refuses a service this barber does not offer", async () => {
    const unoffered = await makeService(shopId, null, "Nobody does this", 30);
    const res = await slots([cutId, unoffered]);
    expect(res.status).toBe(400);
  });

  it("refuses a missing service id", async () => {
    const res = await slots([cutId, "svc_does_not_exist"]);
    expect(res.status).toBe(400);
  });

  it("refuses an excessive date range", async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 400 * 24 * 60 * 60 * 1000);
    const res = await slots([cutId, kidsId], {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RANGE_TOO_WIDE");
  });

  it("refuses an inverted range", async () => {
    const now = new Date();
    const res = await slots([cutId, kidsId], {
      from: new Date(now.getTime() + 86_400_000).toISOString(),
      to: now.toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("404s an unknown shop", async () => {
    const res = await request(app)
      .get(`/api/book/no-such-shop-${randomToken(4)}/group/slots`)
      .query({ staffId, serviceIds: [cutId, kidsId].join(",") });
    expect(res.status).toBe(404);
  });
});

describe("🔴 it is a READ - no writes, no Acuity", () => {
  it("creates nothing and contacts nobody", async () => {
    const before = {
      appts: await prisma.appointment.count({ where: { shopId } }),
      groups: await prisma.appointmentGroup.count({ where: { shopId } }),
      blocks: await prisma.acuityOutboundBlock.count({ where: { shopId } }),
    };
    const res = await slots([cutId, kidsId, longId]);
    expect(res.status).toBe(200);
    expect({
      appts: await prisma.appointment.count({ where: { shopId } }),
      groups: await prisma.appointmentGroup.count({ where: { shopId } }),
      blocks: await prisma.acuityOutboundBlock.count({ where: { shopId } }),
    }).toEqual(before);
  });

  it("returns only display-safe fields", async () => {
    const res = await slots([cutId, kidsId]);
    expect(Object.keys(res.body).sort()).toEqual(["slots", "timezone", "totalDurationMin"]);
    for (const s of res.body.slots.slice(0, 3)) {
      expect(Object.keys(s).sort()).toEqual(["endsAt", "startsAt"]);
    }
  });
});

describe("a shop that takes money at booking", () => {
  it("🔴 is refused here exactly as /plan refuses it", async () => {
    // Offering times a shop cannot actually sell is a picker leading to a dead
    // end. Same code the plan and create endpoints return.
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        paymentsMode: "deposit",
        depositAmountCents: 2000,
        connectChargesEnabled: true,
        stripeConnectAccountId: `acct_${randomToken(6)}`,
      },
    });
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_x");
    try {
      const res = await slots([cutId, kidsId]);
      // Either the shop genuinely collects (409) or this environment has
      // billing off, in which case the party is bookable and 200 is correct.
      // Both are honest; what must never happen is offering times AND then
      // refusing the plan.
      const plan = await request(app)
        .post(`/api/book/${slug}/group/plan`)
        .send({
          staffId,
          startsAt: at(10 * 60).toISOString(),
          attendees: [
            { firstName: "A", serviceId: cutId },
            { firstName: "B", serviceId: kidsId },
          ],
        });
      expect(res.status === 409).toBe(plan.status === 409);
    } finally {
      vi.unstubAllEnvs();
      await prisma.shop.update({
        where: { id: shopId },
        data: {
          paymentsMode: "off",
          depositAmountCents: null,
          connectChargesEnabled: false,
          stripeConnectAccountId: null,
        },
      });
    }
  });
});
