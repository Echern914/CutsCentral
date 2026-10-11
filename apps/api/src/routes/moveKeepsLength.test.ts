import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * 🔴 A MOVED BOOKING KEEPS ITS LENGTH (engines/moveLength.ts), on both doors:
 * the client's own reschedule and the shop's.
 *
 * Both used to set the new end from the SERVICE alone. A 30-minute cut booked
 * with a 30-minute add-on - or stretched to 45 by the shop - came out of a
 * move holding 30 minutes, and the booking page sold the rest of the hour to
 * somebody else. Pinned here:
 *  - add-on minutes and a hand-set length ride along;
 *  - the new time is checked for the WHOLE length, not just the service;
 *  - the service's own part is still measured at the new time (a short
 *    Friday cut stays short, its add-on does not shrink);
 *  - a client leaving a special takes the menu's length with the menu's price.
 */
const app = createApp();
let agent: ReturnType<typeof request.agent>;
let shopId: string;
let slug: string;
let staffId: string;
let cut: string;
let fridayCut: string;

/** At least two days out, on the weekday asked for, at an exact UTC time. */
function nextWeekday(weekday: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}
const MONDAY = 1;
const FRIDAY = 5;
const MIN = 60_000;

const BEARD = { id: "ao-beard", name: "Beard", durationMin: 30, price: 10 };

/** A booking row as the booking page writes it: service + add-on minutes. */
async function bookRow(over: Partial<Prisma.AppointmentUncheckedCreateInput> & { lengthMin?: number } = {}) {
  const { lengthMin = 60, ...rest } = over;
  const startsAt = (rest.startsAt as Date | undefined) ?? nextWeekday(MONDAY, 10);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: cut,
      firstName: "Long",
      lastName: "Booking",
      email: `long-${randomToken(4)}@test.local`,
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + lengthMin * MIN),
      priceAtBooking: new Prisma.Decimal("50.00"),
      addOns: [BEARD],
      manageToken: randomToken(),
      ...rest,
    },
  });
}

