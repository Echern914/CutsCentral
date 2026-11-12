import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { serviceOfferedDuring } from "../engines/appointmentGroup.js";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * PER-DATE HOURS FOR ONE SERVICE.
 *
 * A barber asked for longer hours for men's haircuts on the days of
 * Thanksgiving week "without messing with anything else". Service hours were
 * weekly and could only narrow the staff schedule, so there was no way to say
 * it. Service.dateHours is that way.
 *
 * The contract, in the order a reviewer should check it:
 *   1. A dated day REPLACES that service's day: its windows are offered, the
 *      usual hours are not, and a gap between windows stays closed.
 *   2. NOTHING ELSE MOVES: another service, another staff member, the same
 *      weekday on another date.
 *   3. 🔴 Read and write agree - every time the page offers on a dated day can
 *      be booked, and a time the entry leaves out is refused.
 *   4. It only adds CANDIDATE time: a block-off and a booking still cut it.
 *   5. Saves merge. Two saves at once cannot erase each other's dates.
 *
 * Shop tz = UTC so wall-clock == UTC, except the one test that is about the
 * shop's own calendar date.
 */
const app = createApp();
const email = `dh-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
let staffA: string;
let staffB: string;
let cut: string;
let trim: string;

const SATURDAY = 6;
const MONDAY = 1;
const TUESDAY = 2;

/** The next `weekday` at least `minDays` out, as a shop-local (UTC) date key. */
function nextDate(weekday: number, minDays = 2): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + minDays);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const plusDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00.000Z`);
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const span = (from: string, to: string) => ({ s: mins(from), e: mins(to) });

/** Start times (HH:MM, UTC) the public page offers for that whole date. */
async function startsOn(date: string, serviceId = cut, staffId = staffA): Promise<Set<string>> {
  const res = await request(app)
    .get(`/api/book/${slug}/slots`)
    .query({ staffId, serviceId, from: `${date}T00:00:00.000Z`, to: `${plusDays(date, 1)}T00:00:00.000Z` });
  expect(res.status).toBe(200);
  return new Set((res.body.slots as { startsAt: string }[]).map((s) => s.startsAt.slice(11, 16)));
}

const save = (body: object, serviceId = cut) =>
  request(app).put(`/api/booking/services/${serviceId}/date-hours`).set("Cookie", cookie).send(body);

const book = (date: string, hhmm: string, serviceId = cut, staffId = staffA) =>
  request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: at(date, hhmm).toISOString(),
      firstName: "Jordan",
      lastName: "C",
      email: `dh-${randomToken(6)}@test.local`,
    });

async function stored(serviceId = cut): Promise<Record<string, { w: { s: number; e: number }[]; staff: string[] }>> {
  const res = await request(app).get("/api/booking/services").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.services.find((s: { id: string }) => s.id === serviceId).dateHours;
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "DateHours", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Date Hours Cuts", bookingUrl: "https://dh.test", smsAttested: true });
  expect(shop.status).toBe(201);
  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", cookie)
        .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 })
    ).status,
  ).toBe(200);
  const me = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body;
  slug = me.slug;
  shopId = me.id;

  const mkStaff = async (name: string) => {
    const res = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  staffA = await mkStaff("Avery");
  staffB = await mkStaff("Blake");

  const mkService = async (name: string, staffIds: string[]) => {
    const res = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name, durationMin: 30, price: 45, staffIds });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  cut = await mkService("Cut", [staffA, staffB]);
  trim = await mkService("Trim", [staffA]);

  // Both work Mondays and Tuesdays 12:00-15:00. Nobody works Saturdays.
  for (const id of [staffA, staffB]) {
    const res = await request(app)
      .put(`/api/booking/staff/${id}/availability`)
      .set("Cookie", cookie)
      .send({ rules: [MONDAY, TUESDAY].map((weekday) => ({ weekday, startMin: 12 * 60, endMin: 15 * 60 })) });
    expect(res.status).toBe(200);
  }
});

