import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * SOLO SHOPS: a service's hours are the barber's hours.
 *
 * The pilot barber, verbatim: "if i set my hours and select myself as staff i
 * shouldnt have to set my hours in staff section as well." Before this, service
 * hours could only NARROW staff availability, so a window reaching past his
 * weekly rules saved fine and changed nothing on the booking page - the "no 7pm
 * slot" complaint.
 *
 * A one-barber shop now widens that barber's rules on save. Extend-only: the
 * write must never take bookable time away, because a silently closed day is
 * invisible until a client cannot book. Multi-staff shops keep the intersect.
 *
 * Shop tz = UTC so wall-clock == UTC. The barber starts on Mon + Tue 09:00-17:00.
 */
const app = createApp();
const email = `solo-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let staffId: string;
let serviceId: string;

const MONDAY = 1;
const TUESDAY = 2;
const WEDNESDAY = 3;

/** This barber's weekly rules, as sorted "weekday:start-end" strings. */
async function rules(): Promise<string[]> {
  const res = await request(app)
    .get(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return (res.body.rules as { weekday: number; startMin: number; endMin: number }[])
    .map((r) => `${r.weekday}:${r.startMin}-${r.endMin}`)
    .sort();
}

const setHours = (hoursWindows: unknown) =>
  request(app)
    .patch(`/api/booking/services/${serviceId}`)
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

/** Start times (HH:MM, UTC) the public booking page offers on `date`. */
async function startsOn(date: Date): Promise<Set<string>> {
  const from = new Date(date);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 1);
  const res = await request(app)
    .get(`/api/book/${slug}/slots`)
    .query({ staffId, serviceId, from: from.toISOString(), to: to.toISOString() });
  expect(res.status).toBe(200);
  return new Set(
    (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt.slice(11, 16)),
  );
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Solo", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Solo Cuts", bookingUrl: "https://solo.test", smsAttested: true });
  expect(shop.status).toBe(201);
  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", cookie)
        .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 })
    ).status,
  ).toBe(200);
  slug = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.slug;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Solo Barber" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 45, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;

  expect(
    (
      await request(app)
        .put(`/api/booking/staff/${staffId}/availability`)
        .set("Cookie", cookie)
        .send({
          rules: [MONDAY, TUESDAY].map((weekday) => ({
            weekday,
            startMin: 9 * 60,
            endMin: 17 * 60,
          })),
        })
    ).status,
  ).toBe(200);
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("solo shop: service hours are the barber's hours", () => {
  it("widens the barber's rules to cover a later window, and the booking page offers it", async () => {
    // Before: 17:00 is the wall. 18:00 cannot be offered no matter what the
    // service says - this is the exact state the pilot was stuck in.
    expect(await startsOn(nextWeekday(MONDAY))).not.toContain("18:00");

    // Mondays 09:00-19:00 on the SERVICE.
    expect((await setHours({ "1": [{ s: 9 * 60, e: 19 * 60 }] })).status).toBe(200);

    // Monday's rule moved out to 19:00; Tuesday, which the service said nothing
    // about, is untouched.
    expect(await rules()).toEqual(["1:540-1140", "2:540-1020"]);

    // Eric's standing rule: the dashboard edit must reach the booking page.
    expect(await startsOn(nextWeekday(MONDAY))).toContain("18:00");
  });

  it("never shrinks - a narrower window later leaves the widened rule alone", async () => {
    // 10:00-12:00 sits well inside Monday's 09:00-19:00. Taking the intersect
    // here would slam the day shut from both ends; extend-only must not.
    expect((await setHours({ "1": [{ s: 10 * 60, e: 12 * 60 }] })).status).toBe(200);
    expect(await rules()).toEqual(["1:540-1140", "2:540-1020"]);
  });

  it("opens a weekday the barber had no hours on at all", async () => {
    expect(
      (
        await setHours({
          "1": [{ s: 10 * 60, e: 12 * 60 }],
          "3": [{ s: 10 * 60, e: 14 * 60 }],
        })
      ).status,
    ).toBe(200);
    expect(await rules()).toEqual(["1:540-1140", "2:540-1020", "3:600-840"]);
  });

  it("derives nothing from a weekday marked not-offered, or from no windows at all", async () => {
    // [] means "closed that day" and an absent weekday means "unrestricted".
    // Neither states a time, so neither may invent one - and neither may wipe
    // the rules already derived.
    expect((await setHours({ "4": [] })).status).toBe(200);
    expect(await rules()).toEqual(["1:540-1140", "2:540-1020", "3:600-840"]);

    expect((await setHours({})).status).toBe(200);
    expect(await rules()).toEqual(["1:540-1140", "2:540-1020", "3:600-840"]);
  });

  it("never moves a day's START earlier — that re-phases the whole grid", async () => {
    // The defect this pins: the slot grid is anchored at the window start and
    // steps by duration, so pulling Monday open at 08:15 would re-time every
    // slot in the day and DELETE 7:00/7:30 PM while adding coverage. Widening
    // the tail is safe; widening the head is not.
    expect(
      (await setHours({ "1": [{ s: 8 * 60 + 15, e: 20 * 60 }] })).status,
    ).toBe(200);
    const after = await rules();
    expect(after).toContain("1:540-1200"); // end moved 19:00 -> 20:00
    expect(after.some((r) => r.startsWith("1:495"))).toBe(false); // 08:15 refused
  });

  it("never bridges a lunch break, and never adds a second window to a day", async () => {
    // Hand-build the split shape the old merge destroyed: Tue 09:00-12:00 and
    // 13:00-17:00 with a protected hour between.
    expect(
      (
        await request(app)
          .put(`/api/booking/staff/${staffId}/availability`)
          .set("Cookie", cookie)
          .send({
            rules: [
              { weekday: TUESDAY, startMin: 9 * 60, endMin: 12 * 60 },
              { weekday: TUESDAY, startMin: 13 * 60, endMin: 17 * 60 },
              { weekday: MONDAY, startMin: 9 * 60, endMin: 20 * 60 },
            ],
          })
      ).status,
    ).toBe(200);

    // A service declaring straight through the break must NOT swallow it.
    expect((await setHours({ "2": [{ s: 9 * 60, e: 19 * 60 }] })).status).toBe(200);
    const after = await rules();
    expect(after).toContain("2:540-720"); // 09:00-12:00 intact
    expect(after).toContain("2:780-1140"); // 13:00-17:00 extended to 19:00
    expect(after.filter((r) => r.startsWith("2:"))).toHaveLength(2); // no third row
  });

  it("extends the existing day instead of creating a disjoint evening window", async () => {
    // Give Wednesday a real 10:00-19:00 day to extend (the previous test's
    // replace-all PUT left only Mon/Tue).
    expect(
      (
        await request(app)
          .put(`/api/booking/staff/${staffId}/availability`)
          .set("Cookie", cookie)
          .send({
            rules: [
              { weekday: MONDAY, startMin: 9 * 60, endMin: 20 * 60 },
              { weekday: TUESDAY, startMin: 9 * 60, endMin: 12 * 60 },
              { weekday: TUESDAY, startMin: 13 * 60, endMin: 19 * 60 },
              { weekday: WEDNESDAY, startMin: 10 * 60, endMin: 19 * 60 },
            ],
          })
      ).status,
    ).toBe(200);

    // A window that starts AFTER the day closes used to create a SECOND rule,
    // which the Staff -> Hours sheet then renders alone and deletes the rest of
    // the day on save. One row per weekday keeps that gun unloaded.
    expect((await setHours({ "3": [{ s: 20 * 60, e: 22 * 60 }] })).status).toBe(200);
    const wed = (await rules()).filter((r) => r.startsWith("3:"));
    expect(wed).toHaveLength(1);
    expect(wed[0]).toBe("3:600-1320"); // 10:00 open kept, close pushed to 22:00
  });

  it("stops write-through the moment a second barber exists", async () => {
    const before = await rules();

    const second = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", cookie)
      .send({ name: "Second Chair" });
    expect(second.status).toBe(201);

    // With two chairs, "my hours" is meaningless - the intersect is back and
    // this window past every close must change nobody's rules.
    expect((await setHours({ "1": [{ s: 9 * 60, e: 23 * 60 }] })).status).toBe(200);
    expect(await rules()).toEqual(before);

    await request(app)
      .delete(`/api/booking/staff/${second.body.id}`)
      .set("Cookie", cookie);
  });
});
