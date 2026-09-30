import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE SHOP'S BOOKING CHECKLIST, END TO END.
 *
 * An owner writes their policies and a few lines a customer must tick ("I'll
 * arrive 5 minutes early"). The claims, each tested below:
 *  - a customer booking that did not tick the CURRENT checklist is refused,
 *    and refused before anything is written;
 *  - a booking against a checklist the owner has since changed is a 409 that
 *    carries the new one - never agreement recorded to unseen words;
 *  - an accepted booking freezes exactly what was agreed onto the appointment;
 *  - single, standing and group customer bookings are all gated;
 *  - a shop with no checklist, and the owner's own dashboard booking, are not.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

const CHECKLIST = ["I'll arrive 5 minutes early", "More than 15 minutes late counts as a no-show"];
const TEXT = "Deposits are non-refundable.\nPlease text if you are running late.";

/** A future instant (UTC) at the given hour, `daysAhead` days from now. */
function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  const email = `pol-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "P", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Policy Test Shop", bookingUrl: "https://p.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  shopIds.push(shopId);

  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 365 });
  expect(patch.status).toBe(200);
  slug = patch.body.slug as string;

  staffId = (
    await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })
  ).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Standard visit", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startMin: 9 * 60,
    endMin: 17 * 60,
  }));
  const avail = await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules });
  expect(avail.status).toBe(200);
});

afterAll(async () => {
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

beforeEach(async () => {
  if (!shopId) return;
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentGroup.deleteMany({ where: { shopId } });
  await prisma.recurringSeries.deleteMany({ where: { shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingPolicyText: null, bookingPolicyChecklist: [] },
  });
});

const savePolicy = (body: Record<string, unknown>) =>
  request(app).patch("/api/shops/me").set("Cookie", cookie).send(body);

async function withChecklist(checklist = CHECKLIST, text: string | null = TEXT) {
  const res = await savePolicy({ bookingPolicyText: text, bookingPolicyChecklist: checklist });
  expect(res.status).toBe(200);
}

/** What the booking page is handed. */
async function pagePolicy(): Promise<{
  text: string | null;
  checklist: string[];
  version: string;
} | null> {
  const res = await request(app).get(`/api/book/${slug}`);
  expect(res.status).toBe(200);
  return res.body.shop.bookingPolicy;
}

const customer = { firstName: "Casey", lastName: "Tester", email: "casey@example.com" };

const bookOne = (at: Date, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/book/${slug}`)
    .send({ staffId, serviceId, startsAt: at.toISOString(), ...customer, ...extra });

