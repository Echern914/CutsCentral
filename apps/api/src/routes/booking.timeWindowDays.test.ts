import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Time-of-day windows that REPEAT ON CHOSEN WEEKDAYS, and the opt-in that lets
 * one OPEN hours the staff schedule doesn't cover.
 *
 * Eric: "I want the vary by time of day to be selected for specific days of the
 * week (repeating)" and "it should force limits if sunday schedule lets say ends
 * three but still want those available times to be selected."
 *
 * The second half inverts the engine's one standing rule - service hours and
 * group hours can only NARROW staff availability - so it is opt-in per window
 * (`opensHours`) and everything that SUBTRACTS still applies.
 *
 * Shop tz = UTC so wall-clock == UTC. The barber works 09:00-15:00 on SUNDAYS
 * only; the window is 21:00-23:00, six hours after he closes.
 */
const app = createApp();
const email = `twd-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let staffId: string;
let serviceId: string;

const SUNDAY = 0;
const MONDAY = 1;

/**
 * The next date (>= 2 days out, inside the booking horizon) that falls on
 * `weekday`, at the given UTC hour. Derived rather than hardcoded so the suite
 * passes whatever day it runs on.
 */
function nextWeekday(weekday: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Start times (HH:MM, UTC) offered for the whole shop-local day of `date`. */
async function startsOn(date: Date): Promise<Set<string>> {
  const from = new Date(date);
  from.setUTCHours(0, 0, 0, 0);
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

const setWindows = (timeOverrides: unknown[]) =>
  request(app)
    .patch(`/api/booking/services/${serviceId}`)
    .set("Cookie", cookie)
    .send({ timeOverrides });

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "WinDays", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Day Window Cuts", bookingUrl: "https://wd.test", smsAttested: true });
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
    .send({ name: "Drick" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 45, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;

  // Sundays AND Mondays 09:00-15:00. Two open days so a per-day window has a
  // day it does NOT cover to be checked against.
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [SUNDAY, MONDAY].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 15 * 60,
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

describe("time windows: repeat days", () => {
  it("accepts the same clock on DIFFERENT days, rejects it on a shared day", async () => {
    // Same minutes, disjoint days: never compete, so not an overlap.
    expect(
      (
        await setWindows([
          { s: 1260, e: 1380, days: [SUNDAY], price: 60 },
          { s: 1260, e: 1380, days: [MONDAY], price: 70 },
        ])
      ).status,
    ).toBe(200);

    // Sharing Sunday -> a real conflict.
    expect(
      (
        await setWindows([
          { s: 1260, e: 1380, days: [SUNDAY], price: 60 },
          { s: 1300, e: 1400, days: [SUNDAY, MONDAY], price: 70 },
        ])
      ).status,
    ).toBe(400);

    // An every-day window (no `days`) shares every day, so it still conflicts.
    expect(
      (
        await setWindows([
          { s: 1260, e: 1380, price: 60 },
          { s: 1300, e: 1400, days: [SUNDAY], price: 70 },
        ])
      ).status,
    ).toBe(400);
  });

  it("rejects an out-of-range weekday", async () => {
    expect((await setWindows([{ s: 1260, e: 1380, days: [7], price: 60 }])).status).toBe(400);
  });

  it("prices ONLY the weekdays the window repeats on", async () => {
    // 10:00-11:00 Sundays at $80 — inside the 09:00-15:00 schedule, so this
    // tests the price layer alone with no availability change.
    expect(
      (await setWindows([{ s: 600, e: 660, days: [SUNDAY], price: 80 }])).status,
    ).toBe(200);

    const priceAt = async (date: Date, hhmm: string) => {
      const res = await request(app)
        .get(`/api/book/${slug}/day`)
        .query({ date: date.toISOString().slice(0, 10) });
      expect(res.status).toBe(200);
      const all = [
        ...res.body.bundles.flatMap((b: { services: unknown[] }) => b.services),
        ...res.body.ungrouped,
      ];
      const svc = all.find((s: { id: string }) => s.id === serviceId) as {
        slots: { startsAt: string; price?: number }[];
      };
      return svc.slots.find((s) => s.startsAt.slice(11, 16) === hhmm)?.price;
    };

    // Sunday 10:00 carries the window price; Monday 10:00 is untouched (the
    // day-level base, so no per-slot badge at all).
    expect(await priceAt(nextWeekday(SUNDAY, 12), "10:00")).toBe(80);
    expect(await priceAt(nextWeekday(MONDAY, 12), "10:00")).toBeUndefined();
  });
});

describe("time windows: opening hours past the schedule", () => {
  it("a window alone does NOT open time outside the schedule", async () => {
    // 21:00-23:00 Sundays, priced but NOT opted in. He closes at 15:00, so the
    // window prices hours that are never offered — the behavior before the
    // opt-in existed, kept intact so no shop silently gains hours.
    expect(
      (await setWindows([{ s: 1260, e: 1380, days: [SUNDAY], price: 60 }])).status,
    ).toBe(200);
    const starts = await startsOn(nextWeekday(SUNDAY, 12));
    expect(starts.has("14:30")).toBe(true); // schedule still ends at 15:00
    expect(starts.has("21:00")).toBe(false);
  });

  it("opensHours makes those exact times bookable on the chosen days only", async () => {
    expect(
      (
        await setWindows([
          { s: 1260, e: 1380, days: [SUNDAY], price: 60, opensHours: true },
        ])
      ).status,
    ).toBe(200);

    const sunday = await startsOn(nextWeekday(SUNDAY, 12));
    // The regular day is untouched...
    expect(sunday.has("09:00")).toBe(true);
    expect(sunday.has("14:30")).toBe(true);
    // ...and 21:00-23:00 is now offered, stepping by the base 30 min.
    for (const t of ["21:00", "21:30", "22:00", "22:30"]) {
      expect(sunday.has(t)).toBe(true);
    }
    // 22:30 + 30 = 23:00 closes it exactly; nothing spills past the window.
    expect(sunday.has("23:00")).toBe(false);
    expect(sunday.has("20:30")).toBe(false); // the gap 15:00-21:00 stays shut

    // Monday shares the schedule but not the window.
    const monday = await startsOn(nextWeekday(MONDAY, 12));
    expect(monday.has("14:30")).toBe(true);
    expect(monday.has("21:00")).toBe(false);
  });

  it("opens a weekday the barber does not work at all", async () => {
    // Saturday has NO availability rule, so the day used to be skipped outright.
    const SATURDAY = 6;
    expect((await startsOn(nextWeekday(SATURDAY, 12))).size).toBe(0);
    expect(
      (
        await setWindows([
          { s: 1260, e: 1380, days: [SATURDAY], price: 60, opensHours: true },
        ])
      ).status,
    ).toBe(200);
    const sat = await startsOn(nextWeekday(SATURDAY, 12));
    expect(sat.has("21:00")).toBe(true);
    expect(sat.has("09:00")).toBe(false); // only what the window opened
  });

  it("opening hours needs no price or minutes - it does something on its own", async () => {
    expect(
      (await setWindows([{ s: 1260, e: 1380, days: [SUNDAY], opensHours: true }])).status,
    ).toBe(200);
    const starts = await startsOn(nextWeekday(SUNDAY, 12));
    expect(starts.has("21:00")).toBe(true);
  });

  it("opened time is still cut by a block-off", async () => {
    expect(
      (
        await setWindows([
          { s: 1260, e: 1380, days: [SUNDAY], price: 60, opensHours: true },
        ])
      ).status,
    ).toBe(200);
    const sunday = nextWeekday(SUNDAY, 21);
    const blockEnd = new Date(sunday);
    blockEnd.setUTCHours(22, 0, 0, 0);
    const block = await request(app)
      .post(`/api/booking/staff/${staffId}/exceptions`)
      .set("Cookie", cookie)
      .send({
        startsAt: sunday.toISOString(),
        endsAt: blockEnd.toISOString(),
        isBlock: true,
        reason: "Family",
      });
    expect(block.status).toBe(201);

    // Opening hours ADDS candidate time; it never overrides a conflict.
    const starts = await startsOn(sunday);
    expect(starts.has("21:00")).toBe(false);
    expect(starts.has("21:30")).toBe(false);
    expect(starts.has("22:00")).toBe(true);

    await prisma.availabilityException.deleteMany({ where: { staffId } });
  });
});
