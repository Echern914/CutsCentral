import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { bookingBlocksFrom } from "../services/clientBookingBlock.js";

/**
 * BLOCKING A CLIENT FROM BOOKING.
 *
 * A shop asked for it after a client caused trouble: "if any issues ever
 * happen they don't want that client booking again". The contract:
 *
 *   1. An owner or manager blocks and unblocks from the client's page; the
 *      client book can list everyone blocked.
 *   2. Every way a CUSTOMER books refuses them before anything is written -
 *      matched on the phone OR the email they type, not only the record the
 *      booking would land on - and the refusal never says "blocked".
 *   3. What they already have stays booked: they can cancel it, not move it.
 *   4. The shop can still book them itself.
 *
 * The waitlist offers, tier openings, receptionist and nudge sweep have their
 * own cases in those suites; this file drives the HTTP doors.
 */

const app = createApp();
const emails: string[] = [];
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let otherUserId: string;

/** Real open slots on the grid, so a refusal can only be about who is booking. */
async function openSlots(): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}/slots?serviceId=${serviceId}&staffId=${staffId}`);
  expect(res.status).toBe(200);
  return (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
}
let slotPool: string[] = [];
/** A fresh open slot, never handed out twice in this file. */
async function nextSlot(): Promise<string> {
  if (slotPool.length === 0) slotPool = (await openSlots()).slice(6);
  const at = slotPool.shift();
  expect(at).toBeTruthy();
  return at!;
}

function bookBody(startsAt: string, who: Record<string, unknown>) {
  return { staffId, serviceId, startsAt, firstName: "Pat", lastName: "Doe", ...who };
}

async function blockedClient(contact: { phone?: string; email?: string }, over: Record<string, unknown> = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: contact.phone ? `tel:${contact.phone}` : `mail:${contact.email!.toLowerCase()}`,
      magicToken: randomToken(),
      firstName: "Trouble",
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      source: "manual",
      bookingBlockedAt: new Date("2026-09-30T12:00:00Z"),
      ...over,
    },
    select: { id: true },
  });
}

const setBlock = (clientId: string, body: unknown) =>
  request(app).post(`/api/dashboard/clients/${clientId}/booking-block`).set("Cookie", cookie).send(body as object);

beforeAll(async () => {
  const email = `block-${randomToken(6)}@test.local`;
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Block Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Block Cuts", bookingUrl: "https://block.test", rewardLabel: "Free Cut", rewardThreshold: 10, smsAttested: true });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  slug = shopRes.body.slug;
  await prisma.shop.update({
    where: { id: shopId },
    data: { timezone: "UTC", bookingMode: "native", publicPageEnabled: true, waitlistEnabled: true, bookingLeadHours: 0 },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Trim", durationMin: 30, price: 40 }, select: { id: true } })
  ).id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({ data: { shopId, staffId, weekday, startMin: 9 * 60, endMin: 18 * 60 } });
  }

  // Another shop's client, for tenant isolation.
  const other = await prisma.user.create({ data: { email: `block-other-${randomToken(6)}@test.local`, name: "O" } });
  otherUserId = other.id;
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.shop.deleteMany({ where: { ownerId: otherUserId } });
  await prisma.user.deleteMany({ where: { id: otherUserId } });
  await prisma.$disconnect();
});

describe("matching: the contact, normalised the way the booking paths normalise it", () => {
  const blocks = bookingBlocksFrom([
    { id: "c1", acuityClientKey: "tel:+13025550100", phone: "+13025550100", email: "Pat.Doe@Example.com " },
    // A record whose phone the shop edited after it was keyed.
    { id: "c2", acuityClientKey: "tel:+13025550199", phone: "+13025550200", email: null },
  ]);

  it("a phone in any format, an email in any case, the record itself, or the key it lands on", () => {
    expect(blocks.covers({ phone: "(302) 555-0100" })).toBe(true);
    expect(blocks.covers({ email: "  pat.doe@example.COM" })).toBe(true);
    expect(blocks.covers({ clientId: "c1" })).toBe(true);
    expect(blocks.covers({ acuityClientKey: "tel:+13025550199" })).toBe(true);
    expect(blocks.covers({ phone: "+1 302 555 0200" })).toBe(true);
  });

  it("anyone else - and an empty contact - is not covered", () => {
    expect(blocks.covers({ phone: "+13025550101", email: "someone@else.test" })).toBe(false);
    expect(blocks.covers({})).toBe(false);
    expect(blocks.covers({ phone: "not a phone", email: "" })).toBe(false);
    expect(bookingBlocksFrom([]).covers({ phone: "+13025550100" })).toBe(false);
  });
});

describe("the switch on the client's page", () => {
  it("blocks, keeps the first date when pressed again, shows in the client book, and unblocks", async () => {
    const c = await prisma.client.create({
      data: { shopId, acuityClientKey: `tel:+13025550111`, magicToken: randomToken(), firstName: "Sid", phone: "+13025550111" },
      select: { id: true },
    });

    const blocked = await setBlock(c.id, { blocked: true });
    expect(blocked.status).toBe(200);
    expect(typeof blocked.body.bookingBlockedAt).toBe("string");
    const again = await setBlock(c.id, { blocked: true });
    expect(again.body.bookingBlockedAt).toBe(blocked.body.bookingBlockedAt);

    const detail = await request(app).get(`/api/dashboard/clients/${c.id}`).set("Cookie", cookie);
    expect(detail.body.client.bookingBlockedAt).toBe(blocked.body.bookingBlockedAt);
    const list = await request(app).get("/api/dashboard/clients?filter=blocked").set("Cookie", cookie);
    const listed = list.body.clients as { id: string; bookingBlocked: boolean }[];
    expect(listed.find((r) => r.id === c.id)?.bookingBlocked).toBe(true);
    expect(listed.every((r) => r.bookingBlocked)).toBe(true);
    // The search path filters in SQL, not Prisma - same answer.
    const searched = await request(app).get("/api/dashboard/clients?filter=blocked&q=Sid").set("Cookie", cookie);
    expect((searched.body.clients as { id: string }[]).map((r) => r.id)).toContain(c.id);

    const unblocked = await setBlock(c.id, { blocked: false });
    expect(unblocked.body.bookingBlockedAt).toBeNull();
    const after = await request(app).get("/api/dashboard/clients?filter=blocked").set("Cookie", cookie);
    expect((after.body.clients as { id: string }[]).map((r) => r.id)).not.toContain(c.id);
    const searchedAfter = await request(app).get("/api/dashboard/clients?filter=blocked&q=Sid").set("Cookie", cookie);
    expect((searchedAfter.body.clients as { id: string }[]).map((r) => r.id)).not.toContain(c.id);
  });

  it("refuses a malformed body, and another shop's client is a plain 404", async () => {
    const c = await blockedClient({ phone: "+13025550112" });
    expect((await setBlock(c.id, {})).status).toBe(400);
    expect((await setBlock(c.id, { blocked: "yes" })).status).toBe(400);

    const foreignShop = await prisma.shop.create({
      data: { ownerId: otherUserId, name: "Elsewhere", slug: `else-${randomToken(5)}`.toLowerCase(), webhookSecret: randomToken() },
      select: { id: true },
    });
    const foreign = await prisma.client.create({
      data: { shopId: foreignShop.id, acuityClientKey: "tel:+13025550113", magicToken: randomToken(), firstName: "Far" },
      select: { id: true },
    });
    expect((await setBlock(foreign.id, { blocked: true })).status).toBe(404);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: foreign.id } })).bookingBlockedAt).toBeNull();
  });
});

describe("🔴 the booking page refuses them - before anything is written", () => {
  it("by their phone (whatever email they type), by their email (whatever phone), and as a series", async () => {
    await blockedClient({ phone: "+13025550120", email: "blocked.one@example.com" });
    const clientsBefore = await prisma.client.count({ where: { shopId } });

    const cases = [
      { phone: "(302) 555-0120", email: "fresh.address@example.com" },
      { phone: "+13025550199", email: " BLOCKED.ONE@example.com" },
    ];
    for (const who of cases) {
      const startsAt = await nextSlot();
      const res = await request(app).post(`/api/book/${slug}`).send(bookBody(startsAt, who));
      expect(res.status, JSON.stringify(who)).toBe(403);
      expect(res.body).toEqual({ error: "contact_shop", code: "CONTACT_SHOP" });
      // 🔴 Never the word: the answer goes to whoever typed the contact.
      expect(JSON.stringify(res.body)).not.toMatch(/block/i);
      expect(await prisma.appointment.count({ where: { shopId, startsAt: new Date(startsAt) } })).toBe(0);
    }

    const series = await request(app)
      .post(`/api/book/${slug}`)
      .send(bookBody(await nextSlot(), { phone: "+13025550120", email: "blocked.one@example.com", recurrence: { interval: 2, count: 3 } }));
    expect(series.status).toBe(403);
    expect(series.body.code).toBe("CONTACT_SHOP");

    // No record was created for the new phone or the new email either.
    expect(await prisma.client.count({ where: { shopId } })).toBe(clientsBefore);
  });

  it("anyone else books as normal", async () => {
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send(bookBody(await nextSlot(), { phone: "+13025550121", email: "welcome@example.com" }));
    expect(res.status).toBe(201);
  });

  it("the shop can still book them itself", async () => {
    const c = await blockedClient({ phone: "+13025550122" });
    const startsAt = await nextSlot();
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt, firstName: "Trouble", phone: "+13025550122" });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, startsAt: new Date(startsAt) } });
    expect(appt.clientId).toBe(c.id);
  });
});

describe("groups", () => {
  it("a booker the shop blocked books no party", async () => {
    await blockedClient({ phone: "+13025550130" });
    const startsAt = await nextSlot();
    const res = await request(app)
      .post(`/api/book/${slug}/group`)
      .send({
        staffId,
        startsAt,
        attendees: [{ firstName: "Kid", serviceId }],
        firstName: "Trouble",
        lastName: "Maker",
        phone: "+13025550130",
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CONTACT_SHOP");
    expect(await prisma.appointmentGroup.count({ where: { shopId } })).toBe(0);
  });

  it("a party booked before the block can't be moved online", async () => {
    const created = await request(app)
      .post(`/api/book/${slug}/group`)
      .send({
        staffId,
        startsAt: await nextSlot(),
        attendees: [{ firstName: "Kid", serviceId }],
        firstName: "Later",
        lastName: "Blocked",
        phone: "+13025550131",
      });
    expect(created.status).toBe(201);
    const group = await prisma.appointmentGroup.findFirstOrThrow({ where: { shopId, phone: "+13025550131" } });
    await setBlock(group.clientId!, { blocked: true });

    const moved = await request(app)
      .post(`/api/book/group/${created.body.manageToken}/reschedule`)
      .send({ startsAt: await nextSlot() });
    expect(moved.status).toBe(403);
    expect(moved.body.error).toBe("contact_shop");
  });
});

describe("the waitlist", () => {
  it("refuses to add them, with the sentence the form shows - and writes nothing", async () => {
    await blockedClient({ email: "waiter@example.com" });
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "Trouble", lastName: "Maker", email: "Waiter@Example.com" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("contact_shop");
    expect(res.body.message).toMatch(/contact the shop/i);
    expect(res.body.message).not.toMatch(/block/i);
    expect(await prisma.waitlistEntry.count({ where: { shopId } })).toBe(0);

    const ok = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "Fine", lastName: "Person", email: "fine@example.com" });
    expect(ok.status).toBeLessThan(300);
  });
});

describe("what they already have", () => {
  it("can be cancelled from its link, but not moved", async () => {
    const booked = await request(app)
      .post(`/api/book/${slug}`)
      .send(bookBody(await nextSlot(), { phone: "+13025550140", email: "keeps@example.com" }));
    expect(booked.status).toBe(201);
    const token = booked.body.manageToken as string;
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { manageToken: token } });
    const before = await request(app).get(`/api/book/manage/${token}`);
    expect(before.body).toMatchObject({ canCancel: true, canReschedule: true });
    await setBlock(appt.clientId!, { blocked: true });

    // The page stops offering the move - and the contact it was matched on
    // never rides along in the answer.
    const page = await request(app).get(`/api/book/manage/${token}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ canCancel: true, canReschedule: false });
    expect(JSON.stringify(page.body)).not.toContain("+13025550140");
    expect(JSON.stringify(page.body)).not.toContain("keeps@example.com");

    const moved = await request(app).post(`/api/book/manage/${token}/reschedule`).send({ startsAt: await nextSlot() });
    expect(moved.status).toBe(403);
    expect(moved.body.error).toBe("contact_shop");
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).startsAt).toEqual(appt.startsAt);

    const cancelled = await request(app).post(`/api/book/manage/${token}/cancel`).send({});
    expect(cancelled.status).toBe(200);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("CANCELED");
  });
});

describe("the shop's own reach-outs", () => {
  it("a nudge from their page is refused while they're blocked", async () => {
    const c = await blockedClient({ phone: "+13025550150" });
    const res = await request(app).post(`/api/dashboard/nudge/${c.id}`).set("Cookie", cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cannot_nudge");
  });

  it("a merge keeps the block: blocked-wins, from the earliest date", async () => {
    const winner = await prisma.client.create({
      data: { shopId, acuityClientKey: "tel:+13025550160", magicToken: randomToken(), firstName: "Keep", phone: "+13025550160" },
      select: { id: true },
    });
    const loser = await blockedClient({ email: "dupe@example.com" });
    const res = await request(app)
      .post(`/api/dashboard/clients/${winner.id}/merge`)
      .set("Cookie", cookie)
      .send({ loserId: loser.id });
    expect(res.status).toBe(200);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: winner.id } });
    expect(after.bookingBlockedAt?.toISOString()).toBe("2026-09-30T12:00:00.000Z");
  });
});
