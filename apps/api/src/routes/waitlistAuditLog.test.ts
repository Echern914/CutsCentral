import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import {
  claimOffer,
  expireDueOffers,
  HOLD_MS,
  offerFreedSlot,
  type FreedSlot,
} from "../engines/waitlistOffer.js";
import { lockStaffAndAssertSlotFree } from "../engines/bookingWrite.js";
import { mintCancelToken } from "../engines/waitlistJoin.js";

/**
 * Waitlist phase F1: the append-only trail.
 *
 * This ships BEFORE the automatic expiry worker on purpose. F2 is the first
 * thing in this product that changes a customer's standing with no human
 * deciding to, and a bad sweep has to be reversible EXACTLY - "which rows did
 * the worker touch, between which times". Without this table the only handle
 * is status + updatedAt, which also catches every expiry a barber set by hand.
 *
 * So what is pinned here is not "a row got written" but the four properties
 * that make the trail worth trusting:
 *
 *   1. every lifecycle path leaves a record, with an HONEST actor
 *   2. the record commits with the change, or neither happens
 *   3. history cannot be rewritten - by anyone, including the owner
 *   4. no customer's name, number, address or schedule is ever in it
 */

const app = createApp();
const TZ = "America/New_York";
const password = "supersecret123";

let cookie: string;
let shopId: string;
let userId: string;
let slug: string;
let staffId: string;
let serviceId: string;

let otherCookie: string;
let otherShopId: string;

/** Seeded contact details - nothing resembling these may reach an audit row. */
const CUSTOMER = {
  firstName: "Marcus",
  lastName: "Reed",
  phone: "+12025550171",
  email: "marcus.reed@test.local",
};

let slotSeq = 0;
function freshSlot(over: Partial<FreedSlot> = {}): FreedSlot {
  const base = Math.ceil((Date.now() + 72 * 3600_000) / 1800_000) * 1800_000;
  const startsAt = new Date(base + slotSeq++ * 2 * 3600_000);
  return {
    shopId,
    staffId,
    serviceId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    timezone: TZ,
    bufferMin: 0,
    ...over,
  };
}

async function signUpShop(name: string) {
  const email = `wl-f1-${randomToken(6).toLowerCase()}@test.local`;
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(signup.status).toBe(201);
  const login = await request(app).post("/api/auth/login").send({ email, password });
  const setCookie = login.headers["set-cookie"];
  const jar = Array.isArray(setCookie) ? setCookie[0]!.split(";")[0]! : "";
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", jar)
    .send({ name, industry: "barber", smsAttested: true, timezone: TZ });
  expect(shop.status).toBe(201);
  return { cookie: jar, shopId: shop.body.id as string, userId: signup.body.id as string };
}

const events = (entryId: string) =>
  prisma.waitlistEvent.findMany({ where: { entryId }, orderBy: { createdAt: "asc" } });
const typesOf = async (entryId: string) => (await events(entryId)).map((e) => e.type);

async function makeEntry(over: Record<string, unknown> = {}) {
  return prisma.waitlistEntry.create({
    data: { shopId, firstName: "Wait", email: `wl-f1-${randomToken(5)}@test.local`, ...over },
    select: { id: true },
  });
}

beforeAll(async () => {
  const a = await signUpShop("F1 Cuts");
  cookie = a.cookie;
  shopId = a.shopId;
  userId = a.userId;
  const b = await signUpShop("F1 Other");
  otherCookie = b.cookie;
  otherShopId = b.shopId;

  const shop = await prisma.shop.update({
    where: { id: shopId },
    data: {
      bookingMode: "native",
      waitlistEnabled: true,
      slotOpenedTextsEnabled: true,
      bookingBufferMin: 0,
      bookingLeadHours: 0,
    },
    select: { slug: true },
  });
  slug = shop.slug!;

  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  staffId = staff.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  serviceId = svc.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  await prisma.availabilityRule.createMany({
    data: Array.from({ length: 7 }, (_, weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 0,
      endMin: 1440,
    })),
  });
});

afterEach(async () => {
  // Leftover WAITING entries would be "earliest eligible" for every later
  // slot, and a live hold would be swept by any later worker tick.
  await prisma.waitlistOffer.updateMany({
    where: { shopId, status: "OFFERED" },
    data: { status: "RELEASED" },
  });
  await prisma.waitlistEntry.updateMany({
    where: { shopId, status: { in: ["WAITING", "CONTACTED"] } },
    data: { status: "REMOVED" },
  });
});

// ───────────────────────────────────────── customer-driven paths