afterEach(async () => {
  // Each test starts from a service with no dated hours and an empty book.
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.availabilityException.deleteMany({ where: { shopId } });
  await prisma.service.updateMany({ where: { shopId }, data: { dateHours: {}, dateOverrides: {}, timeOverrides: [] } });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("a dated day replaces that service's day", () => {
  it("opens earlier than the week does, keeps the gap closed, and drops the usual hours", async () => {
    const monday = nextDate(MONDAY);
    expect(await startsOn(monday)).toEqual(new Set(["12:00", "12:30", "13:00", "13:30", "14:00", "14:30"]));

    const res = await save({ dates: [monday], hours: [span("08:00", "10:00"), span("11:00", "13:00")] });
    expect(res.status).toBe(200);

    expect(await startsOn(monday)).toEqual(
      new Set(["08:00", "08:30", "09:00", "09:30", "11:00", "11:30", "12:00", "12:30"]),
    );
  });

  it("opens a weekday nobody works", async () => {
    const saturday = nextDate(SATURDAY);
    expect((await startsOn(saturday)).size).toBe(0);
    expect((await save({ dates: [saturday], hours: [span("10:00", "12:00")] })).status).toBe(200);
    expect(await startsOn(saturday)).toEqual(new Set(["10:00", "10:30", "11:00", "11:30"]));
  });

  it("no hours at all means not offered that date", async () => {
    const tuesday = nextDate(TUESDAY);
    expect((await save({ dates: [tuesday], hours: [] })).status).toBe(200);
    expect((await startsOn(tuesday)).size).toBe(0);
    expect((await book(tuesday, "12:00")).status).toBe(400);
  });

  it("null puts the usual week back", async () => {
    const monday = nextDate(MONDAY);
    await save({ dates: [monday], hours: [span("08:00", "09:00")] });
    expect(await startsOn(monday)).toEqual(new Set(["08:00", "08:30"]));
    expect((await save({ dates: [monday], hours: null })).status).toBe(200);
    expect(await startsOn(monday)).toEqual(new Set(["12:00", "12:30", "13:00", "13:30", "14:00", "14:30"]));
    expect(await stored()).toEqual({});
  });

  it("a weekly 'also open' window does not leak into a dated day", async () => {
    const monday = nextDate(MONDAY);
    const opened = await request(app)
      .patch(`/api/booking/services/${cut}`)
      .set("Cookie", cookie)
      .send({ timeOverrides: [{ s: 1260, e: 1380, days: [MONDAY], opensHours: true }] });
    expect(opened.status).toBe(200);
    expect((await startsOn(monday)).has("21:00")).toBe(true);

    await save({ dates: [monday], hours: [span("08:00", "09:00")] });
    expect(await startsOn(monday)).toEqual(new Set(["08:00", "08:30"]));
  });

  it("several dates in one save", async () => {
    const monday = nextDate(MONDAY);
    const tuesday = plusDays(monday, 1);
    expect((await save({ dates: [monday, tuesday], hours: [span("08:00", "09:00")] })).status).toBe(200);
    expect(await startsOn(monday)).toEqual(new Set(["08:00", "08:30"]));
    expect(await startsOn(tuesday)).toEqual(new Set(["08:00", "08:30"]));
  });
});

describe("nothing else moves", () => {
  it("another service keeps its usual day", async () => {
    const monday = nextDate(MONDAY);
    await save({ dates: [monday], hours: [span("08:00", "10:00")] });
    expect(await startsOn(monday, trim)).toEqual(
      new Set(["12:00", "12:30", "13:00", "13:30", "14:00", "14:30"]),
    );
    expect((await book(monday, "08:00", trim)).status).toBe(400);
  });

  it("the same weekday a week later is untouched", async () => {
    const monday = nextDate(MONDAY);
    await save({ dates: [monday], hours: [span("08:00", "10:00")] });
    expect(await startsOn(plusDays(monday, 7))).toEqual(
      new Set(["12:00", "12:30", "13:00", "13:30", "14:00", "14:30"]),
    );
  });

  it("an entry naming one staff member leaves the other on their usual day", async () => {
    const monday = nextDate(MONDAY);
    expect((await save({ dates: [monday], hours: [span("08:00", "09:00")], staffIds: [staffA] })).status).toBe(200);
    expect(await startsOn(monday, cut, staffA)).toEqual(new Set(["08:00", "08:30"]));
    expect(await startsOn(monday, cut, staffB)).toEqual(
      new Set(["12:00", "12:30", "13:00", "13:30", "14:00", "14:30"]),
    );
    expect((await book(monday, "08:00", cut, staffB)).status).toBe(400);
  });

  it("an entry naming nobody applies to everyone who offers it", async () => {
    const monday = nextDate(MONDAY);
    await save({ dates: [monday], hours: [span("08:00", "09:00")] });
    expect(await startsOn(monday, cut, staffB)).toEqual(new Set(["08:00", "08:30"]));
  });
});

describe("🔴 the page and the write agree", () => {
  it("every time offered on a dated day can be booked", async () => {
    const monday = nextDate(MONDAY);
    await save({ dates: [monday], hours: [span("08:00", "10:00"), span("11:00", "12:00")] });
    const offered = [...(await startsOn(monday))].sort();
    expect(offered).toEqual(["08:00", "08:30", "09:00", "09:30", "11:00", "11:30"]);
    for (const hhmm of offered) {
      const res = await book(monday, hhmm);
      expect(`${hhmm} ${res.status}`).toBe(`${hhmm} 201`);
    }
    // Fully booked now - and nothing in the usual hours came back.
    expect((await startsOn(monday)).size).toBe(0);
  });

  it("a time the entry leaves out is refused, usual hours and the gap included", async () => {
    const monday = nextDate(MONDAY);
    await save({ dates: [monday], hours: [span("08:00", "10:00"), span("11:00", "12:00")] });
    expect((await book(monday, "10:00")).status).toBe(400); // the gap
    expect((await book(monday, "14:00")).status).toBe(400); // usual hours, replaced
    expect((await book(monday, "07:30")).status).toBe(400); // before it opens
    expect((await book(monday, "11:45")).status).toBe(400); // would run past the close
  });
});

describe("it only adds candidate time", () => {
  it("a block-off still cuts a dated day", async () => {
    const monday = nextDate(MONDAY);
    await save({ dates: [monday], hours: [span("08:00", "11:00")] });
    const block = await request(app)
      .post(`/api/booking/staff/${staffA}/exceptions`)
      .set("Cookie", cookie)
      .send({ startsAt: at(monday, "09:00").toISOString(), endsAt: at(monday, "10:00").toISOString(), isBlock: true, reason: "Out" });
    expect(block.status).toBe(201);
    expect(await startsOn(monday)).toEqual(new Set(["08:00", "08:30", "10:00", "10:30"]));
    expect((await book(monday, "09:00")).status).toBe(400);
  });

  it("a booking still takes its time", async () => {
    const monday = nextDate(MONDAY);
    await save({ dates: [monday], hours: [span("08:00", "10:00")] });
    expect((await book(monday, "08:30")).status).toBe(201);
    expect(await startsOn(monday)).toEqual(new Set(["08:00", "09:00", "09:30"]));
    expect((await book(monday, "08:30")).status).toBe(409);
  });
});

describe("the shop's own calendar date", () => {
  it("a date is the SHOP's date: 8 AM New York is not 8 AM UTC", async () => {
    await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ timezone: "America/New_York" });
    try {
      const monday = nextDate(MONDAY, 3);
      const [y, m, d] = monday.split("-").map(Number) as [number, number, number];
      expect((await save({ dates: [monday], hours: [span("08:00", "09:00")] })).status).toBe(200);
      const res = await request(app)
        .get(`/api/book/${slug}/slots`)
        .query({
          staffId: staffA,
          serviceId: cut,
          from: `${plusDays(monday, -1)}T00:00:00.000Z`,
          to: `${plusDays(monday, 2)}T00:00:00.000Z`,
        });
      const starts = (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
      const eight = zonedWallTimeToUtc(y, m - 1, d, 8 * 60, "America/New_York").toISOString();
      const half = zonedWallTimeToUtc(y, m - 1, d, 8 * 60 + 30, "America/New_York").toISOString();
      // Exactly the dated hour on the dated day, in the shop's clock - and
      // none of that day's usual 12:00-15:00.
      expect(starts.filter((s) => s >= eight && s < zonedWallTimeToUtc(y, m - 1, d + 1, 0, "America/New_York").toISOString())).toEqual([eight, half]);
    } finally {
      await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ timezone: "UTC" });
    }
  });
});