const bookGroup = (at: Date, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/book/${slug}/group`)
    .send({
      staffId,
      startsAt: at.toISOString(),
      attendees: [
        { firstName: "Casey", serviceId },
        { firstName: "Jordan", serviceId },
      ],
      ...customer,
      ...extra,
    });

describe("the owner's settings", () => {
  it("saves the policy and checklist, trimmed, with blank lines dropped", async () => {
    const res = await savePolicy({
      bookingPolicyText: "  Be on time.  ",
      bookingPolicyChecklist: ["  I'll arrive early ", "", "   "],
    });
    expect(res.status).toBe(200);
    expect(res.body.bookingPolicyText).toBe("Be on time.");
    expect(res.body.bookingPolicyChecklist).toEqual(["I'll arrive early"]);
    const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(me.body.bookingPolicyChecklist).toEqual(["I'll arrive early"]);
  });

  it("blank everything turns it OFF: the page is handed nothing", async () => {
    await withChecklist();
    await savePolicy({ bookingPolicyText: "   ", bookingPolicyChecklist: [] });
    expect(await pagePolicy()).toBeNull();
  });

  it("🔴 refuses too much rather than cutting a sentence in half", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`);
    expect((await savePolicy({ bookingPolicyChecklist: nine })).status).toBe(400);
    expect((await savePolicy({ bookingPolicyChecklist: ["x".repeat(161)] })).status).toBe(400);
    expect((await savePolicy({ bookingPolicyText: "x".repeat(2001) })).status).toBe(400);
    // The limits themselves are fine.
    const eight = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`);
    expect((await savePolicy({ bookingPolicyChecklist: eight })).status).toBe(200);
    expect((await savePolicy({ bookingPolicyText: "x".repeat(2000) })).status).toBe(200);
  });
});

describe("what the booking page is handed", () => {
  it("a shop that wrote nothing gets null - the page shows nothing", async () => {
    expect(await pagePolicy()).toBeNull();
  });

  it("carries the text, the lines in order, and a version", async () => {
    await withChecklist();
    const p = await pagePolicy();
    expect(p).toMatchObject({ text: TEXT, checklist: CHECKLIST });
    expect(p!.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("🔴 the version moves when the TEXT changes, not only the lines", async () => {
    await withChecklist();
    const before = (await pagePolicy())!.version;
    await savePolicy({ bookingPolicyText: `${TEXT} Cash only.` });
    expect((await pagePolicy())!.version).not.toBe(before);
  });
});

describe("a single booking", () => {
  it("🔴 is REFUSED without the checklist ticked, and nothing is written", async () => {
    await withChecklist();
    const res = await bookOne(futureAtHour(2, 10));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("POLICY_NOT_ACCEPTED");
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
    expect(await prisma.client.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 is REFUSED with a stale version - a 409 carrying the CURRENT policy", async () => {
    await withChecklist();
    const seen = (await pagePolicy())!.version;
    // The owner edits the checklist while the customer sits on the last step.
    await withChecklist([...CHECKLIST, "Cash only"]);
    const res = await bookOne(futureAtHour(2, 11), { policyVersion: seen });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("POLICY_CHANGED");
    expect(res.body.policy.checklist).toEqual([...CHECKLIST, "Cash only"]);
    expect(res.body.policy.version).not.toBe(seen);
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);

    // Ticking the new words goes through.
    const again = await bookOne(futureAtHour(2, 11), { policyVersion: res.body.policy.version });
    expect(again.status).toBe(201);
  });

  it("is ACCEPTED with the current version, and freezes what was agreed", async () => {
    await withChecklist();
    const p = (await pagePolicy())!;
    const before = Date.now();
    const res = await bookOne(futureAtHour(2, 12), { policyVersion: p.version });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { shopId },
      select: { id: true, policyAcceptedAt: true, policySnapshot: true },
    });
    expect(appt!.policyAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(appt!.policySnapshot).toEqual({ version: p.version, text: TEXT, checklist: CHECKLIST });

    // 🔴 Frozen: the owner rewriting the policy does not rewrite the record.
    await withChecklist(["Something else entirely"], "New text");
    const detail = await request(app)
      .get(`/api/booking/appointments/${appt!.id}/detail`)
      .set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.policyAgreement).toMatchObject({ text: TEXT, checklist: CHECKLIST });
    expect(typeof detail.body.policyAgreement.acceptedAt).toBe("string");
  });

  it("🔴 a shop with NO checklist is unchanged: books without a version, records nothing", async () => {
    const res = await bookOne(futureAtHour(3, 10));
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { shopId },
      select: { id: true, policyAcceptedAt: true, policySnapshot: true },
    });
    expect(appt!.policyAcceptedAt).toBeNull();
    expect(appt!.policySnapshot).toBeNull();
    const detail = await request(app)
      .get(`/api/booking/appointments/${appt!.id}/detail`)
      .set("Cookie", cookie);
    expect(detail.body.policyAgreement).toBeNull();
  });

  it("policy TEXT alone asks for no tick and blocks nothing", async () => {
    await withChecklist([], TEXT);
    expect((await pagePolicy())!.checklist).toEqual([]);
    const res = await bookOne(futureAtHour(3, 11));
    expect(res.status).toBe(201);
  });

  // A returning client whose phone remembers them agreeing to these words
  // before is not shown the boxes again (web rememberedBooker.ts). The record
  // must say so - it is a different fact from ticking them on this booking.
  it("a REMEMBERED agreement books, and the record says they were not re-asked", async () => {
    await withChecklist();
    const p = (await pagePolicy())!;
    const earlier = "2026-09-01T15:30:00.000Z";
    const res = await bookOne(futureAtHour(4, 10), { policyVersion: p.version, policyAgreedAt: earlier });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { shopId },
      select: { id: true, policyAcceptedAt: true, policySnapshot: true },
    });
    expect(appt!.policySnapshot).toEqual({
      version: p.version,
      text: TEXT,
      checklist: CHECKLIST,
      agreedEarlierAt: earlier,
    });
    const detail = await request(app)
      .get(`/api/booking/appointments/${appt!.id}/detail`)
      .set("Cookie", cookie);
    expect(detail.body.policyAgreement).toMatchObject({ checklist: CHECKLIST, agreedEarlierAt: earlier });
  });

  it("a ticked agreement carries no earlier date", async () => {
    await withChecklist();
    const p = (await pagePolicy())!;
    expect((await bookOne(futureAtHour(4, 11), { policyVersion: p.version })).status).toBe(201);
    const appt = await prisma.appointment.findFirst({ where: { shopId }, select: { id: true } });
    const detail = await request(app)
      .get(`/api/booking/appointments/${appt!.id}/detail`)
      .set("Cookie", cookie);
    expect(detail.body.policyAgreement.agreedEarlierAt).toBeNull();
  });

  it("🔴 a remembered agreement to OLD words is a 409 like any other - the owner's edit asks again", async () => {
    await withChecklist();
    const seen = (await pagePolicy())!.version;
    await withChecklist([...CHECKLIST, "Cash only"]);
    const res = await bookOne(futureAtHour(4, 12), {
      policyVersion: seen,
      policyAgreedAt: "2026-09-01T15:30:00.000Z",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("POLICY_CHANGED");
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 a remembered date is no permission on its own - without the version it is refused", async () => {
    await withChecklist();
    const res = await bookOne(futureAtHour(4, 13), { policyAgreedAt: "2026-09-01T15:30:00.000Z" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("POLICY_NOT_ACCEPTED");
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });

  it("a remembered date ahead of now (a phone's clock) is clamped to now, never stored as the future", async () => {
    await withChecklist();
    const p = (await pagePolicy())!;
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await bookOne(futureAtHour(4, 14), { policyVersion: p.version, policyAgreedAt: future });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({ where: { shopId }, select: { policySnapshot: true } });
    const stored = (appt!.policySnapshot as { agreedEarlierAt: string }).agreedEarlierAt;
    expect(Date.parse(stored)).toBeLessThanOrEqual(Date.now());
  });

  it("a malformed remembered date is refused before anything is written", async () => {
    await withChecklist();
    const p = (await pagePolicy())!;
    const res = await bookOne(futureAtHour(4, 15), { policyVersion: p.version, policyAgreedAt: "last week" });
    expect(res.status).toBe(400);
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });

  it("a stale page that still sends a version after the checklist was removed just books", async () => {
    await withChecklist();
    const seen = (await pagePolicy())!.version;
    await savePolicy({ bookingPolicyText: null, bookingPolicyChecklist: [] });
    const res = await bookOne(futureAtHour(3, 12), { policyVersion: seen });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({ where: { shopId }, select: { policySnapshot: true } });
    expect(appt!.policySnapshot).toBeNull();
  });
});

describe("the owner's own dashboard booking", () => {
  it("🔴 is NOT gated - the owner booking someone in is not the customer agreeing", async () => {
    await withChecklist();
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: futureAtHour(4, 10).toISOString(),
        firstName: "Walk",
        lastName: "In",
        email: `walk-${randomToken(6)}@test.local`,
      });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { shopId },
      select: { policyAcceptedAt: true, policySnapshot: true },
    });
    // And no agreement is invented on the customer's behalf.
    expect(appt!.policyAcceptedAt).toBeNull();
    expect(appt!.policySnapshot).toBeNull();
  });
});

describe("a standing appointment", () => {
  it("🔴 is REFUSED without the checklist ticked, and no series is written", async () => {
    await withChecklist();
    const res = await bookOne(futureAtHour(5, 10), { recurrence: { interval: 1, count: 3 } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("POLICY_NOT_ACCEPTED");
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
    expect(await prisma.recurringSeries.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 is REFUSED with a stale version", async () => {
    await withChecklist();
    const seen = (await pagePolicy())!.version;
    await withChecklist(["Changed"]);
    const res = await bookOne(futureAtHour(5, 11), {
      recurrence: { interval: 1, count: 3 },
      policyVersion: seen,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("POLICY_CHANGED");
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });

  it("freezes the agreement onto EVERY occurrence", async () => {
    await withChecklist();
    const p = (await pagePolicy())!;
    const res = await bookOne(futureAtHour(5, 12), {
      recurrence: { interval: 1, count: 3 },
      policyVersion: p.version,
    });
    expect(res.status).toBe(201);
    expect(res.body.series.booked).toBe(3);
    const rows = await prisma.appointment.findMany({
      where: { shopId },
      select: { policyAcceptedAt: true, policySnapshot: true },
    });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.policyAcceptedAt).not.toBeNull();
      expect(r.policySnapshot).toEqual({ version: p.version, text: TEXT, checklist: CHECKLIST });
    }
  });
});

describe("a group booking", () => {
  it("🔴 is REFUSED without the checklist ticked, and no party is written", async () => {
    await withChecklist();
    const res = await bookGroup(futureAtHour(6, 10));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("POLICY_NOT_ACCEPTED");
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
    expect(await prisma.appointmentGroup.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 is REFUSED with a stale version - a 409 carrying the current policy", async () => {
    await withChecklist();
    const seen = (await pagePolicy())!.version;
    await withChecklist(["Changed"]);
    const res = await bookGroup(futureAtHour(6, 11), { policyVersion: seen });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("POLICY_CHANGED");
    expect(res.body.policy.checklist).toEqual(["Changed"]);
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });

  it("freezes the booker's agreement onto every member's booking", async () => {
    await withChecklist();
    const p = (await pagePolicy())!;
    const res = await bookGroup(futureAtHour(6, 12), { policyVersion: p.version });
    expect(res.status).toBe(201);
    const rows = await prisma.appointment.findMany({
      where: { shopId },
      select: { groupId: true, policySnapshot: true, policyAcceptedAt: true },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.groupId).not.toBeNull();
      expect(r.policyAcceptedAt).not.toBeNull();
      expect(r.policySnapshot).toEqual({ version: p.version, text: TEXT, checklist: CHECKLIST });
    }
  });

  it("a shop with no checklist books a party exactly as before", async () => {
    const res = await bookGroup(futureAtHour(6, 13));
    expect(res.status).toBe(201);
    const rows = await prisma.appointment.findMany({
      where: { shopId },
      select: { policySnapshot: true },
    });
    expect(rows.map((r) => r.policySnapshot)).toEqual([null, null]);
  });
});