describe("what the customer does", () => {
  it("a public join is recorded against the customer, not a staff member", async () => {
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ ...CUSTOMER, windows: [{ startDate: null, endDate: null }] });
    expect(res.status).toBe(201);

    const entry = await prisma.waitlistEntry.findFirst({
      where: { shopId, email: CUSTOMER.email },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const [ev] = await events(entry!.id);
    expect(ev!.type).toBe("entry.joined");
    expect(ev!.actorType).toBe("customer");
    // A bearer-token customer has no user id, by design.
    expect(ev!.actorUserId).toBeNull();
    expect(ev!.actorStaffId).toBeNull();
    expect(ev!.metadata).toMatchObject({
      source: "public",
      windowCount: 1,
      anyDateMaterialized: true,
      smsConsent: false,
    });
  });

  it("🔑 a duplicate join is recorded against the entry it collided with", async () => {
    const body = {
      firstName: "Dup",
      email: `dup-${randomToken(5)}@test.local`,
      windows: [{ startDate: null, endDate: null }],
    };
    await request(app).post(`/api/page/${slug}/waitlist`).send(body).expect(201);
    // Byte-identical response - the audit row is the ONLY way to tell.
    await request(app).post(`/api/page/${slug}/waitlist`).send(body).expect(201);

    const entry = await prisma.waitlistEntry.findFirst({
      where: { shopId, email: body.email },
      select: { id: true },
    });
    expect(await typesOf(entry!.id)).toEqual(["entry.joined", "entry.join_deduped"]);
  });

  it("🔴 a self-cancel is attributed even though updateMany never learns the shop", async () => {
    // The token travels by email, never in the join response (that would make
    // the endpoint an oracle), so the entry is seeded with a known hash.
    const { token, hash } = mintCancelToken();
    const entry = await makeEntry({ status: "CONTACTED", cancelTokenHash: hash });

    await request(app).post(`/api/page/waitlist/cancel/${token}`).expect(200);

    expect(
      (await prisma.waitlistEntry.findUnique({ where: { id: entry.id } }))!.status,
    ).toBe("REMOVED");
    const ev = (await events(entry.id)).at(-1)!;
    expect(ev.type).toBe("entry.cancelled_by_customer");
    expect(ev.actorType).toBe("customer");
    expect(ev.shopId).toBe(shopId); // the whole point: it found the tenant
    expect(ev.metadata).toMatchObject({ fromStatus: "CONTACTED", toStatus: "REMOVED" });
  });

  it("an unknown cancel token writes nothing at all", async () => {
    const before = await prisma.waitlistEvent.count({ where: { shopId } });
    await request(app).post(`/api/page/waitlist/cancel/${randomToken(32)}`).expect(200);
    expect(await prisma.waitlistEvent.count({ where: { shopId } })).toBe(before);
  });
});

// ───────────────────────────────────────── staff-driven paths

describe("what the barber does", () => {
  it("a staff-created entry names the staff member and records that no consent was taken", async () => {
    const res = await request(app)
      .post("/api/dashboard/waitlist")
      .set("Cookie", cookie)
      .send({ firstName: "Walkin", phone: "+12025550188", windows: [{ startDate: null, endDate: null }] });
    expect(res.status).toBe(201);

    const [ev] = await events(res.body.id);
    expect(ev!.type).toBe("entry.created_by_staff");
    expect(ev!.actorType).toBe("staff");
    expect(ev!.actorUserId).toBe(userId);
    expect(ev!.metadata).toMatchObject({ source: "dashboard", consentRecorded: false });
  });

  it("a status change records what it replaced, not just what it set", async () => {
    const entry = await makeEntry({ status: "WAITING" });
    await request(app)
      .post(`/api/dashboard/waitlist/${entry.id}`)
      .set("Cookie", cookie)
      .send({ status: "CONTACTED" })
      .expect(200);

    const ev = (await events(entry.id)).at(-1)!;
    expect(ev.type).toBe("entry.status_changed");
    expect(ev.metadata).toMatchObject({ fromStatus: "WAITING", toStatus: "CONTACTED" });
  });

  it("🔴 'booked externally' is its own event - never mistakable for a linked booking", async () => {
    const entry = await makeEntry({ status: "WAITING" });
    await request(app)
      .post(`/api/dashboard/waitlist/${entry.id}`)
      .set("Cookie", cookie)
      .send({ status: "BOOKED" })
      .expect(200);

    const ev = (await events(entry.id)).at(-1)!;
    expect(ev.type).toBe("entry.booked_externally");
    expect(ev.appointmentId).toBeNull();
    expect(ev.metadata).toMatchObject({ linked: false });
  });

  it("a 404 on another shop's entry writes nothing", async () => {
    const entry = await makeEntry({ status: "WAITING" });
    await request(app)
      .post(`/api/dashboard/waitlist/${entry.id}`)
      .set("Cookie", otherCookie)
      .send({ status: "REMOVED" })
      .expect(404);
    expect(await typesOf(entry.id)).toEqual([]);
  });

  it("booking from the list links the appointment INSIDE the same record", async () => {
    const entry = await makeEntry({ status: "WAITING", serviceId, staffId });
    const startsAt = freshSlot().startsAt;
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        serviceId,
        staffId,
        startsAt: startsAt.toISOString(),
        firstName: "Linked",
        waitlistEntryId: entry.id,
      });
    expect(res.status).toBe(201);

    const ev = (await events(entry.id)).at(-1)!;
    expect(ev.type).toBe("entry.booked_linked");
    expect(ev.appointmentId).toBe(res.body.id);
    expect(ev.actorType).toBe("staff");
    expect(ev.metadata).toMatchObject({ linked: true });
  });

  it("🔑 a link that matched nothing is recorded as skipped - the appointment still stands", async () => {
    const entry = await makeEntry({ status: "REMOVED" }); // not active: cannot link
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        serviceId,
        staffId,
        startsAt: freshSlot().startsAt.toISOString(),
        firstName: "Skipped",
        waitlistEntryId: entry.id,
      });
    expect(res.status).toBe(201);

    const ev = (await events(entry.id)).at(-1)!;
    expect(ev.type).toBe("entry.link_skipped");
    expect(ev.metadata).toMatchObject({ code: "not_active_for_shop", linked: false });
  });
});

