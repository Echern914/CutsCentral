import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { offerFreedSlot, type FreedSlot } from "../engines/waitlistOffer.js";

/**
 * A waitlist claim books an appointment, so it agrees to the shop's
 * "Before you book" exactly the way the booking page does.
 *
 * Before this, the claim link was the one way into a booking that never showed
 * the shop's policies: a client waiting on the list took an opening from the
 * email and was booked without reading a word of them.
 *
 *  - the reveal carries the same policy (and version) the booking page gets,
 *  - a claim with no agreement, or agreement to older words, books NOTHING
 *    and leaves the hold theirs, with the current policy attached,
 *  - an agreed claim books and freezes what was agreed onto the appointment.
 */

const app = createApp();

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let seq = 0;

const TZ = "America/New_York";
const TEXT = "Be on time. Late by 15 minutes and the visit is cancelled.";
const CHECKLIST = ["I will arrive on time", "No extra guests"];

function freshSlot(): FreedSlot {
  const base = Math.ceil((Date.now() + 72 * 3600_000) / 1800_000) * 1800_000;
  const startsAt = new Date(base + seq * 2 * 3600_000);
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

async function heldOffer() {
  seq += 1;
  const slot = freshSlot();
  await prisma.waitlistEntry.create({
    data: { shopId, firstName: `Pol${seq}`, email: `wl-pol-${seq}-${randomToken(4)}@test.local` },
  });
  const res = await offerFreedSlot(slot, new Date());
  expect(res.outcome).toBe("offered");
  if (res.outcome !== "offered") throw new Error("unreachable");
  return { slot, ...res };
}

async function setPolicy(text: string | null, checklist: string[]) {
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingPolicyText: text, bookingPolicyChecklist: checklist },
  });
}

async function bookedAt(startsAt: Date) {
  return prisma.appointment.findMany({
    where: { shopId, staffId, startsAt },
    select: { policyAcceptedAt: true, policySnapshot: true, bookedVia: true },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wl-pol-${randomToken(6)}@test.local`, name: "P" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Policy Cuts",
      slug: `wl-pol-${randomToken(5)}`.toLowerCase(),
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
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30 }, select: { id: true } })
  ).id;
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

beforeEach(async () => {
  await setPolicy(TEXT, CHECKLIST);
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

describe("the reveal carries the shop's policy", () => {
  it("the same words and version the claim must echo back", async () => {
    const o = await heldOffer();
    const res = await request(app).get(`/api/book/offer/${o.token}`);
    expect(res.status).toBe(200);
    expect(res.body.bookingPolicy).toEqual({
      text: TEXT,
      checklist: CHECKLIST,
      version: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it("a shop with no policy sends null: nothing to show, nothing to tick", async () => {
    await setPolicy(null, []);
    const o = await heldOffer();
    const res = await request(app).get(`/api/book/offer/${o.token}`);
    expect(res.status).toBe(200);
    expect(res.body.bookingPolicy).toBeNull();
  });
});

describe("POST /api/book/offer/:token/claim and the policy", () => {
  it("🔴 no agreement books nothing, and the hold stays theirs to claim once they tick", async () => {
    const o = await heldOffer();
    const refused = await request(app)
      .post(`/api/book/offer/${o.token}/claim`)
      .send({});
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("POLICY_NOT_ACCEPTED");
    expect(refused.body.policy.checklist).toEqual(CHECKLIST);
    expect(await bookedAt(o.slot.startsAt)).toEqual([]);
    const held = await prisma.waitlistOffer.findUnique({ where: { id: o.offerId } });
    expect(held!.status).toBe("OFFERED");

    // The same link, now with the version they ticked.
    const ok = await request(app)
      .post(`/api/book/offer/${o.token}/claim`)
      .send({ policyVersion: refused.body.policy.version });
    expect(ok.status).toBe(201);
  });

  it("🔴 agreement to OLDER words books nothing: 409 with the current policy, hold kept", async () => {
    const o = await heldOffer();
    const shown = await request(app).get(`/api/book/offer/${o.token}`);
    const oldVersion = shown.body.bookingPolicy.version as string;
    // The owner edits the policy while the client sits on the claim card.
    await setPolicy(TEXT, [...CHECKLIST, "Cash only"]);

    const res = await request(app)
      .post(`/api/book/offer/${o.token}/claim`)
      .send({ policyVersion: oldVersion });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("POLICY_CHANGED");
    expect(res.body.policy.checklist).toEqual([...CHECKLIST, "Cash only"]);
    expect(res.body.policy.version).not.toBe(oldVersion);
    expect(await bookedAt(o.slot.startsAt)).toEqual([]);
    const held = await prisma.waitlistOffer.findUnique({ where: { id: o.offerId } });
    expect(held!.status).toBe("OFFERED");
  });

  it("an agreed claim books and freezes the words onto the appointment", async () => {
    const o = await heldOffer();
    const shown = await request(app).get(`/api/book/offer/${o.token}`);
    const version = shown.body.bookingPolicy.version as string;

    const res = await request(app)
      .post(`/api/book/offer/${o.token}/claim`)
      .send({ policyVersion: version });
    expect(res.status).toBe(201);

    const appt = (await bookedAt(o.slot.startsAt))[0]!;
    expect(appt.bookedVia).toBe("waitlist_offer");
    expect(appt.policyAcceptedAt).toBeInstanceOf(Date);
    // Ticked on this claim, so no agreedEarlierAt.
    expect(appt.policySnapshot).toEqual({ version, text: TEXT, checklist: CHECKLIST });
  });

  it("text with no checklist has nothing to tick: the claim books and records no agreement", async () => {
    await setPolicy(TEXT, []);
    const o = await heldOffer();
    const res = await request(app).post(`/api/book/offer/${o.token}/claim`).send({});
    expect(res.status).toBe(201);
    const appt = (await bookedAt(o.slot.startsAt))[0]!;
    expect(appt.policyAcceptedAt).toBeNull();
    expect(appt.policySnapshot).toBeNull();
  });

  it("junk for a version is refused before anything is touched", async () => {
    const o = await heldOffer();
    const res = await request(app)
      .post(`/api/book/offer/${o.token}/claim`)
      .send({ policyVersion: "x".repeat(65) });
    expect(res.status).toBe(400);
    const held = await prisma.waitlistOffer.findUnique({ where: { id: o.offerId } });
    expect(held!.status).toBe("OFFERED");
  });
});
