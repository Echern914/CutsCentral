import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * PUT /api/booking/services/order - the barber's menu order, saved whole
 * (Snow: "an ability to move services up and down so retyping them doesn't get
 * a lil crazy").
 *
 * The order he sets has to be the order clients see, so this follows it past
 * the dashboard to the public booking page: the menu (GET /api/book/:slug),
 * the day view (/day - the layout every shop now uses) and new services added
 * after a reorder.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let slug: string;
let otherCookie: string;
let otherServiceId: string;
let staffId: string;
const ids: Record<string, string> = {};

async function signup(name: string): Promise<string> {
  const email = `svcorder-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function addService(c: string, name: string): Promise<string> {
  const r = await request(app)
    .post("/api/booking/services")
    .set("Cookie", c)
    .send({ name, durationMin: 30, price: 30, offeredByAll: true });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

/** The Services tab's list: active services, in the order GET returns them. */
async function dashboardOrder(): Promise<string[]> {
  const r = await request(app).get("/api/booking/services").set("Cookie", cookie);
  expect(r.status).toBe(200);
  return (r.body.services as { name: string; active: boolean }[])
    .filter((s) => s.active)
    .map((s) => s.name);
}

function putOrder(order: string[], c = cookie) {
  return request(app).put("/api/booking/services/order").set("Cookie", c).send({ ids: order });
}

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  cookie = await signup("Snow");
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Cut By Snow ${randomToken(4)}`, smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  slug = shop.body.slug;
  await prisma.shop.update({
    where: { id: shopId },
    data: { timezone: "UTC", bookingMode: "native", publicPageEnabled: true },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Snow" }, select: { id: true } })).id;
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 0, endMin: 24 * 60 },
    });
  }
  for (const name of ["Haircut", "Beard", "Kids Cut", "Lineup"]) {
    ids[name] = await addService(cookie, name);
  }

  otherCookie = await signup("Someone Else");
  await request(app)
    .post("/api/shops")
    .set("Cookie", otherCookie)
    .send({ name: `Other Shop ${randomToken(4)}`, smsAttested: true });
  otherServiceId = await addService(otherCookie, "Not Yours");
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

