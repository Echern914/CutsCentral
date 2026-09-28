import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * ADD-ONS FROM THE BARBER'S NEW APPOINTMENT FORM (Eric: "when the barber
 * creates the appointment, the add-ons pop up when booking for a client").
 *
 *   - the dashboard slot list takes the ticked add-ons BY ID and offers only
 *     the times service + add-ons fit - and the create route, which checks the
 *     same engine with the same minutes, accepts exactly those (the grid must
 *     match the writer);
 *   - a booking made with add-ons carries their length, price and snapshot,
 *     and the calendar, the appointment sheet and checkout all see them;
 *   - an add-on the booking will not carry (another service's, another shop's,
 *     switched off, or on a repeating series) is REFUSED, never dropped - the
 *     barber was shown a total with it in;
 *   - Book anyway checks the overlap against the full length.
 *
 * Shop tz is UTC and hours are 09:00-17:00 every day, so every time below is
 * plain wall clock. Haircut 30 min $35; Beard trim +15 min +$10.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let staffId: string;
let haircutId: string;
let colorId: string;
let beardId: string; // Haircut only
let towelId: string; // every service
let glossId: string; // Color only
let retiredId: string; // switched off
let foreignId: string; // another shop's

async function signup(label: string): Promise<string> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "AddOn Barber", smsAttested: true });
  expect(res.status).toBe(201);
  const c = (res.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", c).send({ name: `${label} Cuts`, smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", c)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  return c;
}

async function addOn(c: string, body: Record<string, unknown>): Promise<string> {
  const res = await request(app).post("/api/booking/addons").set("Cookie", c).send(body);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** `days` ahead, at hh:mm UTC (= shop time). */
function dayAt(days: number, hour: number, minute = 0): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

function slots(days: number, serviceId: string, addOnIds: string[] = []) {
  const q = new URLSearchParams({
    staffId,
    serviceId,
    from: dayAt(days, 0),
    to: dayAt(days, 23, 59),
    ...(addOnIds.length > 0 ? { addOnIds: addOnIds.join(",") } : {}),
  });
  return request(app).get(`/api/booking/slots?${q}`).set("Cookie", cookie);
}
const starts = (res: request.Response): string[] =>
  (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);

function book(body: Record<string, unknown>) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({ staffId, serviceId: haircutId, ...body });
}

beforeAll(async () => {
  cookie = await signup("addon-barber");
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const haircut = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  haircutId = haircut.body.id;
  const color = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Color", durationMin: 60, price: 80, staffIds: [staffId] });
  colorId = color.body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });

  beardId = await addOn(cookie, { name: "Beard trim", durationMin: 15, price: 10, serviceIds: [haircutId] });
  towelId = await addOn(cookie, { name: "Hot towel", durationMin: 5, price: 5 });
  glossId = await addOn(cookie, { name: "Gloss", durationMin: 20, price: 25, serviceIds: [colorId] });
  retiredId = await addOn(cookie, { name: "Retired rinse", durationMin: 10, price: 3, active: false });

  const other = await signup("addon-other");
  foreignId = await addOn(other, { name: "Their towel", durationMin: 5, price: 5 });
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

