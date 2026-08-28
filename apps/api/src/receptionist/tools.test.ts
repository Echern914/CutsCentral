import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests, type PushSender } from "../messaging/push.js";
import type { MessageProvider } from "../messaging/provider.js";
import { computeOpenSlots } from "../engines/slots.js";
import { sweepExpiredHolds } from "../engines/holdSweep.js";
import { encodeSlotId, makeToolExecutor, type ToolContext } from "./tools.js";

/**
 * The receptionist's WRITE tools against the real engine: hold_slot soft-locks
 * (and provably blocks a competing write), book_appointment lands a BOOKED row
 * with re-verification, expired holds release their slot before any sweep runs.
 */

const NOW = new Date("2026-06-01T16:00:00Z"); // Monday, 12:00 EDT
const T = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 2, h, m)); // Tue June 2

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;
let otherClientId: string;

const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send() {
    return { sid: "SMx", status: "queued" };
  },
};
const fakePush: PushSender = {
  async send() {
    /* no-op */
  },
};

function ctxFor(cId: string, phone: string): ToolContext {
  return {
    shopId,
    conversationId: `convo-${cId}`,
    phone,
    clientId: cId,
    now: NOW,
  };
}

function slotIdAt(h: number, m = 0): string {
  return encodeSlotId(staffId, serviceId, T(h, m));
}