const span = async (id: string) => {
  const r = await prisma.appointment.findUniqueOrThrow({
    where: { id },
    select: { startsAt: true, endsAt: true },
  });
  return { startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString() };
};
const clientMove = (token: string, startsAt: Date, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/book/manage/${token}/reschedule`)
    .send({ startsAt: startsAt.toISOString(), ...extra });
const shopMove = (id: string, startsAt: Date, extra: Record<string, unknown> = {}) =>
  agent
    .post(`/api/booking/appointments/${id}/reschedule`)
    .send({ startsAt: startsAt.toISOString(), ...extra });
/** Somebody else, on the public booking page, trying the time after it. */
const someoneBooks = (startsAt: Date) =>
  request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId: cut,
      startsAt: startsAt.toISOString(),
      firstName: "Next",
      lastName: "Customer",
      phone: "+13025550177",
      email: `next-${randomToken(4)}@test.local`,
    });

beforeAll(async () => {
  agent = request.agent(app);
  const email = `movelen-${randomToken(6)}@test.local`.toLowerCase();
  await agent
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Mover", smsAttested: true });
  await agent
    .post("/api/shops")
    .send({ name: "Length Cuts", bookingUrl: "https://len.test", smsAttested: true });
  const patched = await agent
    .patch("/api/shops/me")
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 60 });
  expect(patched.status).toBe(200);
  const me = await agent.get("/api/shops/me");
  shopId = me.body.id;
  slug = me.body.slug;
  staffId = (await agent.post("/api/booking/staff").send({ name: "Sam" })).body.id;
  cut = (
    await agent
      .post("/api/booking/services")
      .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  fridayCut = (
    await agent
      .post("/api/booking/services")
      .send({ name: "Quick Friday Cut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  expect(cut).toBeTruthy();
  expect(fridayCut).toBeTruthy();
  // 20 minutes on Fridays - set directly, independent of the services form.
  await prisma.service.update({ where: { id: fridayCut }, data: { durationOverrides: { "5": 20 } } });
  // Open 09:00-17:00 every day.
  await agent
    .put(`/api/booking/staff/${staffId}/availability`)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
});

describe("🔴 a moved booking keeps every minute it was booked for", () => {
  it("the client's own move: a 30-min cut + 30-min add-on is still an hour, and the second half is not for sale", async () => {
    const a = await bookRow();
    const res = await clientMove(a.manageToken, nextWeekday(MONDAY, 13));
    expect(res.status).toBe(200);
    expect(await span(a.id)).toEqual({
      startsAt: nextWeekday(MONDAY, 13).toISOString(),
      endsAt: nextWeekday(MONDAY, 14).toISOString(),
    });
    // The half hour the add-on needs belongs to this booking, not the page.
    const next = await someoneBooks(nextWeekday(MONDAY, 13, 30));
    expect(next.status).toBe(409);
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(1);
  });

  it("the shop's move keeps it too", async () => {
    const a = await bookRow();
    const res = await shopMove(a.id, nextWeekday(MONDAY, 13));
    expect(res.status).toBe(200);
    expect((await span(a.id)).endsAt).toBe(nextWeekday(MONDAY, 14).toISOString());
    expect((await someoneBooks(nextWeekday(MONDAY, 13, 30))).status).toBe(409);
  });

  it("a length the shop set by hand (45 on a 30-minute cut, no add-ons) moves with it", async () => {
    const a = await bookRow({ lengthMin: 45, addOns: [], priceAtBooking: new Prisma.Decimal("40.00") });
    expect((await clientMove(a.manageToken, nextWeekday(MONDAY, 13))).status).toBe(200);
    expect((await span(a.id)).endsAt).toBe(nextWeekday(MONDAY, 13, 45).toISOString());
  });

  it("🔴 the new time must fit the WHOLE booking: the last half hour of the day is refused, on both doors", async () => {
    const a = await bookRow();
    const before = await span(a.id);
    // 16:30 fits a bare 30-minute cut before the 17:00 close - not an hour.
    const byClient = await clientMove(a.manageToken, nextWeekday(MONDAY, 16, 30));
    expect(byClient.status).toBe(400);
    expect(byClient.body.error).toBe("invalid_slot");
    const byShop = await shopMove(a.id, nextWeekday(MONDAY, 16, 30));
    expect(byShop.status).toBe(400);
    expect(byShop.body.error).toBe("invalid_slot");
    expect(await span(a.id)).toEqual(before);
  });

  it("🔴 the client's list of times asks what the move asks: no last half hour for a cut + add-on", async () => {
    const a = await bookRow();
    const plain = await bookRow({
      lengthMin: 30,
      addOns: [],
      priceAtBooking: new Prisma.Decimal("40.00"),
      startsAt: nextWeekday(MONDAY, 9),
    });
    const offered = async (token: string): Promise<string[]> => {
      const res = await request(app).get(`/api/book/manage/${token}/slots`);
      expect(res.status).toBe(200);
      return (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
    };
    const lastHalfHour = nextWeekday(MONDAY, 16, 30).toISOString();
    const forA = await offered(a.manageToken);
    expect(forA).not.toContain(lastHalfHour);
    expect(forA).toContain(nextWeekday(MONDAY, 16).toISOString());
    // A plain 30-minute cut is still offered it.
    expect(await offered(plain.manageToken)).toContain(lastHalfHour);
    // And the latest time the list offers is one the move accepts.
    const mondayDate = nextWeekday(MONDAY, 0).toISOString().slice(0, 10);
    const latest = forA.filter((iso) => iso.startsWith(mondayDate)).sort().at(-1)!;
    expect((await clientMove(a.manageToken, new Date(latest))).status).toBe(200);
  });

  it("the shop's Custom time still moves it there, whole", async () => {
    const a = await bookRow();
    const res = await shopMove(a.id, nextWeekday(MONDAY, 16, 30), { customTime: true });
    expect(res.status).toBe(200);
    expect((await span(a.id)).endsAt).toBe(nextWeekday(MONDAY, 17, 30).toISOString());
  });

  it("the service's own part is still measured at the new time: 20-min Friday cut + 30-min add-on = 50", async () => {
    const a = await bookRow({ serviceId: fridayCut });
    expect((await clientMove(a.manageToken, nextWeekday(FRIDAY, 13))).status).toBe(200);
    expect((await span(a.id)).endsAt).toBe(nextWeekday(FRIDAY, 13, 50).toISOString());
    // ...and back to a Monday, where the cut is 30 again: an hour.
    const b = await bookRow({ serviceId: fridayCut, startsAt: nextWeekday(FRIDAY, 10), lengthMin: 50 });
    expect((await shopMove(b.id, nextWeekday(MONDAY, 13))).status).toBe(200);
    expect((await span(b.id)).endsAt).toBe(nextWeekday(MONDAY, 14).toISOString());
  });

  it("a client leaving a special takes the menu's length along with the menu's price", async () => {
    // A 60-minute special for a 30-minute cut. Moved by the client onto the
    // regular grid it becomes an ordinary booking - its length was the special's.
    const a = await bookRow({
      addOns: [],
      priceAtBooking: new Prisma.Decimal("150.00"),
      bookedVia: "targeted_slot",
    });
    const asked = await clientMove(a.manageToken, nextWeekday(MONDAY, 13));
    expect(asked.status).toBe(409);
    const moved = await clientMove(a.manageToken, nextWeekday(MONDAY, 13), { acceptPriceCents: 4000 });
    expect(moved.status).toBe(200);
    expect((await span(a.id)).endsAt).toBe(nextWeekday(MONDAY, 13, 30).toISOString());
  });
});
