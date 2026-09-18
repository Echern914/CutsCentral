import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "./app.js";
import { ingestAppointment } from "./ingest.js";
import type { AcuityAppointment } from "./acuity/types.js";

/**
 * THE VERY NEXT AVAILABILITY READ MUST NOT BE STALE.
 *
 * Availability is cached per shop behind a generation counter, and the whole
 * point of a mixed-mode shop is that someone else's calendar can take the chair
 * at any moment. If an Acuity booking commits and the next `/day` still offers
 * that slot, ChairBack sells a chair that is already gone — and the customer
 * finds out when they arrive.
 *
 * 🔴 THIS DRIVES THE REAL INGEST AND THE REAL CACHE. `ingestAppointment` is
 * called with a prefetched payload (the same door the webhook and the resync
 * walk both use), and the assertions read `/api/book/:slug/day` over HTTP — the
 * actual cached endpoint, not a spy proving some function was called. A mocked
 * "invalidate was invoked" assertion would pass even if the cache ignored it.
 */
const app = createApp();
const password = "supersecret123";

let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
/** A second shop, to prove invalidation is not a fleet-wide flush. */
let otherShopId: string;
let otherSlug: string;

/** The day these tests aim at: far enough out to be wide open. */
function targetDay(): string {
  const d = new Date(Date.now() + 3 * 24 * 60 * 60_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Slot times the public page is offering on the target day, read through the
 * CACHED endpoint - `/day` is the one behind the generation counter, which is
 * the thing under test. Shape: bundles[].services[].slots[] plus ungrouped[].
 */
async function offeredSlots(s = slug): Promise<string[]> {
  const res = await request(app).get(`/api/book/${s}/day?date=${targetDay()}`);
  expect(res.status).toBe(200);
  const out: string[] = [];
  const collect = (svc: { slots?: { startsAt: string }[] }) => {
    for (const slot of svc.slots ?? []) out.push(slot.startsAt);
  };
  for (const bundle of res.body.bundles ?? []) {
    for (const svc of bundle.services ?? []) collect(svc);
  }
  for (const svc of res.body.ungrouped ?? []) collect(svc);
  return out;
}

/** A synthetic Acuity payload; `prefetched` means no network call happens. */
function acuityAppt(id: string, startsAtIso: string, over: Partial<AcuityAppointment> = {}) {
  return {
    id,
    firstName: "Synced",
    lastName: "Client",
    phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
    datetime: startsAtIso,
    duration: 30,
    type: "Cut",
    ...over,
  } as unknown as AcuityAppointment;
}

async function makeShop(label: string) {
  const email = `acucache-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: label, bookingUrl: "https://a.test", smsAttested: true });
  expect(shop.status).toBe(201);
  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", c)
        .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 })
    ).status,
  ).toBe(200);
  const me = await request(app).get("/api/shops/me").set("Cookie", c);
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", c)
    .send({ name: "Chair" });
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", c)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staff.body.id] });
  await request(app)
    .put(`/api/booking/staff/${staff.body.id}/availability`)
    .set("Cookie", c)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 20 * 60,
      })),
    });
  return {
    cookie: c,
    shopId: me.body.id as string,
    slug: me.body.slug as string,
    staffId: staff.body.id as string,
    serviceId: svc.body.id as string,
  };
}

beforeAll(async () => {
  const a = await makeShop("Acuity Cache");
  cookie = a.cookie;
  shopId = a.shopId;
  slug = a.slug;
  staffId = a.staffId;
  serviceId = a.serviceId;
  const b = await makeShop("Untouched Shop");
  otherShopId = b.shopId;
  otherSlug = b.slug;
});

beforeEach(async () => {
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId: otherShopId } });
});

afterAll(async () => {
  for (const id of [shopId, otherShopId]) {
    await prisma.shop.deleteMany({ where: { id } });
  }
});

/** The shop row the ingest path expects. */
const shopRow = () => prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

describe("15. an Acuity booking is gone from availability on the NEXT read", () => {
  it("🔴 the slot it takes stops being offered immediately", async () => {
    const before = await offeredSlots();
    expect(before.length).toBeGreaterThan(0);
    const taken = before[2] ?? before[0]!;

    await ingestAppointment(
      await shopRow(),
      "appointment.scheduled",
      `acu-${randomToken(8)}`,
      acuityAppt("x", taken),
    );

    // No sleep, no second chance: the very next read.
    const after = await offeredSlots();
    expect(after).not.toContain(taken);
    // ...and the rest of the day is untouched - this is not a blanket wipe.
    expect(after.length).toBeGreaterThan(0);
  });

  it("does NOT flush an unrelated shop", async () => {
    const otherBefore = await offeredSlots(otherSlug);
    const taken = (await offeredSlots())[2]!;
    await ingestAppointment(
      await shopRow(),
      "appointment.scheduled",
      `acu-${randomToken(8)}`,
      acuityAppt("y", taken),
    );
    // The second shop's generation must not move, and its day is identical.
    expect(await offeredSlots(otherSlug)).toEqual(otherBefore);
  });

  it("a RESCHEDULE frees the old interval and takes the new one", async () => {
    const slots = await offeredSlots();
    const first = slots[2]!;
    const second = slots[5]!;
    const acuityId = `acu-${randomToken(8)}`;

    await ingestAppointment(await shopRow(), "appointment.scheduled", acuityId, acuityAppt("r", first));
    expect(await offeredSlots()).not.toContain(first);

    // The same Acuity row moves: one Visit, updated in place.
    await ingestAppointment(
      await shopRow(),
      "appointment.rescheduled",
      acuityId,
      acuityAppt("r", second),
    );
    const after = await offeredSlots();
    expect(after).toContain(first); // old interval released
    expect(after).not.toContain(second); // new interval taken
  });

  it("a CANCELLATION releases the interval", async () => {
    const slots = await offeredSlots();
    const taken = slots[2]!;
    const acuityId = `acu-${randomToken(8)}`;

    await ingestAppointment(await shopRow(), "appointment.scheduled", acuityId, acuityAppt("c", taken));
    expect(await offeredSlots()).not.toContain(taken);

    await ingestAppointment(
      await shopRow(),
      "appointment.canceled",
      acuityId,
      acuityAppt("c", taken, { canceled: true }),
    );
    expect(await offeredSlots()).toContain(taken);
  });

  it("🔴 a FAILED ingest publishes nothing — the day is unchanged", async () => {
    // A half-applied calendar is worse than a stale one, so the assertion is on
    // the OUTCOME rather than on whether it threw: nothing written, and the day
    // reading exactly as it did before.
    const before = await offeredSlots();
    await ingestAppointment(
      await shopRow(),
      "appointment.scheduled",
      `acu-${randomToken(8)}`,
      acuityAppt("bad", "not-a-date"),
    ).catch(() => undefined);
    expect(await prisma.visit.count({ where: { shopId } })).toBe(0);
    expect(await offeredSlots()).toEqual(before);
  });

  it("the generation only moves for the shop that changed", async () => {
    const [mineBefore, theirsBefore] = await Promise.all([
      prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { availabilityGeneration: true } }),
      prisma.shop.findUniqueOrThrow({ where: { id: otherShopId }, select: { availabilityGeneration: true } }),
    ]);
    await ingestAppointment(
      await shopRow(),
      "appointment.scheduled",
      `acu-${randomToken(8)}`,
      acuityAppt("g", (await offeredSlots())[2]!),
    );
    const [mineAfter, theirsAfter] = await Promise.all([
      prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { availabilityGeneration: true } }),
      prisma.shop.findUniqueOrThrow({ where: { id: otherShopId }, select: { availabilityGeneration: true } }),
    ]);
    expect(mineAfter.availabilityGeneration).toBeGreaterThan(mineBefore.availabilityGeneration);
    expect(theirsAfter.availabilityGeneration).toBe(theirsBefore.availabilityGeneration);
  });
});
