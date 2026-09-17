import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";

/**
 * THE WALK-IN WRITE HAD NO GUARD AT ALL.
 *
 * `walkInOccupancy.test.ts` already pins the READ half: a walk-in in the chair
 * is not offered for sale. This file pins the WRITE half, which was missing
 * entirely — `POST /appointments/walk-in` created a real Appointment occupying
 * [now, now + duration) with no advisory lock and no overlap check, and the
 * partial unique index only covers BOOKED|PENDING so a COMPLETED walk-in had no
 * database backstop either. It could be laid straight over a customer's booking.
 *
 * 🔴 THE DISTINCTION THESE TESTS PROTECT. Recording a service and reserving
 * time are different questions. A COMPLETED walk-in from this morning must NOT
 * block this afternoon — that would blockade the entire past — while a NEW
 * walk-in written across a live reservation must be refused. Both halves are
 * asserted, because a fix that made every COMPLETED row block would "pass" the
 * conflict tests and break the shop.
 *
 * See docs/booking-occupancy-matrix.md for the contract these encode.
 */
const app = createApp();
const password = "supersecret123";
const shopIds: string[] = [];

let cookie: string;
let shopId: string;
let staffId: string;
let otherStaffId: string;
let serviceId: string;
/** A second shop, for the isolation cases. */
let otherCookie: string;
let otherShopId: string;
let otherShopStaffId: string;

