import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Per-service TIME-OF-DAY windows end to end (Drick: "select hours in which
 * appointment duration varies ... slots would be shorter within a specific
 * service"): the dashboard PATCH validates + persists timeOverrides, the slot
 * grid steps by the window duration inside the window, the public menu widens
 * its ranges, /day badges only the in-window chips with their own price/length,
 * and a booking inside the window snapshots the window price + duration.
 *
 * Shop tz = UTC so wall-clock == UTC in the math. Window: 21:00-23:00
 * (1260-1380) at $65 / 20 min over a $45 / 30 min base.
 */
const app = createApp();
const email = `twin-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let staffId: string;
let serviceId: string;

/** A future instant (UTC) at the given hour/minute, `daysAhead` days out. */
function futureAt(daysAhead: number, hourUtc: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Windows", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Window Cuts", bookingUrl: "https://w.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  expect(patch.status).toBe(200);
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 45, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;

  // Open 09:00-23:00 every day so the evening window sits inside staff hours.
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 23 * 60,
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

describe("service time-of-day windows", () => {
  it("rejects overlapping windows and no-effect windows; accepts and persists a valid set", async () => {
    const overlap = await request(app)
      .patch(`/api/booking/services/${serviceId}`)
      .set("Cookie", cookie)
      .send({
        timeOverrides: [
          { s: 1200, e: 1320, price: 60 },
          { s: 1260, e: 1380, price: 65 },
        ],
      });
    expect(overlap.status).toBe(400);

    const noEffect = await request(app)
      .patch(`/api/booking/services/${serviceId}`)
      .set("Cookie", cookie)
      .send({ timeOverrides: [{ s: 1260, e: 1380 }] });
    expect(noEffect.status).toBe(400);

    const ok = await request(app)
      .patch(`/api/booking/services/${serviceId}`)
      .set("Cookie", cookie)
      .send({ timeOverrides: [{ s: 1260, e: 1380, price: 65, durationMin: 20 }] });
    expect(ok.status).toBe(200);

    const list = await request(app)
      .get("/api/booking/services")
      .set("Cookie", cookie);
    expect(list.status).toBe(200);
    const svc = list.body.services.find(
      (s: { id: string }) => s.id === serviceId,
    );
    expect(svc.timeOverrides).toEqual([
      { s: 1260, e: 1380, price: 65, durationMin: 20 },
    ]);
  });

  it("public menu: ranges widen with the window and timeOverrides ride along", async () => {
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.status).toBe(200);
    const svc = res.body.services.find((s: { id: string }) => s.id === serviceId);
    expect(svc.priceRange).toEqual({ min: 45, max: 65 });
    expect(svc.durationRange).toEqual({ min: 20, max: 30 });
    // The PUBLIC payload is the PARSED window, so it now carries the repeat days
    // ([] = every day) and the open-hours flag — the customer page needs both to
    // match a window on DAY as well as time. (The dashboard list above returns
    // the stored JSON verbatim and is unchanged.)
    expect(svc.timeOverrides).toEqual([
      { s: 1260, e: 1380, days: [], price: 65, durationMin: 20, opensHours: false },
    ]);
  });

  it("slot grid steps 30 min outside the window and 20 min inside it", async () => {
    const from = futureAt(2, 0);
    const to = futureAt(3, 0);
    const res = await request(app)
      .get(`/api/book/${slug}/slots`)
      .query({ staffId, serviceId, from: from.toISOString(), to: to.toISOString() });
    expect(res.status).toBe(200);
    const starts = new Set(
      (res.body.slots as { startsAt: string }[]).map((s) =>
        s.startsAt.slice(11, 16),
      ),
    );
    // Daytime: base 30-min steps on the half hour.
    expect(starts.has("14:00")).toBe(true);
    expect(starts.has("14:30")).toBe(true);
    expect(starts.has("14:20")).toBe(false);
    // Last pre-window slot runs 20:30-21:00, then the window steps by 20.
    expect(starts.has("20:30")).toBe(true);
    for (const t of ["21:00", "21:20", "21:40", "22:00", "22:20", "22:40"]) {
      expect(starts.has(t)).toBe(true);
    }
    expect(starts.has("21:30")).toBe(false);
    // 22:40 + 20 = 23:00 closes the day exactly; nothing after.
    expect(starts.has("23:00")).toBe(false);
  });

  it("/day badges ONLY in-window chips with their price/duration", async () => {
    const day = futureAt(2, 12);
    const date = day.toISOString().slice(0, 10);
    const res = await request(app).get(`/api/book/${slug}/day`).query({ date });
    expect(res.status).toBe(200);
    const all = [...res.body.bundles.flatMap((b: { services: unknown[] }) => b.services), ...res.body.ungrouped];
    const svc = all.find((s: { id: string }) => (s as { id: string }).id === serviceId) as {
      price: number;
      durationMin: number;
      slots: { startsAt: string; price?: number; durationMin?: number }[];
    };
    expect(svc.price).toBe(45); // day level stays the weekday/base layer
    expect(svc.durationMin).toBe(30);
    const bySlot = new Map(svc.slots.map((s) => [s.startsAt.slice(11, 16), s]));
    const nine = bySlot.get("21:00")!;
    expect(nine.price).toBe(65);
    expect(nine.durationMin).toBe(20);
    const two = bySlot.get("14:00")!;
    expect(two.price).toBeUndefined();
    expect(two.durationMin).toBeUndefined();
  });

  it("booking inside the window snapshots the window price + duration; outside stays base", async () => {
    const inWindow = futureAt(2, 21);
    const resIn = await request(app).post(`/api/book/${slug}`).send({
      staffId,
      serviceId,
      startsAt: inWindow.toISOString(),
      firstName: "Evening",
      phone: "(302) 555-0322",
    });
    expect(resIn.status).toBe(201);
    const rowIn = await prisma.appointment.findUnique({
      where: { manageToken: resIn.body.manageToken },
      select: { startsAt: true, endsAt: true, priceAtBooking: true },
    });
    expect(rowIn!.endsAt.getTime() - rowIn!.startsAt.getTime()).toBe(20 * 60_000);
    expect(Number(rowIn!.priceAtBooking)).toBe(65);

    const daytime = futureAt(2, 14);
    const resOut = await request(app).post(`/api/book/${slug}`).send({
      staffId,
      serviceId,
      startsAt: daytime.toISOString(),
      firstName: "Daytime",
      phone: "(302) 555-0323",
    });
    expect(resOut.status).toBe(201);
    const rowOut = await prisma.appointment.findUnique({
      where: { manageToken: resOut.body.manageToken },
      select: { startsAt: true, endsAt: true, priceAtBooking: true },
    });
    expect(rowOut!.endsAt.getTime() - rowOut!.startsAt.getTime()).toBe(30 * 60_000);
    expect(Number(rowOut!.priceAtBooking)).toBe(45);
  });
});
