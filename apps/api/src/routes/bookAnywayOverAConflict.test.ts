import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { AcuityError } from "../acuity/client.js";
import { createApp } from "../app.js";
import { overlapConfirmation } from "../engines/bookingWrite.js";
import { encodeSlotId, makeToolExecutor } from "../receptionist/tools.js";

/**
 * "BOOK ANYWAY" - the barber forcing an appointment over a time conflict, from
 * inside the app (Eric: "a force appointment button where the barber can force
 * an appointment ... even if there's a time conflict").
 *
 * What is pinned here, in the order a barber meets it:
 *  - the refusal names WHO and WHEN, and hands back the one question the second
 *    tap answers; the confirmed retry books it and STAMPS it as forced;
 *  - without that answer nothing changes: refused, nothing written;
 *  - only an owner or manager seat can reach it (a BARBER seat has no
 *    dashboard booking at all);
 *  - a customer's LIVE HOLD is never booked over, answer or not;
 *  - the calendar card is marked, and the customer-facing grid stays blocked
 *    by BOTH bookings;
 *  - moving a booking in the edit sheet goes through the same question;
 *  - no customer-driven path accepts the answer;
 *  - on an Acuity-enforcing shop, a forced booking Acuity refuses to block is
 *    undone rather than left for sale there.
 */

const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  listBlocks: vi.fn(),
  listCalendars: vi.fn(),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));
vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return { ...actual, getAcuityClientForShop: vi.fn(async () => acuityMock) };
});

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

let ownerCookie: string;
let ownerUserId: string;
let managerCookie: string;
let managerUserId: string;
let barberCookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

/** `daysAhead` days from now at hh:mm UTC (the shop runs in UTC). */
function at(daysAhead: number, hourUtc: number, minute = 0): Date {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}
/** The shop's own wording for a time, exactly as the API formats it. */
const clock = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(d);

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}

function book(cookie: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, ...body });
}

/** A customer's hold, as the receptionist or the payment step writes one. */
async function holdAt(startsAt: Date, holdReason: string | null) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Holding",
      status: "PENDING",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
      holdReason,
      bookedVia: holdReason ? undefined : "receptionist",
      manageToken: randomToken(),
    },
  });
}