async function makeShop(label: string) {
  const email = `occp0-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: label, bookingUrl: "https://o.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopIds.push(shop.body.id as string);
  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", c)
        .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 })
    ).status,
  ).toBe(200);
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", c)
    .send({ name: "Chair" });
  expect(staff.status).toBe(201);
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", c)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staff.body.id] });
  expect(svc.status).toBe(201);
  return {
    cookie: c,
    shopId: shop.body.id as string,
    staffId: staff.body.id as string,
    serviceId: svc.body.id as string,
  };
}

/** A BOOKED appointment straddling "now" on the given chair. */
async function bookAcross(
  sid: string,
  stid: string,
  svid: string,
  opts: { status?: "BOOKED" | "PENDING" | "CANCELED" | "COMPLETED" | "NO_SHOW"; from?: number; to?: number } = {},
) {
  const now = Date.now();
  return prisma.appointment.create({
    data: {
      shopId: sid,
      staffId: stid,
      serviceId: svid,
      firstName: "Booked",
      status: opts.status ?? "BOOKED",
      startsAt: new Date(now + (opts.from ?? -5 * 60_000)),
      endsAt: new Date(now + (opts.to ?? 25 * 60_000)),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

const walkIn = (c: string, staff?: string) =>
  request(app)
    .post("/api/booking/appointments/walk-in")
    .set("Cookie", c)
    .send({ amount: 30, ...(staff ? { staffId: staff } : {}) });

beforeAll(async () => {
  const a = await makeShop("Occupancy P0");
  cookie = a.cookie;
  shopId = a.shopId;
  staffId = a.staffId;
  serviceId = a.serviceId;
  const second = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Second" });
  expect(second.status).toBe(201);
  otherStaffId = second.body.id;

  const b = await makeShop("Other Shop");
  otherCookie = b.cookie;
  otherShopId = b.shopId;
  otherShopStaffId = b.staffId;
});

beforeEach(async () => {
  // Each case starts from an empty book on the shop under test.
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  for (const id of shopIds) await prisma.shop.deleteMany({ where: { id } });
});

describe("a walk-in RECORDS, and its conflict is never silently lost", () => {
  it("2. records a walk-in over a confirmed appointment AND names the conflict", async () => {
    // 🔴 The receipt is kept - the cash is in the till and the hair is cut,
    // and refusing would roll a payment back to protect a calendar slot that is
    // occupied either way. What changed is that the collision is now REPORTED
    // rather than silently written.
    const booked = await bookAcross(shopId, staffId, serviceId);
    const res = await walkIn(cookie, staffId);
    expect(res.status).toBe(201);
    expect(res.body.conflict.withAppointmentIds).toContain(booked.id);
    expect(
      await prisma.appointment.count({ where: { shopId, firstName: "Walk-in" } }),
    ).toBe(1);
  });

  it("3. reports a conflict with a blocking Acuity visit, which is not an Appointment", async () => {
    // A synced visit carries no staffId, so it blocks the shop's chairs.
    const now = Date.now();
    const client = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `tel:+1555${randomToken(7)}`,
        magicToken: randomToken(),
        firstName: "Synced",
      },
      select: { id: true },
    });
    await prisma.visit.create({
      data: {
        shopId,
        clientId: client.id,
        acuityAppointmentId: `acu-${randomToken(6)}`,
        status: "SCHEDULED",
        scheduledAt: new Date(now - 5 * 60_000),
        endAt: new Date(now + 25 * 60_000),
      },
    });
    const res = await walkIn(cookie, staffId);
    expect(res.status).toBe(201);
    // A synced visit is not an Appointment, so the id list is empty - but the
    // conflict is still reported. That distinction is the point of the shape.
    expect(res.body.conflict).toBeDefined();
    expect(res.body.conflict.withAppointmentIds).toEqual([]);
  });

  it("6. back-to-back walk-ins BOTH record, exactly as both live shops do", async () => {
    // Drick logged two seven seconds apart; Mikey two fifteen. Refusing the
    // second would lose a payment. walkInOccupancy.test.ts pins this too.
    expect((await walkIn(cookie, staffId)).status).toBe(201);
    expect((await walkIn(cookie, staffId)).status).toBe(201);
    expect(
      await prisma.appointment.count({ where: { shopId, firstName: "Walk-in" } }),
    ).toBe(2);
  });
});

describe("concurrency — the real transactional boundary", () => {
  it("4. TWO SIMULTANEOUS WALK-INS on one chair: exactly one wins", async () => {
    // 🔴 Promise.all is not a race. The barrier takes the SAME advisory key the
    // guard takes (`appt:<staffId>`), so both racers are genuinely stuck behind
    // it; settledEarly === 0 is the assertion a missing lock fails.
    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `appt:${staffId}`,
      [() => walkIn(cookie, staffId), () => walkIn(cookie, staffId)],
    );
    expect(settledEarly).toBe(0);
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<request.Response> =>
        r.status === "fulfilled" && r.value.status === 201,
    );
    // BOTH receipts are kept. What the lock guarantees is that they were
    // SERIALISED - so the second one saw the first and reported the collision,
    // rather than the two interleaving and both believing the chair was free.
    expect(ok).toHaveLength(2);
    expect(
      await prisma.appointment.count({ where: { shopId, firstName: "Walk-in" } }),
    ).toBe(2);
    expect(ok.some((r) => r.value.body.conflict)).toBe(true);
  });

  it("5. a WALK-IN and a NATIVE booking racing for the same chair: one wins", async () => {
    const now = Date.now();
    const nativeCreate = () =>
      request(app)
        .post("/api/booking/appointments")
        .set("Cookie", cookie)
        .send({
          staffId,
          serviceId,
          firstName: "Racer",
          startsAt: new Date(now + 2 * 60_000).toISOString(),
          // The barber forcing a time: skips the availability grid, keeps the
          // overlap guard. Without it this racer 400s on validation before it
          // ever reaches the lock, and the race proves nothing (settledEarly).
          customTime: true,
        });
    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `appt:${staffId}`,
      [() => walkIn(cookie, staffId), nativeCreate],
    );
    expect(settledEarly).toBe(0);
    // The NATIVE booking is a reservation REQUEST, so it is refused when it
    // collides; the walk-in is a receipt, so it records. That asymmetry is the
    // rule, and here it is with both halves running against one lock.
    const byStatus = results
      .filter((r): r is PromiseFulfilledResult<request.Response> => r.status === "fulfilled")
      .map((r) => r.value.status);
    expect(byStatus).toContain(201);
    expect(
      await prisma.appointment.count({ where: { shopId, firstName: "Walk-in" } }),
    ).toBe(1);
  });
});

describe("what does NOT block — the other half of the contract", () => {
  it("11. a CANCELLED appointment does not block a walk-in", async () => {
    await bookAcross(shopId, staffId, serviceId, { status: "CANCELED" });
    const res = await walkIn(cookie, staffId);
    expect(res.status).toBe(201);
    expect(res.body.conflict).toBeUndefined();
  });

  it("11b. a NO_SHOW does not block a walk-in", async () => {
    await bookAcross(shopId, staffId, serviceId, { status: "NO_SHOW" });
    const res = await walkIn(cookie, staffId);
    expect(res.status).toBe(201);
    expect(res.body.conflict).toBeUndefined();
  });

  it("12. 🔴 a HISTORICAL completed appointment does not block — the past is not a blockade", async () => {
    // A COMPLETED row whose span has elapsed. If the fix had simply made every
    // COMPLETED record block, this shop could never take another walk-in.
    await bookAcross(shopId, staffId, serviceId, {
      status: "COMPLETED",
      from: -120 * 60_000,
      to: -90 * 60_000,
    });
    const res = await walkIn(cookie, staffId);
    expect(res.status).toBe(201);
    // 🔴 and NOT flagged - the past is not a conflict.
    expect(res.body.conflict).toBeUndefined();
  });

  it("12b. an IN-PROGRESS completed appointment IS reported as a conflict", async () => {
    // Same status, span not yet elapsed: someone is in the chair. The receipt
    // still records; what differs from 12 is that this one is flagged.
    const inProgress = await bookAcross(shopId, staffId, serviceId, { status: "COMPLETED" });
    const res = await walkIn(cookie, staffId);
    expect(res.status).toBe(201);
    expect(res.body.conflict.withAppointmentIds).toContain(inProgress.id);
  });

  it("10. ADJACENT spans that merely touch are allowed", async () => {
    // Ends exactly when the walk-in begins. Half-open: no conflict. A closed
    // rule would refuse this, and production has 7 such live pairs.
    const now = Date.now();
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Before",
        status: "BOOKED",
        startsAt: new Date(now - 30 * 60_000),
        endsAt: new Date(now),
        manageToken: randomToken(),
      },
    });
    expect((await walkIn(cookie, staffId)).status).toBe(201);
  });
});

describe("14. isolation", () => {
  it("another CHAIR in the same shop is unaffected", async () => {
    await bookAcross(shopId, staffId, serviceId);
    expect((await walkIn(cookie, otherStaffId)).status).toBe(201);
  });

  it("another SHOP is unaffected", async () => {
    await bookAcross(shopId, staffId, serviceId);
    expect((await walkIn(otherCookie, otherShopStaffId)).status).toBe(201);
    await prisma.appointment.deleteMany({ where: { shopId: otherShopId } });
  });
});
