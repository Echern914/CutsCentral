import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, forShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { slotServiceIds } from "../engines/targetedSlotServices.js";

/**
 * One targeted slot, several services.
 *
 * "This 8:30 PM hour is available as a retwist OR a line-up" could not be said:
 * a slot carried one serviceId, so a barber wanting two had to publish two -
 * two availability records for ONE physical hour, and booking one left the
 * other bookable. That is a double-book.
 *
 * 🔑 THE PROPERTY EVERY TEST HERE PROTECTS: there is still exactly ONE
 * TargetedSlot row per physical time. Capacity lives on it
 * (bookedAppointmentId is UNIQUE), so booking through ANY listed service
 * consumes it for all of them.
 */

const app = createApp();
const email = `tms-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let retwistId: string;
let lineupId: string;
let fadeId: string;

function tomorrowAt(hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function publish(body: Record<string, unknown>) {
  return request(app)
    .post("/api/booking/targeted-slots")
    .set("Cookie", cookie)
    .send(body);
}

/** The one row at this instant, with its service listings. */
async function slotAt(startsAt: Date) {
  return prisma.targetedSlot.findFirstOrThrow({
    where: { shopId, startsAt },
    select: {
      id: true,
      serviceId: true,
      bookedAppointmentId: true,
      services: { select: { serviceId: true } },
    },
  });
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Multi Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
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
    .send({ name: "Sam" });
  staffId = staff.body.id;

  for (const [name, set] of [
    ["Retwist", (v: string) => (retwistId = v)],
    ["Line-up", (v: string) => (lineupId = v)],
    ["Fade", (v: string) => (fadeId = v)],
  ] as const) {
    const r = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name, durationMin: 30, price: 40, staffIds: [staffId] });
    set(r.body.id);
  }

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
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.targetedSlot.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe("publishing under several services", () => {
  it("creates ONE slot row listed under all of them", async () => {
    const at = tomorrowAt(20);
    const res = await publish({
      staffId,
      serviceId: retwistId,
      serviceIds: [retwistId, lineupId],
      startsAt: at.toISOString(),
      durationMin: 60,
      price: 90,
      label: "Evening double",
    });
    expect(res.status).toBe(201);

    // ONE physical availability record, not one per service.
    const rows = await prisma.targetedSlot.findMany({ where: { shopId, startsAt: at } });
    expect(rows).toHaveLength(1);

    const slot = await slotAt(at);
    expect(slotServiceIds(slot).sort()).toEqual([retwistId, lineupId].sort());
    // serviceId stays populated for backward compatibility.
    expect(slot.serviceId).toBe(retwistId);
  });

  it("still works with no serviceIds at all - the pre-multi shape", async () => {
    const at = tomorrowAt(21);
    expect(
      (
        await publish({
          staffId,
          serviceId: fadeId,
          startsAt: at.toISOString(),
          durationMin: 30,
          price: 50,
        })
      ).status,
    ).toBe(201);
    const slot = await slotAt(at);
    expect(slotServiceIds(slot)).toEqual([fadeId]);
  });

  it("refuses a service from another shop", async () => {
    // The ids come off the request body; without the re-check a crafted POST
    // could list a slot under another tenant's service.
    const otherUser = await request(app)
      .post("/api/auth/signup")
      .send({
        email: `tms2-${randomToken(6)}@test.local`.toLowerCase(),
        password,
        name: "O",
        smsAttested: true,
      });
    const otherCookie = (otherUser.headers["set-cookie"] as unknown as string[])[0]!;
    await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({ name: "Other", bookingUrl: "https://o.test", smsAttested: true });
    const otherMe = await request(app).get("/api/shops/me").set("Cookie", otherCookie);
    const otherStaff = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", otherCookie)
      .send({ name: "Zed" });
    const foreign = await request(app)
      .post("/api/booking/services")
      .set("Cookie", otherCookie)
      .send({
        name: "Foreign",
        durationMin: 30,
        price: 10,
        staffIds: [otherStaff.body.id],
      });

    const res = await publish({
      staffId,
      serviceId: retwistId,
      serviceIds: [retwistId, foreign.body.id],
      startsAt: tomorrowAt(22).toISOString(),
      durationMin: 30,
      price: 60,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_service");

    await prisma.targetedSlot.deleteMany({ where: { shopId: otherMe.body.id } });
  });
});

describe("the public page", () => {
  it("offers the SAME slot under every listed service", async () => {
    const at = tomorrowAt(19);
    await publish({
      staffId,
      serviceId: retwistId,
      serviceIds: [retwistId, lineupId],
      startsAt: at.toISOString(),
      durationMin: 45,
      price: 95,
      label: "Shared hour",
    });

    const key = at.toISOString().slice(0, 10);
    const day = await request(app).get(`/api/book/${slug}/day?date=${key}`);
    expect(day.status).toBe(200);
    const svcs = [
      ...(day.body.bundles ?? []).flatMap(
        (b: { services: DaySvc[] }) => b.services,
      ),
      ...(day.body.ungrouped ?? []),
    ] as DaySvc[];

    const chipFor = (id: string) =>
      svcs
        .find((s) => s.id === id)
        ?.slots.find((x) => x.targeted?.label === "Shared hour");

    const a = chipFor(retwistId);
    const b = chipFor(lineupId);
    expect(a, "missing under the primary service").toBeTruthy();
    expect(b, "missing under the second service").toBeTruthy();
    // THE SAME slot id under both - one physical hour, two doors to it.
    expect(a!.targeted!.id).toBe(b!.targeted!.id);
  });
});

describe("shared capacity", () => {
  it("booking through ONE service consumes the slot for the others", async () => {
    const at = tomorrowAt(15);
    await publish({
      staffId,
      serviceId: retwistId,
      serviceIds: [retwistId, lineupId],
      startsAt: at.toISOString(),
      durationMin: 30,
      price: 70,
      label: "One and done",
    });
    const slot = await slotAt(at);

    // Book it as the LINE-UP (the non-primary service).
    const first = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: lineupId,
        startsAt: at.toISOString(),
        targetedSlotId: slot.id,
        firstName: "First", lastName: "Taker",
        email: `f-${randomToken(6)}@test.local`,
      });
    expect([200, 201]).toContain(first.status);

    // The SAME slot is now gone for the retwist too - one row, one capacity.
    const second = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: retwistId,
        startsAt: at.toISOString(),
        targetedSlotId: slot.id,
        firstName: "Second", lastName: "Taker",
        email: `s-${randomToken(6)}@test.local`,
      });
    expect(second.status).toBe(409);

    // And it disappears from BOTH services on the public day view.
    const key = at.toISOString().slice(0, 10);
    const day = await request(app).get(`/api/book/${slug}/day?date=${key}`);
    const svcs = [
      ...(day.body.bundles ?? []).flatMap(
        (b: { services: DaySvc[] }) => b.services,
      ),
      ...(day.body.ungrouped ?? []),
    ] as DaySvc[];
    for (const id of [retwistId, lineupId]) {
      const still = svcs
        .find((s) => s.id === id)
        ?.slots.find((x) => x.targeted?.label === "One and done");
      expect(still, `still offered under ${id} after being booked`).toBeFalsy();
    }
  });

  it("refuses a service the slot is NOT listed under", async () => {
    const at = tomorrowAt(14);
    await publish({
      staffId,
      serviceId: retwistId,
      serviceIds: [retwistId, lineupId],
      startsAt: at.toISOString(),
      durationMin: 30,
      price: 70,
    });
    const slot = await slotAt(at);

    // Fade is a real service in this shop, just not on this slot.
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: fadeId,
        startsAt: at.toISOString(),
        targetedSlotId: slot.id,
        firstName: "Wrong", lastName: "Service",
        email: `w-${randomToken(6)}@test.local`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
  });
});

describe("recurrence", () => {
  it("copies the service set onto every materialized week", async () => {
    const at = tomorrowAt(16);
    const res = await publish({
      staffId,
      serviceId: retwistId,
      serviceIds: [retwistId, lineupId],
      startsAt: at.toISOString(),
      durationMin: 30,
      price: 80,
      label: "Weekly pair",
      repeatWeeks: 3,
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(4); // this week + 3

    const rows = await prisma.targetedSlot.findMany({
      where: { shopId, label: "Weekly pair" },
      select: { id: true, serviceId: true, services: { select: { serviceId: true } } },
    });
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(slotServiceIds(r).sort()).toEqual([retwistId, lineupId].sort());
    }
  });
});

describe("the backfill", () => {
  it("is idempotent - re-running it creates no duplicate listings", async () => {
    // The migration's INSERT ... ON CONFLICT DO NOTHING, run again. A second
    // deploy (or a re-applied migration) must not double-list anything.
    const db = forShop(shopId);
    const before = await db.targetedSlotService.findMany({ select: { id: true } });
    await prisma.$executeRawUnsafe(`
      INSERT INTO "TargetedSlotService" ("id", "shopId", "slotId", "serviceId", "createdAt")
      SELECT gen_random_uuid()::text, t."shopId", t."id", t."serviceId", now()
      FROM "TargetedSlot" t WHERE t."shopId" = '${shopId}'
      ON CONFLICT ("slotId", "serviceId") DO NOTHING;
    `);
    const after = await db.targetedSlotService.findMany({ select: { id: true } });
    expect(after.length).toBe(before.length);
  });

  it("leaves a slot with no join rows behaving as its single service", async () => {
    // Belt-and-braces for any row predating the backfill: slotServiceIds falls
    // back to serviceId, so it stays listed exactly where it always was.
    expect(slotServiceIds({ serviceId: fadeId, services: [] })).toEqual([fadeId]);
    expect(slotServiceIds({ serviceId: fadeId })).toEqual([fadeId]);
  });
});

interface DaySvc {
  id: string;
  slots: {
    startsAt: string;
    targeted?: { id: string; price: number; label: string | null };
  }[];
}