// ───────────────────────────────────────── the offer lifecycle

describe("the offer lifecycle", () => {
  it("mint -> claim leaves the whole chain against one entry", async () => {
    const entry = await makeEntry({ serviceId, staffId });
    const slot = freshSlot();
    const offered = await offerFreedSlot(slot, new Date());
    expect(offered.outcome).toBe("offered");
    if (offered.outcome !== "offered") throw new Error("unreachable");

    const claimed = await claimOffer({ token: offered.token, now: new Date() });
    expect(claimed.outcome).toBe("claimed");

    const rows = await events(entry.id);
    expect(rows.map((r) => r.type)).toEqual(["offer.created", "offer.claimed"]);
    expect(rows[0]!.actorType).toBe("system"); // nobody asked for this
    expect(rows[0]!.offerId).toBe(offered.offerId);
    expect(rows[1]!.actorType).toBe("customer"); // they redeemed a token
    expect(rows[1]!.metadata).toMatchObject({ pending: false, linked: true });
  });

  it("a lapsed hold records WHERE it died - sweep, not claim", async () => {
    const entry = await makeEntry({ serviceId, staffId });
    const slot = freshSlot();
    const now = new Date();
    const offered = await offerFreedSlot(slot, now);
    expect(offered.outcome).toBe("offered");

    await expireDueOffers(new Date(now.getTime() + HOLD_MS + 1000), { forceAdvance: false });

    const ev = (await events(entry.id)).at(-1)!;
    expect(ev.type).toBe("offer.expired");
    expect(ev.actorType).toBe("system");
    expect(ev.metadata).toMatchObject({ at: "sweep" });
  });

  it("a claim after the hold lapsed is recorded as expired AT THE CLAIM", async () => {
    const entry = await makeEntry({ serviceId, staffId });
    const now = new Date();
    const offered = await offerFreedSlot(freshSlot(), now);
    if (offered.outcome !== "offered") throw new Error("unreachable");

    const late = await claimOffer({ token: offered.token, now: new Date(now.getTime() + HOLD_MS + 1) });
    expect(late.outcome).toBe("expired");

    const ev = (await events(entry.id)).at(-1)!;
    expect(ev.type).toBe("offer.expired");
    expect(ev.metadata).toMatchObject({ at: "claim" });
    expect(ev.actorType).toBe("customer");
  });

  it("🔴 a hold the barber books over is released as `system` with a via - no invented staff actor", async () => {
    const entry = await makeEntry({ serviceId, staffId });
    const slot = freshSlot();
    const offered = await offerFreedSlot(slot, new Date());
    if (offered.outcome !== "offered") throw new Error("unreachable");

    // bookingWrite is a shared engine with no request context: whoever it is
    // acting for, it cannot know, so it must not claim to.
    await prisma.$transaction((tx) =>
      lockStaffAndAssertSlotFree(tx, {
        walkInCapacity: "enforce",
        staffId,
        shopId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: 0,
        serviceDayLimit: { serviceId, timezone: TZ },
        overrideWaitlistHolds: true,
        now: new Date(),
      }),
    );

    const ev = (await events(entry.id)).at(-1)!;
    expect(ev.type).toBe("offer.released");
    expect(ev.actorType).toBe("system");
    expect(ev.actorUserId).toBeNull();
    expect(ev.metadata).toMatchObject({ code: "override", via: "booking_write" });
  });
});