beforeAll(async () => {
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests(fakePush);
  const user = await prisma.user.create({
    data: { email: `tools-${randomToken(6)}@test.chairback`, name: "Tools" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Tool Cuts",
      slug: `tool-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      compAccess: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Drick" } });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 35 },
  });
  serviceId = service.id;
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 0, endMin: 1439 },
    });
  }
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  const c1 = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `k-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Marcus",
      phone: "+15551230001",
      smsConsentAt: NOW,
      source: "manual",
    },
    select: { id: true },
  });
  clientId = c1.id;
  const c2 = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `k-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Tony",
      phone: "+15551230002",
      smsConsentAt: NOW,
      source: "manual",
    },
    select: { id: true },
  });
  otherClientId = c2.id;
});

afterAll(() => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
});

describe("hold_slot", () => {
  it("soft-locks the slot: it vanishes from availability and a competing hold fails", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const res = await exec("hold_slot", { slot_id: slotIdAt(14, 0) });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.result).held).toBe(true);

    // Gone from the picker for everyone.
    const slots = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: T(0, 0),
      toDate: T(23, 59),
      now: NOW,
    });
    expect(slots.some((s) => s.startsAt.getTime() === T(14, 0).getTime())).toBe(false);

    // A DIFFERENT client's overlapping hold is refused.
    const rival = makeToolExecutor(ctxFor(otherClientId, "+15551230002"));
    const rivalRes = await rival("hold_slot", { slot_id: slotIdAt(14, 0) });
    expect(rivalRes.isError).toBe(true);
    expect(rivalRes.result).toContain("taken");
  });

  it("re-holding your own live hold refreshes it instead of failing", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const first = await exec("hold_slot", { slot_id: slotIdAt(15, 0) });
    expect(first.isError).toBe(false);
    const second = await exec("hold_slot", { slot_id: slotIdAt(15, 0) });
    expect(second.isError).toBe(false);
    expect(JSON.parse(second.result).hold_id).toBe(JSON.parse(first.result).hold_id);
  });
});

describe("book_appointment", () => {
  it("flips a live hold to BOOKED in place: hold cleared, confirmation stamped", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const held = await exec("hold_slot", { slot_id: slotIdAt(10, 0) });
    const holdId = JSON.parse(held.result).hold_id as string;

    const booked = await exec("book_appointment", { slot_id: slotIdAt(10, 0) });
    expect(booked.isError).toBe(false);
    const payload = JSON.parse(booked.result);
    expect(payload.booked).toBe(true);
    expect(payload.appointment_id).toBe(holdId); // same row, no duplicate

    const row = await prisma.appointment.findUnique({ where: { id: holdId } });
    expect(row!.status).toBe("BOOKED");
    expect(row!.holdExpiresAt).toBeNull();
    expect(row!.confirmationSentAt).not.toBeNull();
    expect(row!.startsAt.getTime()).toBe(T(10, 0).getTime());
    expect(row!.bookedVia).toBe("receptionist");
    expect(Number(row!.priceAtBooking)).toBe(35);
  });

  it("books directly (guarded) when the model skipped hold_slot", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const booked = await exec("book_appointment", { slot_id: slotIdAt(11, 0) });
    expect(booked.isError).toBe(false);
    const row = await prisma.appointment.findFirst({
      where: { shopId, startsAt: T(11, 0), status: "BOOKED" },
    });
    expect(row).not.toBeNull();
  });

  it("an EXPIRED hold whose slot got taken fails with slot-lost (no silent double-book)", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    await exec("hold_slot", { slot_id: slotIdAt(12, 0) });
    // The hold lapses...
    await prisma.appointment.updateMany({
      where: { shopId, startsAt: T(12, 0), status: "PENDING" },
      data: { holdExpiresAt: new Date(NOW.getTime() - 60_000) },
    });
    // ...and someone else books an OVERLAPPING (different-start) appointment.
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Rival",
        status: "BOOKED",
        startsAt: T(12, 15),
        endsAt: T(12, 45),
        manageToken: randomToken(),
      },
    });

    const res = await exec("book_appointment", { slot_id: slotIdAt(12, 0) });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("taken");
    const stale = await prisma.appointment.findFirst({
      where: { shopId, startsAt: T(12, 0) },
    });
    expect(stale!.status).toBe("PENDING"); // never flipped
  });

  it("an EXPIRED hold whose slot is STILL free books fine (re-guarded vs BOOKED+PENDING)", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    await exec("hold_slot", { slot_id: slotIdAt(13, 0) });
    await prisma.appointment.updateMany({
      where: { shopId, startsAt: T(13, 0), status: "PENDING" },
      data: { holdExpiresAt: new Date(NOW.getTime() - 60_000) },
    });
    const res = await exec("book_appointment", { slot_id: slotIdAt(13, 0) });
    expect(res.isError).toBe(false);
    const row = await prisma.appointment.findFirst({
      where: { shopId, startsAt: T(13, 0) },
    });
    expect(row!.status).toBe("BOOKED");
  });
});

describe("book_appointment availability gate (no live hold)", () => {
  // Slot ids are a transparent staffId~serviceId~ISO codec, and the tool
  // description invites a direct book — so a mangled/hallucinated timestamp
  // used to land a REAL BOOKED row (with a confirmation text) at any
  // conflict-free instant: 3am, a day off, or months out. The gate re-runs
  // isSlotBookable for any path without a LIVE hold.
  it("refuses a direct book outside the barber's working hours", async () => {
    // A second barber with real hours (9:00-17:00 local) — the shared fixture
    // barber works 24/7, which can't distinguish an hours violation.
    const narrow = await prisma.staff.create({ data: { shopId, name: "Nine2Five" } });
    for (let weekday = 0; weekday < 7; weekday++) {
      await prisma.availabilityRule.create({
        data: { shopId, staffId: narrow.id, weekday, startMin: 540, endMin: 1020 },
      });
    }
    await prisma.serviceStaff.create({
      data: { shopId, serviceId, staffId: narrow.id },
    });

    // 07:00 UTC = 03:00 in the shop's tz — the literal 3am booking.
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const res = await exec("book_appointment", {
      slot_id: encodeSlotId(narrow.id, serviceId, T(7, 0)),
    });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("outside the shop's bookable hours");
    const row = await prisma.appointment.findFirst({
      where: { shopId, staffId: narrow.id, startsAt: T(7, 0) },
    });
    expect(row).toBeNull(); // nothing written, nothing confirmed
  });

  it("refuses a direct book past the shop's booking horizon", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const far = new Date(NOW.getTime() + 200 * 24 * 60 * 60 * 1000);
    const res = await exec("book_appointment", {
      slot_id: encodeSlotId(staffId, serviceId, far),
    });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("outside the shop's bookable hours");
    const row = await prisma.appointment.findFirst({
      where: { shopId, staffId, startsAt: far },
    });
    expect(row).toBeNull();
  });

  it("still books normally when a LIVE hold exists (hours were validated at hold time)", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const held = await exec("hold_slot", { slot_id: slotIdAt(16, 0) });
    expect(held.isError).toBe(false);
    const booked = await exec("book_appointment", { slot_id: slotIdAt(16, 0) });
    expect(booked.isError).toBe(false);
    expect(JSON.parse(booked.result).booked).toBe(true);
  });
});

describe("reschedule", () => {
  it("moves the client's own appointment: new time, fresh reminder state, slot freed", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const booked = await exec("book_appointment", { slot_id: slotIdAt(20, 0) });
    const apptId = JSON.parse(booked.result).appointment_id as string;

    const moved = await exec("reschedule", {
      appointment_id: apptId,
      new_slot_id: slotIdAt(21, 0),
    });
    expect(moved.isError).toBe(false);

    const row = await prisma.appointment.findUnique({ where: { id: apptId } });
    expect(row!.startsAt.getTime()).toBe(T(21, 0).getTime());
    expect(row!.status).toBe("BOOKED");
    expect(row!.reminderSentAt).toBeNull();

    // The old 20:00 slot is offerable again.
    const slots = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: T(0, 0),
      toDate: T(23, 59),
      now: NOW,
    });
    expect(slots.some((s) => s.startsAt.getTime() === T(20, 0).getTime())).toBe(true);
  });

  it("refuses to touch ANOTHER client's appointment no matter what id the model passes", async () => {
    const mine = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const booked = await mine("book_appointment", { slot_id: slotIdAt(22, 0) });
    const apptId = JSON.parse(booked.result).appointment_id as string;

    const rival = makeToolExecutor(ctxFor(otherClientId, "+15551230002"));
    const res = await rival("reschedule", {
      appointment_id: apptId,
      new_slot_id: slotIdAt(23, 0),
    });
    expect(res.isError).toBe(true);
    const cancelRes = await rival("cancel", { appointment_id: apptId });
    expect(cancelRes.isError).toBe(true);
    const row = await prisma.appointment.findUnique({ where: { id: apptId } });
    expect(row!.status).toBe("BOOKED");
    expect(row!.startsAt.getTime()).toBe(T(22, 0).getTime());
  });
});

describe("cancel", () => {
  it("cancels the client's own upcoming appointment and frees the slot", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    const booked = await exec("book_appointment", { slot_id: slotIdAt(8, 0) });
    const apptId = JSON.parse(booked.result).appointment_id as string;

    const res = await exec("cancel", { appointment_id: apptId });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.result).cancelled).toBe(true);

    const row = await prisma.appointment.findUnique({ where: { id: apptId } });
    expect(row!.status).toBe("CANCELED");

    const slots = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: T(0, 0),
      toDate: T(23, 59),
      now: NOW,
    });
    expect(slots.some((s) => s.startsAt.getTime() === T(8, 0).getTime())).toBe(true);
  });
});

describe("expired holds release + sweep", () => {
  it("an expired hold's slot is offerable again BEFORE any sweep; the sweep then flips it to CANCELED", async () => {
    const exec = makeToolExecutor(ctxFor(clientId, "+15551230001"));
    await exec("hold_slot", { slot_id: slotIdAt(17, 0) });
    await prisma.appointment.updateMany({
      where: { shopId, startsAt: T(17, 0), status: "PENDING" },
      data: { holdExpiresAt: new Date(NOW.getTime() - 60_000) },
    });

    // Released immediately - the picker offers it again with no sweep needed.
    const slots = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: T(0, 0),
      toDate: T(23, 59),
      now: NOW,
    });
    expect(slots.some((s) => s.startsAt.getTime() === T(17, 0).getTime())).toBe(true);

    // Sweep = hygiene: expired hold -> CANCELED; live holds + real requests stay.
    const liveHold = await exec("hold_slot", { slot_id: slotIdAt(18, 0) });
    expect(liveHold.isError).toBe(false);
    const request = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "RealRequest",
        status: "PENDING", // request-before-booking, NOT a hold
        startsAt: T(19, 0),
        endsAt: T(19, 30),
        manageToken: randomToken(),
      },
      select: { id: true },
    });

    await sweepExpiredHolds(NOW);

    const swept = await prisma.appointment.findFirst({
      where: { shopId, startsAt: T(17, 0) },
    });
    expect(swept!.status).toBe("CANCELED");
    const live = await prisma.appointment.findFirst({
      where: { shopId, startsAt: T(18, 0) },
    });
    expect(live!.status).toBe("PENDING");
    const untouched = await prisma.appointment.findUnique({ where: { id: request.id } });
    expect(untouched!.status).toBe("PENDING");
  });
});

describe("book_appointment when the shop is ENFORCING an unmapped chair", () => {
  /**
   * The receptionist is mid-conversation over SMS. An uncaught throw here is
   * not a 500 a barber can read - it is a texter who gets silence from a shop
   * that looks like it is ignoring them.
   *
   * The staff member in this fixture has no acuityCalendarId, so ENFORCE
   * cannot protect the chair. Before this was handled, recordMirrorIntent
   * threw straight out of bookAppointment.
   *
   * 🔴 The clock and the slot must agree, or this test proves nothing.
   *
   * recordMirrorIntent only acts while the appointment still occupies the chair
   * AT the instant it is given (shouldMirrorOnCreate -> appointmentOccupiesTime).
   * So a slot on one side of `now` and the clock on the other means the mirror
   * returns null on its way in, no throw is ever raised, and every assertion
   * below passes having exercised nothing at all.
   *
   * Here both come from real time: `ctx.now` is realNow and the slot is a week
   * ahead of it. Fixture time would work equally well as long as BOTH moved
   * together - what must never happen is one of them being changed alone.
   *
   * (This used to read "the mirror decides with `new Date()`, not the caller's
   * injected now". That was true, and was the #302 defect: `now` was optional
   * and no production caller passed it. #329 made it REQUIRED, so the clock
   * arrives from `ctx.now` and a forgotten one is a compile error.)
   */
  const realNow = new Date();
  const future = new Date(realNow.getTime() + 7 * 24 * 60 * 60_000);
  future.setUTCHours(15, 0, 0, 0);
  const laterFuture = new Date(future.getTime() + 60 * 60_000);

  function liveCtx(): ToolContext {
    return {
      shopId,
      conversationId: `convo-enforce-${clientId}`,
      phone: "+15551230001",
      clientId,
      now: realNow,
    };
  }

  beforeAll(async () => {
    await prisma.acuityConnection.create({
      data: {
        shopId,
        acuityAccountId: `ACC_${randomToken(6)}`,
        accessToken: "enc",
        refreshToken: "enc",
      },
    });
    await prisma.shop.update({
      where: { id: shopId },
      data: { acuityOutboundMode: "ENFORCE" },
    });
  });

  afterAll(async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
    await prisma.acuityConnection.deleteMany({ where: { shopId } });
    await prisma.appointment.deleteMany({ where: { shopId, startsAt: { gte: realNow } } });
  });

  it("fails gracefully with guidance instead of throwing", async () => {
    const exec = makeToolExecutor(liveCtx());
    const res = await exec("book_appointment", {
      slot_id: encodeSlotId(staffId, serviceId, future),
    });

    expect(res.isError).toBe(true);
    // Guidance for the model, deliberately non-technical: the client must
    // never be told about calendar mappings.
    expect(res.result).toMatch(/setup reason/i);
    expect(res.result).not.toMatch(/acuity|square|mirror|calendar/i);
  });

  it("books nothing at all when it refuses", async () => {
    const exec = makeToolExecutor(liveCtx());
    await exec("book_appointment", {
      slot_id: encodeSlotId(staffId, serviceId, laterFuture),
    });
    const booked = await prisma.appointment.findFirst({
      where: { shopId, startsAt: laterFuture, holdExpiresAt: null },
    });
    expect(booked).toBeNull();
  });
});
