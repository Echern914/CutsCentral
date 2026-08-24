import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import {
  HOLD_MS,
  offerFreedSlot,
  type FreedSlot,
} from "../engines/waitlistOffer.js";
import { sha256Hex } from "../engines/waitlistJoin.js";

/**
 * Waitlist phase C, the PUBLIC surface: the tokenized claim link.
 *
 * The engine suite proves the lifecycle; this one proves the HTTP contract a
 * stranger's browser actually touches:
 *   - the link reveals the held slot ONLY while the token is live,
 *   - every dead link collapses into the same generic 404/410,
 *   - the held time is missing from the public day payload,
 *   - the claim books and the token dies with it.
 */

const app = createApp();

let userId: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
let entrySeq = 0;

const TZ = "America/New_York";

let slotSeq = 0;
function freshSlot(): FreedSlot {
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
  };
}

/** The slot's shop-local calendar date, for the /day query. */
function localDateOf(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

async function makeEntry() {
  entrySeq += 1;
  return prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: `Rt${entrySeq}`,
      email: `wl-rt-${entrySeq}-${randomToken(4)}@test.local`,
    },
    select: { id: true, email: true },
  });
}

async function heldOffer() {
  const slot = freshSlot();
  await makeEntry();
  const res = await offerFreedSlot(slot, new Date());
  expect(res.outcome).toBe("offered");
  if (res.outcome !== "offered") throw new Error("unreachable");
  return { slot, ...res };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wl-rt-${randomToken(6)}@test.local`, name: "R" },
    select: { id: true },
  });
  userId = user.id;
  slug = `wl-rt-${randomToken(5)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Claim Cuts",
      slug,
      webhookSecret: randomToken(),
      timezone: TZ,
      bookingMode: "native",
      publicPageEnabled: true,
      waitlistEnabled: true,
      slotOpenedTextsEnabled: true,
      bookingBufferMin: 0,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  staffId = staff.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30 },
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

afterAll(async () => {
  await prisma.waitlistOffer.deleteMany({ where: { shopId } });
  await prisma.waitlistEntry.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.availabilityRule.deleteMany({ where: { shopId } });
  await prisma.serviceStaff.deleteMany({ where: { shopId } });
  await prisma.service.deleteMany({ where: { shopId } });
  await prisma.staff.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("GET /api/book/offer/:token", () => {
  it("reveals the held slot to the link holder - and ONLY the safe fields", async () => {
    const o = await heldOffer();
    const res = await request(app).get(`/api/book/offer/${o.token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.startsAt).toBe(o.slot.startsAt.toISOString());
    expect(res.body.expiresAt).toBe(o.expiresAt.toISOString());
    expect(res.body.serviceName).toBe("Cut");
    expect(res.body.staffName).toBe("Sam");
    expect(res.body.shop).toEqual({ name: "Claim Cuts", slug, timezone: TZ });
    // Nothing that could open a wider door rides along.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(sha256Hex(o.token));
    expect(raw).not.toContain(o.entryId);
    expect(raw).not.toContain(shopId);
  });

  it("an unknown token is a generic 404", async () => {
    const res = await request(app).get(`/api/book/offer/${randomToken(32)}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("a lapsed hold answers with the SAME generic 404 as an unknown one", async () => {
    const o = await heldOffer();
    await prisma.waitlistOffer.update({
      where: { id: o.offerId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(app).get(`/api/book/offer/${o.token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});

describe("the held slot and the public day payload", () => {
  it("the day's slot list omits the held start; other times stay", async () => {
    const o = await heldOffer();
    const date = localDateOf(o.slot.startsAt);
    const res = await request(app).get(`/api/book/${slug}/day`).query({ date });
    expect(res.status).toBe(200);

    const services = [
      ...(res.body.ungrouped ?? []),
      ...((res.body.bundles ?? []) as { services: unknown[] }[]).flatMap(
        (b) => b.services,
      ),
    ] as { id: string; slots: { startsAt: string }[] }[];
    const cut = services.find((s) => s.id === serviceId);
    expect(cut).toBeTruthy();
    const starts = cut!.slots.map((s) => s.startsAt);
    expect(starts).not.toContain(o.slot.startsAt.toISOString());
    expect(starts.length).toBeGreaterThan(0); // the rest of the day survived
  });
});

describe("POST /api/book/offer/:token/claim", () => {
  it("books the held slot and returns the manage token", async () => {
    const o = await heldOffer();
    const res = await request(app)
      .post(`/api/book/offer/${o.token}/claim`)
      .send({ email: `claimer-${randomToken(4)}@test.local` });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.manageToken).toBe("string");
    expect(res.body.startsAt).toBe(o.slot.startsAt.toISOString());
    expect(res.body.shopSlug).toBe(slug);

    const appt = await prisma.appointment.findFirst({
      where: { shopId, staffId, startsAt: o.slot.startsAt },
      select: { status: true, bookedVia: true },
    });
    expect(appt).toEqual({ status: "BOOKED", bookedVia: "waitlist_offer" });
  });

  it("the token dies with the claim: a second POST is a generic 410", async () => {
    const o = await heldOffer();
    await request(app).post(`/api/book/offer/${o.token}/claim`).send({});
    const again = await request(app).post(`/api/book/offer/${o.token}/claim`).send({});
    expect(again.status).toBe(410);
    expect(again.body).toEqual({ error: "offer_expired" });
    const count = await prisma.appointment.count({
      where: { shopId, staffId, startsAt: o.slot.startsAt },
    });
    expect(count).toBe(1);
  });

  it("an expired token is 410; a bogus one is 404; neither says anything else", async () => {
    const o = await heldOffer();
    await prisma.waitlistOffer.update({
      where: { id: o.offerId },
      data: { expiresAt: new Date(Date.now() - HOLD_MS) },
    });
    const expired = await request(app).post(`/api/book/offer/${o.token}/claim`).send({});
    expect(expired.status).toBe(410);
    expect(expired.body).toEqual({ error: "offer_expired" });

    const bogus = await request(app)
      .post(`/api/book/offer/${randomToken(32)}/claim`)
      .send({});
    expect(bogus.status).toBe(404);
    expect(bogus.body).toEqual({ error: "not_found" });
  });

  it("rejects junk input before touching anything", async () => {
    const o = await heldOffer();
    const res = await request(app)
      .post(`/api/book/offer/${o.token}/claim`)
      .send({ email: "not-an-email", extra: "nope" });
    expect(res.status).toBe(400);
    const offer = await prisma.waitlistOffer.findUnique({ where: { id: o.offerId } });
    expect(offer!.status).toBe("OFFERED"); // untouched
  });
});