// ───────────────────────────────────────── the guarantees

describe("append-only", () => {
  it("🔴 UPDATE raises - for the connection the app actually uses", async () => {
    const entry = await makeEntry();
    const row = await prisma.waitlistEvent.create({
      data: { shopId, entryId: entry.id, type: "entry.status_changed", actorType: "system" },
      select: { id: true },
    });
    // Plain prisma = the connection owner, which here is a superuser with
    // BYPASSRLS. A grant on chairback_app would not stop this; the trigger does.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "WaitlistEvent" SET "type" = 'entry.joined' WHERE id = '${row.id}'`,
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it("the vocabulary is pinned by the database, not by TypeScript", async () => {
    const entry = await makeEntry();
    await expect(
      prisma.waitlistEvent.create({
        data: { shopId, entryId: entry.id, type: "entry.deleted", actorType: "system" },
      }),
    ).rejects.toThrow(/type_check/);
  });

  it("🔑 a `staff` event with nobody attached is refused - attributed or not at all", async () => {
    const entry = await makeEntry();
    await expect(
      prisma.waitlistEvent.create({
        data: { shopId, entryId: entry.id, type: "entry.status_changed", actorType: "staff" },
      }),
    ).rejects.toThrow(/staff_actor_identified/);
  });

  it("history survives its entry being deleted, and dies with its shop", async () => {
    const scratch = await signUpShop("F1 Teardown");
    const entry = await prisma.waitlistEntry.create({
      data: { shopId: scratch.shopId, firstName: "Temp" },
      select: { id: true },
    });
    await prisma.waitlistEvent.create({
      data: {
        shopId: scratch.shopId,
        entryId: entry.id,
        type: "entry.joined",
        actorType: "customer",
      },
    });

    // entryId carries no FK on purpose: the demo shop's nightly teardown
    // deleteMany's entries, and history must outlive that.
    await prisma.waitlistEntry.delete({ where: { id: entry.id } });
    expect(await prisma.waitlistEvent.count({ where: { entryId: entry.id } })).toBe(1);

    // 🔴 Shop deletion must still cascade - a row-level DELETE trigger would
    // have made teardown (and any data-deletion request) raise instead.
    await prisma.shop.delete({ where: { id: scratch.shopId } });
    expect(await prisma.waitlistEvent.count({ where: { entryId: entry.id } })).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("🔴 one shop cannot read another's history through the scoped accessor", async () => {
    const entry = await makeEntry();
    await prisma.waitlistEvent.create({
      data: { shopId, entryId: entry.id, type: "entry.joined", actorType: "customer" },
    });

    expect(await forShop(shopId).waitlistEvent.count({ where: { entryId: entry.id } })).toBe(1);
    // Same id, other tenant: nothing.
    expect(await forShop(otherShopId).waitlistEvent.count({ where: { entryId: entry.id } })).toBe(0);
    expect(await forShop(otherShopId).waitlistEvent.findMany({ where: { entryId: entry.id } }))
      .toHaveLength(0);
  });

  it("the scoped accessor cannot express a rewrite at all", () => {
    const scope = forShop(shopId).waitlistEvent as Record<string, unknown>;
    expect(scope.update).toBeUndefined();
    expect(scope.updateMany).toBeUndefined();
    expect(scope.delete).toBeUndefined();
    expect(scope.deleteMany).toBeUndefined();
  });
});

describe("nothing personal ever lands in it", () => {
  it("🔴 no seeded name, number, address or preference appears in ANY row", async () => {
    // Drive the paths that see the most customer data, then read the WHOLE
    // table back and look for any of it.
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({
        ...CUSTOMER,
        note: "prefers the chair by the window",
        smsConsent: true,
        windows: [{ startDate: null, endDate: null, startMin: 540, endMin: 720 }],
      });
    expect(res.status).toBe(201);

    const all = await prisma.waitlistEvent.findMany({ where: { shopId } });
    expect(all.length).toBeGreaterThan(0);
    const dump = JSON.stringify(all.map((r) => r.metadata));

    for (const needle of [
      CUSTOMER.firstName,
      CUSTOMER.lastName,
      CUSTOMER.email,
      CUSTOMER.phone,
      "2025550171",
      "prefers the chair",
      "09:00",
      "540",
    ]) {
      expect(dump, `leaked: ${needle}`).not.toContain(needle);
    }
  });
});