describe("PUT /api/booking/services/order", () => {
  it("saves the whole order, answers with it, and the Services tab lists it", async () => {
    expect(await dashboardOrder()).toEqual(["Haircut", "Beard", "Kids Cut", "Lineup"]);
    const order = [ids.Lineup!, ids.Haircut!, ids["Kids Cut"]!, ids.Beard!];
    const r = await putOrder(order);
    expect(r.status).toBe(200);
    expect(r.body.services).toEqual(order.map((id, i) => ({ id, sortOrder: i })));
    expect(await dashboardOrder()).toEqual(["Lineup", "Haircut", "Kids Cut", "Beard"]);
  });

  it("🔴 refuses another shop's service id and writes nothing", async () => {
    const before = await dashboardOrder();
    const r = await putOrder([otherServiceId, ids.Haircut!, ids.Beard!, ids["Kids Cut"]!, ids.Lineup!]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unknown_service");
    expect(await dashboardOrder()).toEqual(before);
    // ...and the other shop's service was not touched either.
    const other = await prisma.service.findUnique({ where: { id: otherServiceId } });
    expect(other?.sortOrder).toBe(0);
    // Nor can the other shop reorder this one's menu.
    const cross = await putOrder([ids.Beard!, ids.Haircut!, ids["Kids Cut"]!, ids.Lineup!], otherCookie);
    expect(cross.status).toBe(400);
    expect(await dashboardOrder()).toEqual(before);
  });

  it("refuses a partial list (a stale tab) and a duplicated id, writing nothing", async () => {
    const before = await dashboardOrder();
    const partial = await putOrder([ids.Beard!, ids.Haircut!, ids.Lineup!]);
    expect(partial.status).toBe(400);
    expect(partial.body.error).toBe("incomplete_list");

    const dup = await putOrder([ids.Beard!, ids.Beard!, ids.Haircut!, ids["Kids Cut"]!, ids.Lineup!]);
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe("duplicate_service");

    const empty = await putOrder([]);
    expect(empty.status).toBe(400);
    expect(await dashboardOrder()).toEqual(before);
  });

  it("refuses a removed service: the list is the services he can see", async () => {
    const gone = await addService(cookie, "Retired");
    await request(app).delete(`/api/booking/services/${gone}`).set("Cookie", cookie);
    const r = await putOrder([gone, ids.Lineup!, ids.Haircut!, ids["Kids Cut"]!, ids.Beard!]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unknown_service");
  });

  it("a service added after a reorder goes to the END, not under the first one", async () => {
    ids.Shave = await addService(cookie, "Shave");
    expect(await dashboardOrder()).toEqual(["Lineup", "Haircut", "Kids Cut", "Beard", "Shave"]);
  });
});

describe("the booking page follows the order", () => {
  it("lists the menu in the saved order", async () => {
    const order = [ids.Beard!, ids.Shave!, ids.Haircut!, ids.Lineup!, ids["Kids Cut"]!];
    expect((await putOrder(order)).status).toBe(200);
    const page = await request(app).get(`/api/book/${slug}`);
    expect(page.status).toBe(200);
    expect((page.body.services as { name: string }[]).map((s) => s.name)).toEqual([
      "Beard",
      "Shave",
      "Haircut",
      "Lineup",
      "Kids Cut",
    ]);
  });

  it("🔴 the day view's ungrouped list follows it too, even for a service that once sat in a group", async () => {
    // A group claims Lineup at position 3, then lets it go: release clears
    // serviceGroupId but leaves groupSortOrder at 3. The day view used to sort
    // by groupSortOrder FIRST, so Lineup sank to the bottom of "More services"
    // whatever order the barber set.
    const g = await request(app)
      .post("/api/booking/groups")
      .set("Cookie", cookie)
      .send({ name: "Temp", serviceIds: [ids.Beard!, ids.Shave!, ids.Haircut!, ids.Lineup!] });
    expect(g.status).toBe(201);
    await request(app)
      .patch(`/api/booking/groups/${g.body.id}`)
      .set("Cookie", cookie)
      .send({ serviceIds: [] });
    const lineup = await prisma.service.findUnique({ where: { id: ids.Lineup! } });
    expect(lineup?.serviceGroupId).toBeNull();
    expect(lineup?.groupSortOrder).toBe(3);

    const order = [ids.Lineup!, ids.Beard!, ids["Kids Cut"]!, ids.Haircut!, ids.Shave!];
    expect((await putOrder(order)).status).toBe(200);
    const day = await request(app).get(`/api/book/${slug}/day?date=${tomorrow}`);
    expect(day.status).toBe(200);
    expect(day.body.bundles).toEqual([]);
    expect((day.body.ungrouped as { name: string }[]).map((s) => s.name)).toEqual([
      "Lineup",
      "Beard",
      "Kids Cut",
      "Haircut",
      "Shave",
    ]);
  });

  it("inside a group, the group's own order still wins", async () => {
    // Group order: Shave, Beard. Menu order puts Beard first.
    const g = await request(app)
      .post("/api/booking/groups")
      .set("Cookie", cookie)
      .send({ name: "Face", serviceIds: [ids.Shave!, ids.Beard!] });
    expect(g.status).toBe(201);
    const day = await request(app).get(`/api/book/${slug}/day?date=${tomorrow}`);
    expect(day.status).toBe(200);
    const face = (day.body.bundles as { name: string; services: { name: string }[] }[]).find(
      (b) => b.name === "Face",
    );
    expect(face?.services.map((s) => s.name)).toEqual(["Shave", "Beard"]);
    expect((day.body.ungrouped as { name: string }[]).map((s) => s.name)).toEqual([
      "Lineup",
      "Kids Cut",
      "Haircut",
    ]);
  });
});
