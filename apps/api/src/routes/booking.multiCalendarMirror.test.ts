import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { AcuityError } from "../acuity/client.js";
import { createApp } from "../app.js";

/**
 * THE CUSTOMER PATH, ON A BARBER SOLD THROUGH SEVERAL ACUITY CALENDARS.
 *
 * This route is the one that says "You're booked!" out loud, so it is the one
 * that must fail closed. With one calendar that was simple: the block landed or
 * it didn't. With four it is not - two can land while a third is refused, and
 * the hour the customer just paid attention to is STILL on sale on the other
 * two calendars.
 *
 * So "partly blocked" is treated as not blocked: the booking is undone, and -
 * the part that is easy to forget - the blocks that DID land are released.
 * Leaving them would take real calendars off the barber's board for an
 * appointment that no longer exists, with nothing left pointing at them.
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
const email = `mcal-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;

const MAIN = "cal_haircut";
const EXTRA_A = "cal_retwist";
const EXTRA_B = "cal_afterhours";

/** Midday UTC a few days out: always inside the 9-17 rules, never in the past. */
function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

let slot = 9;
/** A fresh time per test, so one test's row never blocks the next one's. */
function nextSlot(): Date {
  slot += 1;
  return futureAtHour(3, slot);
}

async function book(startsAt: Date) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      firstName: "Cust",
      lastName: "Omer",
      phone: "(302) 555-0411",
      email: "cust0411@example.com",
      smsConsent: true,
    });
}

const blocksFor = (appointmentId: string) =>
  prisma.acuityOutboundBlock.findMany({ where: { shopId, appointmentId } });

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "MCal", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Split Calendar Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Drick" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  serviceId = service.body.id;
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });

  // ENFORCING, connected, and this chair is sold on three calendars.
  await prisma.shop.update({
    where: { id: shopId },
    data: { acuityOutboundMode: "ENFORCE" },
  });
  const conn = await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: `ACC_${randomToken(6)}`, accessToken: "enc" },
    select: { connectedAt: true },
  });
  await prisma.staff.update({
    where: { id: staffId },
    data: {
      acuityCalendarId: MAIN,
      acuityExtraCalendarIds: [EXTRA_A, EXTRA_B],
      // Strictly after connectedAt or the mapping reads as stale.
      acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1_000),
    },
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

describe("a public booking blocks every calendar the chair is sold on", () => {
  it("confirms only once all three blocks are live", async () => {
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main" })
      .mockResolvedValueOnce({ id: "blk_a" })
      .mockResolvedValueOnce({ id: "blk_b" });

    const res = await book(nextSlot());

    expect(res.status).toBe(201);
    expect(acuityMock.createBlock.mock.calls.map((c) => c[0].calendarID)).toEqual([
      MAIN,
      EXTRA_A,
      EXTRA_B,
    ]);
    const rows = await blocksFor(res.body.appointmentId ?? res.body.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.state === "ACTIVE")).toBe(true);
  });

  it("🔴 refuses the booking when ANY calendar is refused - and frees the blocks that landed", async () => {
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main" })
      .mockRejectedValueOnce(new AcuityError(422, "nope"))
      .mockResolvedValueOnce({ id: "blk_b" });
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    const res = await book(nextSlot());

    // The customer gets the same clean answer as any other lost slot - no
    // money has moved and nothing has been sent.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_unavailable_external");

    const appt = await prisma.appointment.findFirst({ where: { shopId } });
    expect(appt!.status).toBe("CANCELED");
    // THE PART THAT IS EASY TO MISS: two blocks really were created on the
    // barber's calendars. Cancelling without releasing them would blank two
    // real calendars for an appointment nobody has.
    expect(acuityMock.deleteBlock.mock.calls.map((c) => c[0]).sort()).toEqual([
      "blk_b",
      "blk_main",
    ]);
    const rows = await blocksFor(appt!.id);
    expect(rows.filter((r) => r.state === "RELEASED")).toHaveLength(2);
    expect(rows.filter((r) => r.state === "FAILED")).toHaveLength(1);
  });

  it("an ambiguous calendar KEEPS the booking and answers processing", async () => {
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main" })
      .mockRejectedValueOnce(new AcuityError(504, "timeout"))
      .mockResolvedValueOnce({ id: "blk_b" });

    const res = await book(nextSlot());

    // The block on cal_retwist may well exist - we simply never heard back.
    // Cancelling here would kill a real appointment over a lost response and
    // strand a live block, so the row stands and the reconciler settles it.
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("processing");
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
    const appt = await prisma.appointment.findFirst({ where: { shopId } });
    expect(appt!.status).not.toBe("CANCELED");
    const rows = await blocksFor(appt!.id);
    expect(rows.filter((r) => r.state === "UNKNOWN")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "ACTIVE")).toHaveLength(2);
  });
});
