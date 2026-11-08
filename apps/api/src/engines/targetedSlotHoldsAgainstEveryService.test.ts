import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { computeOpenSlots } from "./slots.js";
import { createApp } from "../app.js";

/**
 * 🔴 AN UNBOOKED TARGETED SLOT HOLDS ITS TIME AGAINST EVERY SERVICE, not just
 * the one it sells. A barber (2026-11-08) saved a 90 minute service for 7:00-8:30
 * PM and 7:00 never showed, because a 30 minute haircut slot sat at 8:00.
 *
 * The service editor warns about exactly this, and repeats the arithmetic to do
 * it (apps/web targetedSlotHoursConflicts.ts). If the engine's rule ever changes,
 * this goes red and that warning has to change with it.
 */
const app = createApp();
const email = `tslot-hold-${randomToken(6)}@test.local`.toLowerCase();
let cookie: string;
let shopId: string;
let staffId: string;
let longServiceId: string;
let shortServiceId: string;

/** Tomorrow at an exact UTC hour (shop tz = UTC, so wall == UTC). */
function tomorrowAt(hourUtc: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

async function longServiceStarts(): Promise<string[]> {
  const slots = await computeOpenSlots({
    shopId,
    staffId,
    serviceId: longServiceId,
    fromDate: tomorrowAt(0),
    toDate: tomorrowAt(23, 59),
  });
  return slots.map((s) => s.startsAt.toISOString());
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "T", smsAttested: true, acceptTerms: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Hold Cuts", bookingUrl: "https://book.test", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  shopId = me.body.id;

  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const long = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Retwist", durationMin: 90, price: 80, staffIds: [staffId] });
  longServiceId = long.body.id;
  const short = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  shortServiceId = short.body.id;

  // Evenings only: 7:00-10:00 PM every day.
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 19 * 60, endMin: 22 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a targeted slot for one service", () => {
  it("takes a longer start away from a different service", async () => {
    const before = await longServiceStarts();
    expect(before).toContain(tomorrowAt(19).toISOString());

    const created = await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId: shortServiceId,
        label: "After Hours Haircut",
        startsAt: tomorrowAt(20).toISOString(),
        durationMin: 30,
        price: 60,
      });
    expect(created.status).toBe(201);

    const after = await longServiceStarts();
    // 90 minutes from 7:00 runs into the 8:00 slot; the grid resumes when it ends.
    expect(after).not.toContain(tomorrowAt(19).toISOString());
    expect(after).toContain(tomorrowAt(20, 30).toISOString());
  });
});
