import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE DAY THE BARBER TURNS ON THAT STILL SHOWS NOTHING.
 *
 * A real support text, 2026-09-17: "i changed my availability to sunday on the
 * app but when i go through the link its blocked off". Her weekly hours had
 * Sunday ticked 9:00-21:00. Her booking page struck Sunday out.
 *
 * Nothing was broken. TWO gates decide a bookable day and only one of them is
 * in the hours editor: the staff schedule says WHEN she works, and each
 * service's own hours say WHETHER that service is offered that weekday. All
 * five of her services carried `hoursWindows: {"0":[],"1":[]}` - Sunday and
 * Monday present-but-empty, which the engine reads as "not offered" and applies
 * AFTER her hours. So she ticked Sunday, saw it ticked, saved, and the public
 * page kept saying no, with nothing anywhere explaining why.
 *
 * The API now names those weekdays so the editor can say it on the row she just
 * turned on. These tests pin both halves: the flag, and the emptiness it
 * describes.
 *
 * Shop tz = UTC so wall-clock == UTC.
 */
const app = createApp();
const email = `nosvc-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

let cookie: string;
let slug: string;
let staffId: string;
let serviceId: string;

const SUNDAY = 0;
const SATURDAY = 6;

/** The weekdays the API says have no service behind them. */
async function flagged(): Promise<number[]> {
  const res = await request(app)
    .get(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return (res.body.weekdaysWithNoService as number[]) ?? [];
}

const setServiceHours = (hoursWindows: unknown, id = serviceId) =>
  request(app)
    .patch(`/api/booking/services/${id}`)
    .set("Cookie", cookie)
    .send({ hoursWindows });

/** The next `weekday` at least 2 days out, so the booking lead time clears. */
function nextWeekday(weekday: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** How many start times the PUBLIC page offers on `date`. */
async function publicSlotCount(date: Date): Promise<number> {
  const from = new Date(date);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 1);
  const res = await request(app)
    .get(`/api/book/${slug}/slots`)
    .query({ staffId, serviceId, from: from.toISOString(), to: to.toISOString() });
  expect(res.status).toBe(200);
  return (res.body.slots as unknown[]).length;
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "NoSvc", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "No Service Cuts", bookingUrl: "https://nosvc.test", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  slug = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.slug;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Hailey" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Mens haircut", durationMin: 40, price: 45, staffIds: [staffId] });
  serviceId = service.body.id;

  // She works Saturday AND Sunday - exactly the shape in the support text.
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [SUNDAY, SATURDAY].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 21 * 60,
      })),
    });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("the weekday no service is offered on", () => {
  it("flags nothing while every service is on regular hours", async () => {
    // The default for every service that has never touched its hours: the map
    // is empty, so no weekday is restricted and the staff schedule is the
    // whole answer.
    expect(await flagged()).toEqual([]);
  });

  it("names the weekday a service vetoes - and the page really is empty", async () => {
    // Sunday PRESENT and empty: "not offered". Saturday absent: unrestricted.
    expect((await setServiceHours({ "0": [] })).status).toBe(200);

    expect(await flagged()).toContain(SUNDAY);
    expect(await flagged()).not.toContain(SATURDAY);

    // 🔴 The flag is only worth anything if it describes reality: her Sunday is
    // ticked 9-21 and the public page offers nothing, while Saturday works.
    expect(await publicSlotCount(nextWeekday(SUNDAY))).toBe(0);
    expect(await publicSlotCount(nextWeekday(SATURDAY))).toBeGreaterThan(0);
  });

  it("stops flagging the day once the service is offered again", async () => {
    expect((await setServiceHours({ "0": [{ s: 9 * 60, e: 21 * 60 }] })).status).toBe(200);

    expect(await flagged()).not.toContain(SUNDAY);
    expect(await publicSlotCount(nextWeekday(SUNDAY))).toBeGreaterThan(0);
  });

  it("an explicit 'also open these hours' window clears the veto, as the engine does", async () => {
    // Service hours say Sunday is off, but the barber ticked an opening window
    // on Sunday. That WIDENS - slots.ts unions it with the staff span - so the
    // day is bookable and must not be flagged. If this warning said otherwise
    // it would be telling her to fix a day that already works.
    expect((await setServiceHours({ "0": [] })).status).toBe(200);
    expect(await flagged()).toContain(SUNDAY);

    const opened = await request(app)
      .patch(`/api/booking/services/${serviceId}`)
      .set("Cookie", cookie)
      .send({
        timeOverrides: [
          { s: 9 * 60, e: 21 * 60, days: [SUNDAY], opensHours: true },
        ],
      });
    expect(opened.status).toBe(200);

    expect(await flagged()).not.toContain(SUNDAY);
    expect(await publicSlotCount(nextWeekday(SUNDAY))).toBeGreaterThan(0);

    // Back to the plain veto for the tests below.
    await request(app)
      .patch(`/api/booking/services/${serviceId}`)
      .set("Cookie", cookie)
      .send({ timeOverrides: [] });
  });

  it("another barber's Sunday service does not clear THIS barber's day", async () => {
    // The question is per person: a colleague being bookable on Sunday says
    // nothing about whether SHE has anything to sell that day.
    const other = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", cookie)
      .send({ name: "Someone Else" });
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({
        name: "Sunday special",
        durationMin: 30,
        price: 30,
        staffIds: [other.body.id],
      });

    expect(await flagged()).toContain(SUNDAY);
  });

  it("an INACTIVE service does not count as something to sell", async () => {
    const hidden = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Retired cut", durationMin: 30, price: 30, staffIds: [staffId] });
    // Offered every day, but switched off - a customer can never book it.
    await request(app)
      .patch(`/api/booking/services/${hidden.body.id}`)
      .set("Cookie", cookie)
      .send({ active: false });

    expect(await flagged()).toContain(SUNDAY);
  });
});