describe("the barber's slot list, with add-ons", () => {
  it("🔴 leaves out a time that fits the haircut but not haircut + beard - and the booking agrees", async () => {
    const plain = await slots(2, haircutId);
    expect(plain.status).toBe(200);
    expect(starts(plain)).toContain(dayAt(2, 16, 30)); // 16:30-17:00 fits

    const withBeard = await slots(2, haircutId, [beardId]);
    expect(withBeard.status).toBe(200);
    // 16:30 + 45 min runs past the 17:00 close: not offered.
    expect(starts(withBeard)).not.toContain(dayAt(2, 16, 30));
    // 16:00 + 45 = 16:45 still fits, and the slot says how long it runs.
    const at4 = (withBeard.body.slots as { startsAt: string; endsAt: string }[]).find(
      (s) => s.startsAt === dayAt(2, 16),
    );
    expect(at4?.endsAt).toBe(dayAt(2, 16, 45));
    // The grid still steps by the haircut, not the total: 9:30 stays offered.
    expect(starts(withBeard)).toContain(dayAt(2, 9, 30));

    // THE WRITER AGREES: the time left off is refused, the one kept books.
    const refused = await book({ startsAt: dayAt(2, 16, 30), firstName: "Late", addOnIds: [beardId] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_slot");
    const booked = await book({ startsAt: dayAt(2, 16), firstName: "OnTime", addOnIds: [beardId] });
    expect(booked.status).toBe(201);
  });

  it("two add-ons add up", async () => {
    // Beard + towel = 20 extra minutes: 16:30 out, 16:00 would end 16:50 (booked above
    // on day 2, so ask day 5 instead).
    const res = await slots(5, haircutId, [beardId, towelId]);
    expect(res.status).toBe(200);
    const at4 = (res.body.slots as { startsAt: string; endsAt: string }[]).find(
      (s) => s.startsAt === dayAt(5, 16),
    );
    expect(at4?.endsAt).toBe(dayAt(5, 16, 50));
    expect(starts(res)).not.toContain(dayAt(5, 16, 30));
  });
});

describe("a booking made with add-ons", () => {
  it("🔴 runs service + add-ons, costs service + add-ons, and snapshots them - on the calendar, the sheet and checkout", async () => {
    const offered = await slots(3, haircutId, [beardId]);
    expect(starts(offered)).toContain(dayAt(3, 11));

    const res = await book({ startsAt: dayAt(3, 11), firstName: "Beardy", addOnIds: [beardId] });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({ where: { id: res.body.id } });
    expect(appt!.endsAt.toISOString()).toBe(dayAt(3, 11, 45));
    expect(Number(appt!.priceAtBooking)).toBe(45);
    expect(appt!.addOns).toEqual([{ id: beardId, name: "Beard trim", durationMin: 15, price: 10 }]);

    // The appointment sheet and its checkout read the same row.
    const detail = await request(app)
      .get(`/api/booking/appointments/${res.body.id}/detail`)
      .set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.addOns.map((a: { name: string }) => a.name)).toEqual(["Beard trim"]);
    expect(detail.body.price).toBe(45);
    expect(detail.body.durationMin).toBe(45);
    expect(detail.body.payment.totalCents).toBe(4500);

    // The calendar card ("Haircut + Beard trim").
    const agenda = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(dayAt(3, 0))}&to=${encodeURIComponent(dayAt(3, 23, 59))}`)
      .set("Cookie", cookie);
    const row = (agenda.body.agenda as { id: string; addOns: { name: string }[] }[]).find(
      (r) => r.id === res.body.id,
    );
    expect(row?.addOns.map((a) => a.name)).toEqual(["Beard trim"]);
  });
});

describe("an add-on the booking will not carry is refused, never dropped", () => {
  const cases: [string, () => string, () => string][] = [
    ["another service's", () => glossId, () => haircutId],
    ["another shop's", () => foreignId, () => haircutId],
    ["a switched-off one", () => retiredId, () => haircutId],
    ["a made-up id", () => "not-an-add-on", () => haircutId],
  ];
  for (const [label, id, service] of cases) {
    it(`🔴 ${label}: the booking is refused and nothing is written`, async () => {
      const name = `Refused${randomToken(4)}`;
      const res = await book({
        serviceId: service(),
        startsAt: dayAt(4, 14),
        firstName: name,
        addOnIds: [beardId, id()],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_add_on");
      expect(await prisma.appointment.count({ where: { firstName: name } })).toBe(0);
    });
    it(`🔴 ${label}: the slot list refuses it too`, async () => {
      const res = await slots(4, service(), [id()]);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_add_on");
    });
  }

  it("an add-on for EVERY service is carried on any of them", async () => {
    const res = await book({
      serviceId: colorId,
      startsAt: dayAt(4, 10),
      firstName: "Towel",
      customTime: true,
      addOnIds: [towelId, glossId],
    });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({ where: { id: res.body.id } });
    expect(appt!.endsAt.toISOString()).toBe(dayAt(4, 11, 25)); // 60 + 5 + 20
    expect(Number(appt!.priceAtBooking)).toBe(110); // 80 + 5 + 25
  });

  it("add-ons on a repeating series are refused rather than left off every visit", async () => {
    const name = `Series${randomToken(4)}`;
    const res = await book({
      startsAt: dayAt(4, 12),
      firstName: name,
      addOnIds: [beardId],
      recurrence: { interval: 1, count: 3 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_add_on");
    expect(await prisma.appointment.count({ where: { firstName: name } })).toBe(0);
  });
});

describe("Book anyway, with add-ons", () => {
  it("🔴 the overlap is checked against the FULL length, and the forced booking keeps it", async () => {
    // Someone at 10:00 on day 6.
    const blocker = await book({ startsAt: dayAt(6, 10), firstName: "Blocker", customTime: true });
    expect(blocker.status).toBe(201);

    // 9:30 fits a bare haircut before them, not haircut + beard.
    expect(starts(await slots(6, haircutId))).toContain(dayAt(6, 9, 30));
    expect(starts(await slots(6, haircutId, [beardId]))).not.toContain(dayAt(6, 9, 30));

    // Custom time 9:30 with the beard runs to 10:15, over the 10:00 booking.
    const first = await book({
      startsAt: dayAt(6, 9, 30),
      firstName: "Forced",
      customTime: true,
      addOnIds: [beardId],
    });
    expect(first.status).toBe(409);
    expect(first.body.code).toBe("OVERLAP");
    expect(first.body.confirmation).toEqual(expect.any(String));
    expect(await prisma.appointment.count({ where: { firstName: "Forced" } })).toBe(0);

    const forced = await book({
      startsAt: dayAt(6, 9, 30),
      firstName: "Forced",
      customTime: true,
      addOnIds: [beardId],
      overlapConfirmation: first.body.confirmation,
    });
    expect(forced.status).toBe(201);
    expect(forced.body.forced).toBe(true);
    const appt = await prisma.appointment.findUnique({ where: { id: forced.body.id } });
    expect(appt!.endsAt.toISOString()).toBe(dayAt(6, 10, 15));
    expect(Number(appt!.priceAtBooking)).toBe(45);
    expect(appt!.overlapForcedAt).not.toBeNull();
    expect((appt!.addOns as { name: string }[]).map((a) => a.name)).toEqual(["Beard trim"]);
  });
});
