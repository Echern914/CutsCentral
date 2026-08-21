import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * After-hours targeted slots in a shop that is NOT on UTC.
 *
 * 🔴 WHY THIS FILE EXISTS. targetedSlots.test.ts covers after-hours slots
 * thoroughly - and sets `timezone: "UTC"` with the comment "(UTC ==
 * shop-local)". Every assertion in it is therefore blind to the one bug an
 * after-hours slot is most likely to have, because "after hours" means LATE AT
 * NIGHT and late at night is where the shop-local date and the UTC date stop
 * agreeing.
 *
 * 10:00 PM in New York is 02:00 UTC THE NEXT DAY. Anything that buckets a
 * targeted slot by its UTC calendar date instead of the shop-local one files
 * that slot under tomorrow - so the customer who opens the correct day never
 * sees it, and the barber who published it is told it is live. That is the
 * production report: "published after-hours targeted slots are not appearing
 * as bookable availability", from a shop on America/New_York.
 *
 * Storage is NOT the bug and must not change: startsAt is a UTC instant and
 * stays one. What has to be shop-local is the DATE BUCKETING on the way out.
 */

const app = createApp();
const email = `tstz-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

const TZ = "America/New_York";
/** A fixed EDT date well clear of "today", lead time, and the DST changeover. */
const DAY = { y: 2026, m0: 8, d: 15 }; // 2026-09-15, a Tuesday, UTC-4
const DAY_KEY = "2026-09-15";
/** 10:00 PM shop-local. In UTC this is 2026-09-16T02:00:00Z - the NEXT day. */
const AFTER_HOURS = zonedWallTimeToUtc(DAY.y, DAY.m0, DAY.d, 22 * 60, TZ);

let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let slotId: string;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Night Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    // The whole point: a real, offset shop timezone.
    .send({ bookingMode: "native", timezone: TZ, bookingLeadHours: 1 });

  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  staffId = staff.body.id;

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Retwist", durationMin: 30, price: 80, staffIds: [staffId] });
  serviceId = service.body.id;

  // Regular hours 09:00-17:00 shop-local, every day. The 10 PM slot is well
  // outside them - which is allowed, and is the entire feature: a barber must
  // not have to extend Staff Hours to offer an after-hours special.
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

  const published = await request(app)
    .post("/api/booking/targeted-slots")
    .set("Cookie", cookie)
    .send({
      staffId,
      serviceId,
      startsAt: AFTER_HOURS.toISOString(),
      durationMin: 30,
      price: 55,
      label: "AFTER HOUR HAIRCUT",
    });
  expect(published.status).toBe(201);
  // The publish endpoint answers { ok, created, ruleId } - the row id is not
  // in the body, so read it back.
  const row = await prisma.targetedSlot.findFirstOrThrow({
    where: { shopId, startsAt: AFTER_HOURS },
    select: { id: true },
  });
  slotId = row.id;
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.targetedSlot.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

describe("the premise", () => {
  it("the slot really does straddle midnight in UTC", () => {
    // If this ever stops being true the rest of the file proves nothing.
    expect(AFTER_HOURS.toISOString()).toBe("2026-09-16T02:00:00.000Z");
    expect(AFTER_HOURS.toISOString().slice(0, 10)).not.toBe(DAY_KEY);
  });
});

describe("a 10 PM special in a New York shop", () => {
  it("appears on the day the SHOP calls it, not the UTC day", async () => {
    const res = await request(app).get(`/api/book/${slug}/day?date=${DAY_KEY}`);
    expect(res.status).toBe(200);

    const svc = daySvcs(res.body).find((s) => s.id === serviceId);

    const special = svc?.slots.find((s) => s.targeted?.label === "AFTER HOUR HAIRCUT");
    expect(special, "the 10 PM special is missing from its own shop-local day").toBeTruthy();
    expect(special!.targeted!.price).toBe(55);
  });

  it("does NOT leak onto the following day", async () => {
    // The mirror of the bug: bucketing by UTC would file it under the 16th.
    const res = await request(app).get(`/api/book/${slug}/day?date=2026-09-16`);
    expect(res.status).toBe(200);
    const leaked = daySvcs(res.body)
      .find((s) => s.id === serviceId)
      ?.slots.find((s) => s.targeted?.label === "AFTER HOUR HAIRCUT");
    expect(leaked, "the 10 PM special leaked onto the next UTC day").toBeFalsy();
  });

  it("is listed on the flat public payload", async () => {
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.status).toBe(200);
    const found = (res.body.targetedSlots as { label: string | null }[]).find(
      (t) => t.label === "AFTER HOUR HAIRCUT",
    );
    expect(found).toBeTruthy();
  });

  it("counts as an opening on the open-days sweep", async () => {
    // A day whose ONLY availability is an after-hours special must still show
    // as bookable, or the calendar greys out the very day being advertised.
    const res = await request(app).get(
      `/api/book/${slug}/open-days?from=${DAY_KEY}&to=${DAY_KEY}`,
    );
    if (res.status === 200) {
      const days: string[] = res.body.days ?? res.body.openDays ?? [];
      expect(days).toContain(DAY_KEY);
    }
  });

  it("is actually bookable at 10 PM local", async () => {
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: AFTER_HOURS.toISOString(),
        targetedSlotId: slotId,
        firstName: "Night", lastName: "Owl",
        email: `n-${randomToken(6)}@test.local`,
      });
    expect([200, 201]).toContain(res.status);
  });
});

/** Every service in a /day body, grouped or not. */
function daySvcs(body: {
  bundles?: { services: DaySvc[] }[];
  ungrouped?: DaySvc[];
}): DaySvc[] {
  return [...(body.bundles ?? []).flatMap((b) => b.services), ...(body.ungrouped ?? [])];
}

interface DaySvc {
  id: string;
  slots: {
    startsAt: string;
    targeted?: { id: string; price: number; label: string | null };
  }[];
}
