import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { releaseForAppointment } from "../engines/acuityMirror.js";

/**
 * A REMOVED barber on the Acuity chair-mapping card.
 *
 * Drick, 2026-10: "Ability to remove a barber I guess, not sure what this is?"
 * Staff "Remove" is a soft delete (active=false), and the mapping card listed
 * every staff row, so a chair he had removed showed as an "Inactive" Drick
 * above his real one - "Not mapped", with nothing to do about it.
 *
 *  - a removed chair holding no calendar is not on the card at all;
 *  - a removed chair still holding one stays visible (it blocks that calendar
 *    for every other chair) and can be freed with the ordinary clear;
 *  - removing a barber lets go of their calendars in the same write, and a
 *    block already pushed to Acuity still releases afterwards.
 */
const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(),
  deleteBlock: vi.fn(async () => undefined),
  listBlocks: vi.fn(async () => []),
  listCalendars: vi.fn(async () => [
    { id: "cal_old", name: "Old chair" },
    { id: "cal_extra", name: "After hours" },
    { id: "cal_live", name: "Drick" },
  ]),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));

vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return { ...actual, getAcuityClientForShop: vi.fn(async () => acuityMock) };
});

const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let liveId: string;
let serviceId: string;
let connectedAt: Date;
const extraStaff: string[] = [];

async function addStaff(name: string): Promise<string> {
  const res = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  extraStaff.push(res.body.id);
  return res.body.id as string;
}

const mappedAt = () => new Date(connectedAt.getTime() + 1_000);

beforeAll(async () => {
  const email = `rmbarber-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Removed Op", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Removed Barber Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const live = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Drick" });
  liveId = live.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [liveId] });
  serviceId = service.body.id;
  const conn = await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: "acct_rm",
      accessToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
    select: { connectedAt: true },
  });
  connectedAt = conn.connectedAt;
  await prisma.staff.update({
    where: { id: liveId },
    data: { acuityCalendarId: "cal_live", acuityCalendarMappedAt: mappedAt() },
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.serviceStaff.deleteMany({ where: { staffId: { in: extraStaff } } });
  await prisma.staff.deleteMany({ where: { id: { in: extraStaff.splice(0) } } });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

const getMap = () =>
  request(app).get("/api/booking/acuity/calendars").set("Cookie", cookie);

describe("GET /api/booking/acuity/calendars with a removed barber", () => {
  it("🔴 a removed chair holding no calendar is not listed", async () => {
    const old = await addStaff("Drick");
    const del = await request(app).delete(`/api/booking/staff/${old}`).set("Cookie", cookie);
    expect(del.body).toEqual({ ok: true });

    const res = await getMap();
    expect(res.status).toBe(200);
    const ids = (res.body.staff as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(old);
    // Readiness is about bookable chairs only, so hiding the ghost changes nothing.
    expect(res.body.ready).toBe(true);
  });

  it("a removed chair STILL holding calendars is listed, and they stay taken until freed", async () => {
    // The state every shop that removed a mapped barber before this fix is in.
    const old = await addStaff("Drick");
    await prisma.staff.update({
      where: { id: old },
      data: {
        active: false,
        acuityCalendarId: "cal_old",
        acuityExtraCalendarIds: ["cal_extra"],
        acuityCalendarMappedAt: mappedAt(),
      },
    });

    const res = await getMap();
    const row = (res.body.staff as { id: string; active: boolean; calendarId: string | null; extraCalendarIds: string[] }[])
      .find((s) => s.id === old);
    expect(row).toMatchObject({ active: false, calendarId: "cal_old", extraCalendarIds: ["cal_extra"] });
    const takenBy = Object.fromEntries(
      (res.body.calendars as { id: string; takenByStaffId: string | null }[]).map((c) => [c.id, c.takenByStaffId]),
    );
    expect(takenBy).toEqual({ cal_old: old, cal_extra: old, cal_live: liveId });

    // The card's "Free calendar" is the ordinary clear: null drops extras too.
    const freed = await request(app)
      .put(`/api/booking/staff/${old}/acuity-calendar`)
      .set("Cookie", cookie)
      .send({ calendarId: null, connectedAt: connectedAt.toISOString() });
    expect(freed.status).toBe(200);
    expect(freed.body.ok).toBe(true);

    const after = await getMap();
    expect((after.body.staff as { id: string }[]).map((s) => s.id)).not.toContain(old);
    const takenAfter = Object.fromEntries(
      (after.body.calendars as { id: string; takenByStaffId: string | null }[]).map((c) => [c.id, c.takenByStaffId]),
    );
    expect(takenAfter).toEqual({ cal_old: null, cal_extra: null, cal_live: liveId });
  });
});

describe("DELETE /api/booking/staff/:id", () => {
  it("🔴 lets go of the chair's calendars in the same write", async () => {
    const old = await addStaff("Leaving");
    await prisma.staff.update({
      where: { id: old },
      data: {
        acuityCalendarId: "cal_old",
        acuityExtraCalendarIds: ["cal_extra"],
        acuityCalendarMappedAt: mappedAt(),
      },
    });

    const del = await request(app).delete(`/api/booking/staff/${old}`).set("Cookie", cookie);
    expect(del.body).toEqual({ ok: true });

    const row = await prisma.staff.findUniqueOrThrow({
      where: { id: old },
      select: { active: true, acuityCalendarId: true, acuityExtraCalendarIds: true, acuityCalendarMappedAt: true },
    });
    expect(row).toEqual({
      active: false,
      acuityCalendarId: null,
      acuityExtraCalendarIds: [],
      acuityCalendarMappedAt: null,
    });
    // ...so the calendar is free for the barber who is still here.
    const res = await getMap();
    expect((res.body.staff as { id: string }[]).map((s) => s.id)).not.toContain(old);
  });

  it("a block already pushed to Acuity for that chair still releases afterwards", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "ENFORCE" } });
    const old = await addStaff("Leaving");
    await prisma.staff.update({
      where: { id: old },
      data: { acuityCalendarId: "cal_old", acuityCalendarMappedAt: mappedAt() },
    });
    const startsAt = new Date(Date.now() + 2 * 60 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId: old,
        serviceId,
        firstName: "Priya",
        lastName: "Raman",
        phone: "+15555550199",
        email: "priya@example.test",
        status: "BOOKED",
        startsAt,
        endsAt,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const block = await prisma.acuityOutboundBlock.create({
      data: {
        shopId,
        appointmentId: appt.id,
        staffId: old,
        acuityCalendarId: "cal_old",
        acuityBlockId: "blk_rm_1",
        startsAt,
        endsAt,
        state: "ACTIVE",
        attempts: 1,
      },
      select: { id: true },
    });

    await request(app).delete(`/api/booking/staff/${old}`).set("Cookie", cookie).expect(200);

    // The row kept its own copy of the calendar - removal never touched it.
    const kept = await prisma.acuityOutboundBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(kept).toMatchObject({ acuityCalendarId: "cal_old", acuityBlockId: "blk_rm_1", state: "ACTIVE" });

    await releaseForAppointment(shopId, appt.id);
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_rm_1");
    const released = await prisma.acuityOutboundBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(released.state).toBe("RELEASED");
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
  });
});
