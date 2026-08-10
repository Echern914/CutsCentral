import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * DELETE /api/booking/exceptions/:id — giving a blocked day back.
 *
 * Blocking time was always one tap; removing it was impossible anywhere in the
 * app. The endpoint existed and was correct, but nothing ever called it, so a
 * barber who blocked a day off could not undo it — the hours stayed dead.
 *
 * The test that matters is the ROUND TRIP: block a day, watch the booking get
 * refused, unblock it, and watch the SAME booking succeed. Asserting only that
 * the row disappears would pass even if the freed hours never became bookable
 * again.
 */
const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

/** A fixed hour on a day `daysAhead` out — always future, never clock-flaky. */
function at(daysAhead: number, hour: number): Date {
  const d = new Date(Date.now() + daysAhead * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0, 0));
}

async function makeShop(label: string) {
  const email = `unblock-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Unblock", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://u.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;

  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 },
  });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: service.id, staffId: staff.id },
  });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId: staff.id,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
  return {
    cookie,
    shopId,
    slug: me.body.slug as string,
    staffId: staff.id,
    serviceId: service.id,
  };
}

/** Block a whole day (local midnight to next midnight) and return its id. */
async function blockDay(
  s: Awaited<ReturnType<typeof makeShop>>,
  daysAhead: number,
): Promise<string> {
  const res = await request(app)
    .post(`/api/booking/staff/${s.staffId}/exceptions`)
    .set("Cookie", s.cookie)
    .send({
      startsAt: at(daysAhead, 0).toISOString(),
      endsAt: at(daysAhead + 1, 0).toISOString(),
      isBlock: true,
      reason: "Day off",
    });
  expect(res.status).toBe(201);
  const row = await prisma.availabilityException.findFirst({
    where: { staffId: s.staffId, isBlock: true, startsAt: at(daysAhead, 0) },
    select: { id: true },
  });
  return row!.id;
}

function book(s: Awaited<ReturnType<typeof makeShop>>, when: Date) {
  return request(app).post(`/api/book/${s.slug}`).send({
    staffId: s.staffId,
    serviceId: s.serviceId,
    startsAt: when.toISOString(),
    firstName: "Pat",
    lastName: "Rivera",
    phone: "(302) 555-0900",
  });
}

let S: Awaited<ReturnType<typeof makeShop>>;

beforeAll(async () => {
  S = await makeShop("Unblock Cuts");
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

describe("unblocking time", () => {
  it("gives the day back: blocked booking is refused, then succeeds after unblock", async () => {
    const id = await blockDay(S, 3);
    const slot = at(3, 10); // 10:00 on the blocked day, inside 09:00-17:00

    const refused = await book(S, slot);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_slot");

    const removed = await request(app)
      .delete(`/api/booking/exceptions/${id}`)
      .set("Cookie", S.cookie);
    expect(removed.status).toBe(200);
    expect(await prisma.availabilityException.count({ where: { id } })).toBe(0);

    // THE POINT: the same instant is bookable again. The block was a filter,
    // never a deletion, so nothing about the schedule had to be rebuilt.
    const ok = await book(S, slot);
    expect(ok.status).toBe(201);
  });

  it("the day also reappears in the public slot grid", async () => {
    const id = await blockDay(S, 4);
    const from = at(4, 0).toISOString();
    const to = at(5, 0).toISOString();
    const q = { staffId: S.staffId, serviceId: S.serviceId, from, to };

    const blocked = await request(app).get(`/api/book/${S.slug}/slots`).query(q);
    expect(blocked.status).toBe(200);
    expect(blocked.body.slots).toHaveLength(0);

    await request(app).delete(`/api/booking/exceptions/${id}`).set("Cookie", S.cookie);

    const freed = await request(app).get(`/api/book/${S.slug}/slots`).query(q);
    expect(freed.body.slots.length).toBeGreaterThan(0);
  });

  it("404s when there is nothing to remove", async () => {
    // Not 200 {ok:false}: the web layer reads the HTTP status, so the old shape
    // reported a failed delete as a success and left the block sitting there
    // while the UI said it was gone.
    const gone = await request(app)
      .delete(`/api/booking/exceptions/does-not-exist`)
      .set("Cookie", S.cookie);
    expect(gone.status).toBe(404);

    // Deleting twice is the same honest 404 the second time.
    const id = await blockDay(S, 6);
    expect((await request(app).delete(`/api/booking/exceptions/${id}`).set("Cookie", S.cookie)).status).toBe(200);
    expect((await request(app).delete(`/api/booking/exceptions/${id}`).set("Cookie", S.cookie)).status).toBe(404);
  });

  it("cannot unblock another shop's time", async () => {
    const other = await makeShop("Other Cuts");
    const theirs = await blockDay(other, 3);

    const res = await request(app)
      .delete(`/api/booking/exceptions/${theirs}`)
      .set("Cookie", S.cookie); // OUR session, THEIR block id
    expect(res.status).toBe(404);
    // Still blocked for them.
    expect(await prisma.availabilityException.count({ where: { id: theirs } })).toBe(1);
  });
});