describe("saving", () => {
  it("a save names only its own dates: an earlier save's dates stay", async () => {
    const monday = nextDate(MONDAY);
    const tuesday = plusDays(monday, 1);
    await save({ dates: [monday], hours: [span("08:00", "09:00")] });
    await save({ dates: [tuesday], hours: [span("10:00", "11:00")] });
    expect(await stored()).toEqual({
      [monday]: { w: [{ s: 480, e: 540 }], staff: [] },
      [tuesday]: { w: [{ s: 600, e: 660 }], staff: [] },
    });
  });

  it("two saves at the same moment both keep their dates", async () => {
    const monday = nextDate(MONDAY);
    const tuesday = plusDays(monday, 1);
    const { results, settledEarly } = await raceBehindRowLock("Service", cut, [
      () => save({ dates: [monday], hours: [span("08:00", "09:00")] }),
      () => save({ dates: [tuesday], hours: [span("10:00", "11:00")] }),
    ]);
    expect(settledEarly).toBe(0); // both really waited on the row
    expect(results.map((r) => (r.status === "fulfilled" ? r.value.status : "rejected"))).toEqual([200, 200]);
    expect(Object.keys(await stored()).sort()).toEqual([monday, tuesday]);
  });

  it("touching windows are stored as one; past dates fall away on the next save", async () => {
    const monday = nextDate(MONDAY);
    await prisma.service.update({
      where: { id: cut },
      data: { dateHours: { "2020-01-06": { w: [{ s: 480, e: 540 }], staff: [] } } },
    });
    const res = await save({ dates: [monday], hours: [span("08:00", "09:00"), span("09:00", "10:00")] });
    expect(res.status).toBe(200);
    expect(res.body.dateHours).toEqual({ [monday]: { w: [{ s: 480, e: 600 }], staff: [] } });
  });

  it("a price rides into the existing per-date price layer, and can be cleared", async () => {
    const monday = nextDate(MONDAY);
    const prices = async () => {
      const res = await request(app).get("/api/booking/services").set("Cookie", cookie);
      return res.body.services.find((s: { id: string }) => s.id === cut).dateOverrides;
    };
    await save({ dates: [monday], hours: [span("08:00", "09:00")], price: 60 });
    expect(await prices()).toEqual({ [monday]: 60 });
    // No price in the save: prices are left alone.
    await save({ dates: [monday], hours: [span("08:00", "10:00")] });
    expect(await prices()).toEqual({ [monday]: 60 });
    await save({ dates: [monday], hours: [span("08:00", "10:00")], price: null });
    expect(await prices()).toEqual({});
  });

  it("refuses what it cannot mean", async () => {
    const monday = nextDate(MONDAY);
    const code = async (body: object, serviceId = cut) => {
      const res = await save(body, serviceId);
      return `${res.status} ${res.body.error}`;
    };
    expect(await code({ dates: ["2020-01-06"], hours: [] })).toBe("400 past_date");
    expect(await code({ dates: ["2031-02-30"], hours: [] })).toBe("400 invalid_input");
    expect(await code({ dates: [], hours: [] })).toBe("400 invalid_input");
    expect(await code({ dates: [monday], hours: [span("08:00", "10:00"), span("09:00", "11:00")] })).toBe(
      "400 overlapping_hours",
    );
    expect(await code({ dates: [monday], hours: [{ s: 600, e: 600 }] })).toBe("400 invalid_input");
    expect(await code({ dates: [monday], hours: [], staffIds: ["nobody"] })).toBe("400 unknown_staff");
    // Blake does not do Trims, so a Trim entry cannot name them.
    expect(await code({ dates: [monday], hours: [], staffIds: [staffB] }, trim)).toBe("400 unknown_staff");
    expect(await code({ dates: [monday], hours: [] }, "no-such-service")).toBe("404 not_found");
    expect(await stored()).toEqual({});
  });

  it("another shop cannot write this shop's service", async () => {
    const other = `dh2-${randomToken(6)}@test.local`.toLowerCase();
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: other, password, name: "Other", smsAttested: true, acceptTerms: true });
    const otherCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({ name: "Other Cuts", bookingUrl: "https://dh2.test", smsAttested: true });
    try {
      const res = await request(app)
        .put(`/api/booking/services/${cut}/date-hours`)
        .set("Cookie", otherCookie)
        .send({ dates: [nextDate(MONDAY)], hours: [] });
      expect(res.status).toBe(404);
      expect(await stored()).toEqual({});
    } finally {
      const user = await prisma.user.findUnique({ where: { email: other } });
      if (user) {
        await prisma.shop.deleteMany({ where: { ownerId: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    }
  });
});

describe("a damaged row changes nothing", () => {
  it("junk in the column leaves the usual week in place - it never closes a day", async () => {
    const monday = nextDate(MONDAY);
    await prisma.service.update({
      where: { id: cut },
      data: {
        dateHours: {
          [monday]: { w: [{ s: "x", e: 9999 }] }, // windows written, none usable
          "not-a-date": { w: [] },
          [plusDays(monday, 1)]: "closed",
        },
      },
    });
    const usual = new Set(["12:00", "12:30", "13:00", "13:30", "14:00", "14:30"]);
    expect(await startsOn(monday)).toEqual(usual);
    expect(await startsOn(plusDays(monday, 1))).toEqual(usual);
  });
});

describe("a later member of a group booking", () => {
  const base = { hoursWindows: {}, timeOverrides: [], timezone: "UTC" };
  const day = "2031-06-02";
  const dateHours = { [day]: { w: [{ s: 480, e: 600 }], staff: [] } };

  it("is judged by the date's own hours when it has them", () => {
    const ask = (from: string, to: string, staffId = "s1", dh: unknown = dateHours) =>
      serviceOfferedDuring({ ...base, dateHours: dh, staffId, startsAt: at(day, from), endsAt: at(day, to) });
    expect(ask("08:00", "08:30")).toBe(true);
    expect(ask("09:30", "10:00")).toBe(true);
    expect(ask("09:45", "10:15")).toBe(false); // runs past the close
    expect(ask("13:00", "13:30")).toBe(false); // usual hours no longer apply
    // Closed that date.
    expect(ask("08:00", "08:30", "s1", { [day]: { w: [], staff: [] } })).toBe(false);
    // An entry for someone else: this member's usual rules decide.
    expect(ask("13:00", "13:30", "s2", { [day]: { w: [], staff: ["s1"] } })).toBe(true);
  });

  it("a dated day outranks the weekly restriction and the weekly opened window alike", () => {
    const monday = 1;
    const closedMondays = { [String(monday)]: [] };
    const openedLate = [{ s: 1260, e: 1380, days: [monday], opensHours: true }];
    const ask = (from: string, to: string) =>
      serviceOfferedDuring({
        hoursWindows: closedMondays,
        timeOverrides: openedLate,
        dateHours,
        staffId: "s1",
        timezone: "UTC",
        startsAt: at(day, from),
        endsAt: at(day, to),
      });
    expect(new Date(`${day}T12:00:00Z`).getUTCDay()).toBe(monday);
    expect(ask("08:00", "08:30")).toBe(true); // weekly says closed; the date says open
    expect(ask("21:00", "21:30")).toBe(false); // weekly opened it; the date does not list it
  });
});