beforeAll(async () => {
  const owner = await signup("anyway-owner");
  ownerCookie = owner.cookie;
  ownerUserId = owner.userId;
  await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Anyway Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Chair" }))
    .body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", ownerCookie)
      .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 6 * 60, endMin: 22 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", ownerCookie).send({ rules });
  const me = await request(app).get("/api/shops/me").set("Cookie", ownerCookie);
  shopId = me.body.id;
  slug = me.body.slug;

  const manager = await signup("anyway-manager");
  managerCookie = manager.cookie;
  managerUserId = manager.userId;
  await prisma.shopMember.create({ data: { shopId, userId: manager.userId, role: "MANAGER" } });
  const barber = await signup("anyway-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER", staffId } });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shopMember.deleteMany({ where: { userId: user.id } });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("Book anyway on the dashboard", () => {
  it("names who and when, asks once more, then books it - stamped as forced", async () => {
    const first = await book(ownerCookie, {
      startsAt: at(2, 10).toISOString(),
      firstName: "Marcus",
      lastName: "Reed",
      customTime: true,
    });
    expect(first.status).toBe(201);

    const refused = await book(ownerCookie, {
      startsAt: at(2, 10, 15).toISOString(),
      firstName: "Geo",
      customTime: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "slot_taken", code: "OVERLAP", confirmable: true });
    expect(refused.body.conflicts.join(" ")).toContain("Marcus R.");
    // The question the second tap answers, in the shop's own wording.
    expect(refused.body.message).toBe(`This overlaps Marcus R. at ${clock(at(2, 10))}. Book it anyway?`);
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Geo" } })).toBe(0);

    const before = Date.now();
    const forced = await book(ownerCookie, {
      startsAt: at(2, 10, 15).toISOString(),
      firstName: "Geo",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.status).toBe(201);
    expect(forced.body.forced).toBe(true);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: forced.body.id } });
    expect(row.status).toBe("BOOKED");
    expect(row.overlapForcedByUserId).toBe(ownerUserId);
    expect(row.overlapForcedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The booking he booked OVER is untouched and not marked.
    const marcus = await prisma.appointment.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(marcus.status).toBe("BOOKED");
    expect(marcus.overlapForcedAt).toBeNull();
  });

  it("without the answer it is refused exactly as before, and nothing is written", async () => {
    await book(ownerCookie, { startsAt: at(2, 12).toISOString(), firstName: "Held", customTime: true });
    const plain = await book(ownerCookie, {
      startsAt: at(2, 12, 10).toISOString(),
      firstName: "NoAnswer",
      customTime: true,
    });
    expect(plain.status).toBe(409);
    expect(plain.body.error).toBe("slot_taken");
    const wrong = await book(ownerCookie, {
      startsAt: at(2, 12, 10).toISOString(),
      firstName: "NoAnswer",
      customTime: true,
      overlapConfirmation: "not-the-answer",
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("OVERLAP");
    expect(await prisma.appointment.count({ where: { shopId, firstName: "NoAnswer" } })).toBe(0);
  });

  it("the database refuses a 'who forced it' with no 'when'", async () => {
    const res = await book(ownerCookie, { startsAt: at(2, 20).toISOString(), firstName: "NoWhen" });
    await expect(
      prisma.appointment.update({
        where: { id: res.body.id },
        data: { overlapForcedByUserId: ownerUserId, overlapForcedAt: null },
      }),
    ).rejects.toThrow(/Appointment_overlap_forced_by_needs_at_check/);
  });

  it("a normal booking is never stamped as forced", async () => {
    const res = await book(ownerCookie, { startsAt: at(2, 18).toISOString(), firstName: "Plain" });
    expect(res.status).toBe(201);
    expect(res.body.forced).toBeUndefined();
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.overlapForcedAt).toBeNull();
    expect(row.overlapForcedByUserId).toBeNull();
  });

  it("the calendar marks the forced booking - and only that one - Double-booked", async () => {
    const a = await book(ownerCookie, { startsAt: at(3, 9).toISOString(), firstName: "Early", customTime: true });
    const refused = await book(ownerCookie, {
      startsAt: at(3, 9, 20).toISOString(),
      firstName: "Late",
      customTime: true,
    });
    const b = await book(ownerCookie, {
      startsAt: at(3, 9, 20).toISOString(),
      firstName: "Late",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(b.status).toBe(201);
    const agenda = await request(app)
      .get("/api/booking/agenda")
      .query({ from: at(3, 0).toISOString(), to: at(3, 23).toISOString() })
      .set("Cookie", ownerCookie);
    expect(agenda.status).toBe(200);
    const rows = agenda.body.agenda as { id: string; doubleBooked?: boolean }[];
    expect(rows.find((r) => r.id === b.body.id)!.doubleBooked).toBe(true);
    expect(rows.find((r) => r.id === a.body.id)!.doubleBooked).toBeUndefined();
  });
});

describe("who may book anyway", () => {
  it("a MANAGER seat can, and is recorded as the one who did", async () => {
    await book(managerCookie, { startsAt: at(4, 10).toISOString(), firstName: "First", customTime: true });
    const refused = await book(managerCookie, {
      startsAt: at(4, 10, 10).toISOString(),
      firstName: "ByManager",
      customTime: true,
    });
    const forced = await book(managerCookie, {
      startsAt: at(4, 10, 10).toISOString(),
      firstName: "ByManager",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.status).toBe(201);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: forced.body.id } });
    expect(row.overlapForcedByUserId).toBe(managerUserId);
  });

  it("a BARBER seat cannot book from the dashboard at all - answer or not", async () => {
    await book(ownerCookie, { startsAt: at(4, 12).toISOString(), firstName: "Taken", customTime: true });
    const refused = await book(ownerCookie, {
      startsAt: at(4, 12, 10).toISOString(),
      firstName: "ByBarber",
      customTime: true,
    });
    const res = await book(barberCookie, {
      startsAt: at(4, 12, 10).toISOString(),
      firstName: "ByBarber",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(res.status).toBe(403);
    expect(await prisma.appointment.count({ where: { shopId, firstName: "ByBarber" } })).toBe(0);
  });
});

describe("a customer's live hold is never booked over", () => {
  for (const [label, holdReason] of [
    ["a receptionist hold", null],
    ["a payment hold (mid-checkout)", "payment"],
  ] as const) {
    it(`${label}: refused with when it ends, and no Book anyway - even with the answer`, async () => {
      const hour = holdReason ? 15 : 14;
      const hold = await holdAt(at(5, hour), holdReason);
      const refused = await book(ownerCookie, {
        startsAt: at(5, hour, 10).toISOString(),
        firstName: `OverHold${hour}`,
        customTime: true,
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: "slot_taken", code: "HELD", confirmable: false });
      expect(refused.body.confirmation).toBeUndefined();
      expect(refused.body.reason).toContain(`held for them until ${clock(hold.holdExpiresAt!)}`);

      // The exact answer "Book anyway" would have carried, had it been offered.
      const answer = overlapConfirmation({ appointmentIds: [hold.id], visitIds: [], targetedIds: [] });
      const again = await book(ownerCookie, {
        startsAt: at(5, hour, 10).toISOString(),
        firstName: `OverHold${hour}`,
        customTime: true,
        overlapConfirmation: answer,
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("HELD");
      expect(await prisma.appointment.count({ where: { shopId, firstName: `OverHold${hour}` } })).toBe(0);
    });
  }

  it("a hold that has lapsed is nothing at all - booked normally, no force", async () => {
    const hold = await holdAt(at(5, 17), null);
    await prisma.appointment.update({
      where: { id: hold.id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });
    const res = await book(ownerCookie, { startsAt: at(5, 17, 10).toISOString(), firstName: "AfterLapse", customTime: true });
    expect(res.status).toBe(201);
    expect(res.body.forced).toBeUndefined();
  });
});

describe("availability stays true for customers", () => {
  it("the public grid stays blocked by BOTH bookings - and by the forced one alone once the other cancels", async () => {
    const a = await book(ownerCookie, { startsAt: at(6, 10).toISOString(), firstName: "GridA", customTime: true });
    const refused = await book(ownerCookie, {
      startsAt: at(6, 10, 20).toISOString(),
      firstName: "GridB",
      customTime: true,
    });
    const b = await book(ownerCookie, {
      startsAt: at(6, 10, 20).toISOString(),
      firstName: "GridB",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(b.status).toBe(201);

    const offered = async () =>
      (
        await request(app)
          .get(`/api/book/${slug}/slots`)
          .query({ staffId, serviceId, from: at(6, 6).toISOString(), to: at(6, 21).toISOString() })
      ).body.slots as { startsAt: string; endsAt: string }[];
    const hits = (slots: { startsAt: string; endsAt: string }[], from: Date, to: Date) =>
      slots.filter((s) => Date.parse(s.startsAt) < to.getTime() && Date.parse(s.endsAt) > from.getTime());

    const both = await offered();
    expect(both.length).toBeGreaterThan(0); // the day is open around them
    expect(hits(both, at(6, 10), at(6, 10, 30))).toEqual([]); // A
    expect(hits(both, at(6, 10, 20), at(6, 10, 50))).toEqual([]); // B

    const cancel = await request(app)
      .post(`/api/booking/appointments/${a.body.id}/cancel`)
      .set("Cookie", ownerCookie)
      .send({});
    expect(cancel.status).toBe(200);
    const onlyB = await offered();
    expect(hits(onlyB, at(6, 10, 20), at(6, 10, 50))).toEqual([]);
  });
});

describe("the edit sheet: moving a booking onto a conflict", () => {
  it("asks the same question, stamps the forced move, and a later clean move clears it", async () => {
    await book(ownerCookie, { startsAt: at(7, 10, 15).toISOString(), firstName: "Fixed", customTime: true });
    const moving = await book(ownerCookie, { startsAt: at(7, 14).toISOString(), firstName: "Mover" });
    expect(moving.status).toBe(201);
    const patch = (body: Record<string, unknown>) =>
      request(app).patch(`/api/booking/appointments/${moving.body.id}`).set("Cookie", ownerCookie).send(body);

    const refused = await patch({ startsAt: at(7, 10).toISOString() });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "slot_taken", code: "OVERLAP", confirmable: true });
    expect(refused.body.message).toBe(`This overlaps Fixed at ${clock(at(7, 10, 15))}. Book it anyway?`);
    let row = await prisma.appointment.findUniqueOrThrow({ where: { id: moving.body.id } });
    expect(row.startsAt.getTime()).toBe(at(7, 14).getTime()); // nothing moved

    const forced = await patch({ startsAt: at(7, 10).toISOString(), overlapConfirmation: refused.body.confirmation });
    expect(forced.status).toBe(200);
    row = await prisma.appointment.findUniqueOrThrow({ where: { id: moving.body.id } });
    expect(row.startsAt.getTime()).toBe(at(7, 10).getTime());
    expect(row.overlapForcedByUserId).toBe(ownerUserId);
    expect(row.overlapForcedAt).not.toBeNull();

    const clean = await patch({ startsAt: at(7, 16).toISOString() });
    expect(clean.status).toBe(200);
    row = await prisma.appointment.findUniqueOrThrow({ where: { id: moving.body.id } });
    expect(row.overlapForcedAt).toBeNull();
    expect(row.overlapForcedByUserId).toBeNull();
  });

  it("will not move a booking over a customer's live hold", async () => {
    await holdAt(at(7, 18, 15), "payment");
    const moving = await book(ownerCookie, { startsAt: at(7, 20).toISOString(), firstName: "MoverTwo" });
    const res = await request(app)
      .patch(`/api/booking/appointments/${moving.body.id}`)
      .set("Cookie", ownerCookie)
      .send({ startsAt: at(7, 18).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HELD");
    expect(res.body.confirmation).toBeUndefined();
  });
});

describe("never from a customer-driven path", () => {
  // One booking on the chair, and the exact answer that would force over it
  // from the dashboard. Every path below is handed that answer anyway.
  let taken: { id: string };
  let answer: string;
  // 10:00 is on the grid (so every path gets as far as the overlap guard) and
  // sits inside `taken` (9:45-10:15).
  const OVER = () => at(8, 10);
  beforeAll(async () => {
    const res = await book(ownerCookie, { startsAt: at(8, 9, 45).toISOString(), firstName: "Occupant", customTime: true });
    taken = { id: res.body.id };
    answer = overlapConfirmation({ appointmentIds: [taken.id], visitIds: [], targetedIds: [] });
  });
  // Scoped to the rows THIS path would write (by name or client), so a path
  // that really double-books fails its own test and not the ones after it.
  const nothingNewAt = async (startsAt: Date, who: { firstName?: string[]; clientId?: string }) =>
    expect(
      await prisma.appointment.count({
        where: {
          shopId,
          startsAt,
          status: { in: ["BOOKED", "PENDING"] },
          ...(who.firstName ? { firstName: { in: who.firstName } } : {}),
          ...(who.clientId ? { clientId: who.clientId } : {}),
        },
      }),
    ).toBe(0);

  it("the public booking page refuses the field outright", async () => {
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: OVER().toISOString(),
        firstName: "Web",
        lastName: "Tester",
        email: `web-${randomToken(6)}@test.local`,
        overlapConfirmation: answer,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    await nothingNewAt(OVER(), { firstName: ["Web"] });
    // And without the field, the page is refused by the guard as always.
    const plain = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: OVER().toISOString(),
        firstName: "Web",
        lastName: "Tester",
        email: `web-${randomToken(6)}@test.local`,
      });
    expect(plain.status).toBe(409);
    await nothingNewAt(OVER(), { firstName: ["Web"] });
  });

  it("the customer's manage-link reschedule refuses it", async () => {
    const own = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Mine",
        status: "BOOKED",
        startsAt: at(8, 15),
        endsAt: at(8, 15, 30),
        manageToken: randomToken(),
      },
    });
    const res = await request(app)
      .post(`/api/book/manage/${own.manageToken}/reschedule`)
      .send({ startsAt: OVER().toISOString(), overlapConfirmation: answer });
    expect(res.status).toBe(400);
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.startsAt.getTime()).toBe(at(8, 15).getTime());
  });

  it("group booking refuses it", async () => {
    const res = await request(app)
      .post(`/api/book/${slug}/group`)
      .send({
        staffId,
        startsAt: OVER().toISOString(),
        attendees: [{ firstName: "Kid", serviceId }],
        firstName: "Parent",
        lastName: "Group",
        email: `grp-${randomToken(6)}@test.local`,
        overlapConfirmation: answer,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    await nothingNewAt(OVER(), { firstName: ["Kid", "Parent"] });
  });

  it("a waitlist offer claim refuses it", async () => {
    const res = await request(app)
      .post(`/api/book/offer/${randomToken()}/claim`)
      .send({ firstName: "Claimer", overlapConfirmation: answer });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("the SMS receptionist's tools ignore it - the time stays taken", async () => {
    const client = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `k-${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "Texter",
        phone: "+15551239876",
        source: "manual",
      },
    });
    const exec = makeToolExecutor({
      shopId,
      conversationId: `convo-${randomToken(4)}`,
      phone: "+15551239876",
      clientId: client.id,
      now: new Date(),
    });
    const slotId = encodeSlotId(staffId, serviceId, OVER());
    for (const tool of ["hold_slot", "book_appointment"]) {
      const res = await exec(tool, {
        slot_id: slotId,
        overlap_confirmation: answer,
        overlapConfirmation: answer,
      });
      expect(res.isError).toBe(true);
      // Refused BY THE GUARD (the time is taken) - not for some other reason
      // that would let this pass without the guard ever being asked.
      expect(res.result).toContain("that slot just got taken");
    }
    await nothingNewAt(OVER(), { clientId: client.id });
  });
});

describe("an Acuity-enforcing shop", () => {
  let eCookie: string;
  let eShopId: string;
  let eStaffId: string;
  let eServiceId: string;
  const eBook = (body: Record<string, unknown>) =>
    request(app)
      .post("/api/booking/appointments")
      .set("Cookie", eCookie)
      .send({ staffId: eStaffId, serviceId: eServiceId, customTime: true, ...body });
  let blockSeq = 0;

  beforeAll(async () => {
    const owner = await signup("anyway-enforce");
    eCookie = owner.cookie;
    eShopId = (await request(app).post("/api/shops").set("Cookie", eCookie).send({ name: "Enforce Cuts", smsAttested: true }))
      .body.id;
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", eCookie)
      .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
    await prisma.shop.update({ where: { id: eShopId }, data: { acuityOutboundMode: "ENFORCE" } });
    const conn = await prisma.acuityConnection.create({
      data: { shopId: eShopId, acuityAccountId: `ACC_${randomToken(6)}`, accessToken: "enc", refreshToken: "enc" },
      select: { connectedAt: true },
    });
    const staff = await prisma.staff.create({
      data: {
        shopId: eShopId,
        name: "Mapped",
        acuityCalendarId: "cal_main",
        acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1000),
      },
    });
    eStaffId = staff.id;
    const service = await prisma.service.create({ data: { shopId: eShopId, name: "Cut", durationMin: 30, price: 40 } });
    eServiceId = service.id;
    await prisma.serviceStaff.create({ data: { shopId: eShopId, serviceId: eServiceId, staffId: eStaffId } });
  });

  beforeEach(() => {
    acuityMock.createBlock.mockReset();
    acuityMock.deleteBlock.mockReset();
    acuityMock.listBlocks.mockReset();
    acuityMock.createBlock.mockImplementation(async () => ({ id: `blk-${++blockSeq}` }));
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    acuityMock.listBlocks.mockResolvedValue([]);
  });

  /** A booking already on the chair, mirrored, plus the refusal over it. */
  async function occupiedThenRefused(hour: number) {
    const first = await eBook({ startsAt: at(9, hour).toISOString(), firstName: `Occ${hour}` });
    expect(first.status).toBe(201);
    const refused = await eBook({ startsAt: at(9, hour, 15).toISOString(), firstName: `Force${hour}` });
    expect(refused.body.code).toBe("OVERLAP");
    return { first, refused };
  }

  it("Acuity REFUSES the forced booking's block: it is undone, the special goes back on sale, and he is told", async () => {
    const special = await prisma.targetedSlot.create({
      data: {
        shopId: eShopId,
        staffId: eStaffId,
        serviceId: eServiceId,
        label: "Late",
        startsAt: at(9, 10, 30),
        durationMin: 30,
        price: 60,
      },
    });
    const first = await eBook({ startsAt: at(9, 10).toISOString(), firstName: "Occ10" });
    expect(first.status).toBe(201);
    const refused = await eBook({ startsAt: at(9, 10, 15).toISOString(), firstName: "Force10" });
    expect(refused.body.code).toBe("OVERLAP");

    acuityMock.createBlock.mockRejectedValueOnce(new AcuityError(422, "refused"));
    const res = await eBook({
      startsAt: at(9, 10, 15).toISOString(),
      firstName: "Force10",
      overlapConfirmation: refused.body.confirmation,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("acuity_refused");
    expect(res.body.reason).toContain("wasn't booked");

    const forcedRow = await prisma.appointment.findFirstOrThrow({ where: { shopId: eShopId, firstName: "Force10" } });
    expect(forcedRow.status).toBe("CANCELED");
    expect(forcedRow.dismissedAt).not.toBeNull(); // off his day: he was told it was not booked
    expect(
      await prisma.acuityOutboundBlock.count({
        where: { appointmentId: forcedRow.id, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
      }),
    ).toBe(0);
    expect((await prisma.targetedSlot.findUniqueOrThrow({ where: { id: special.id } })).active).toBe(true);
    // The booking already there is exactly as it was.
    const occ = await prisma.appointment.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(occ.status).toBe("BOOKED");
  });

  it("Acuity takes the block: the forced booking stands, mirrored", async () => {
    const { refused } = await occupiedThenRefused(12);
    const res = await eBook({
      startsAt: at(9, 12, 15).toISOString(),
      firstName: "Force12",
      overlapConfirmation: refused.body.confirmation,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ forced: true, mirror: "active" });
    expect(await prisma.acuityOutboundBlock.count({ where: { appointmentId: res.body.id, state: "ACTIVE" } })).toBe(1);
  });

  it("an AMBIGUOUS answer is not a refusal: the booking stands and the reconciler settles it", async () => {
    const { refused } = await occupiedThenRefused(14);
    acuityMock.createBlock.mockRejectedValueOnce(new AcuityError(504, "gateway timeout"));
    const res = await eBook({
      startsAt: at(9, 14, 15).toISOString(),
      firstName: "Force14",
      overlapConfirmation: refused.body.confirmation,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ forced: true, mirror: "unknown" });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe("BOOKED");
  });

  it("an ordinary booking Acuity refuses is kept, exactly as before this change", async () => {
    acuityMock.createBlock.mockRejectedValueOnce(new AcuityError(422, "refused"));
    const res = await eBook({ startsAt: at(9, 18).toISOString(), firstName: "Ordinary" });
    expect(res.status).toBe(201);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe("BOOKED");
  });
});
