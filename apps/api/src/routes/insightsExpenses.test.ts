import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * SHOP EXPENSES + the Insights take-home ESTIMATE.
 *
 *   /api/insights/expenses     CRUD, OWNER/MANAGER only, shop-scoped
 *   GET /api/insights          gains `expenses` and `takeHomeCents`
 *
 * Take-home = the page's own revenue (readChairEvents) minus the expenses that
 * fall in the SAME shop-local window. The shop here is New York, so a window's
 * edges are not UTC midnights - a visit at 02:00 UTC on Jun 1 is May 31 at
 * 10 PM in the shop, and belongs to May on both sides of the subtraction.
 *
 * 🔴 TIME IS FROZEN at a fixed PAST instant (Wednesday mid-June, midday in New
 * York) so every window here is a fixed set of calendar days and nothing in
 * this file can go red on the real calendar.
 */

const FROZEN_NOW = new Date("2026-06-17T16:00:00.000Z");
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

let ownerCookie = "";
let managerCookie = "";
let barberCookie = "";
let otherCookie = "";
let shopId = "";
let otherShopId = "";

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

async function makeShop(cookie: string, name: string, timezone: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  shopIds.push(id);
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone });
  expect(patch.status).toBe(200);
  return id;
}

const list = (cookie: string) => request(app).get("/api/insights/expenses").set("Cookie", cookie);
const create = (cookie: string, body: Record<string, unknown>) =>
  request(app).post("/api/insights/expenses").set("Cookie", cookie).send(body);
const replace = (cookie: string, id: string, body: Record<string, unknown>) =>
  request(app).put(`/api/insights/expenses/${id}`).set("Cookie", cookie).send(body);
const archive = (cookie: string, id: string) =>
  request(app).delete(`/api/insights/expenses/${id}`).set("Cookie", cookie);
const insights = (cookie: string, query: string) =>
  request(app).get(`/api/insights?${query}`).set("Cookie", cookie);

const RENT = { category: "rent", label: "Chair rent", amountCents: 120_000, cadence: "monthly", startDate: "2026-01-31" };
const PRODUCT = { category: "products", label: "Pomade restock", amountCents: 8_450, cadence: "once", startDate: "2026-05-10" };

/** A completed, priced visit at an exact UTC instant (no in-app money: earned = price). */
async function visitAt(shop: string, iso: string, price: number) {
  const client = await prisma.client.create({
    data: { shopId: shop, acuityClientKey: `exp-${randomToken(8)}`, magicToken: randomToken(), firstName: "Regular" },
    select: { id: true },
  });
  await prisma.visit.create({
    data: {
      shopId: shop,
      clientId: client.id,
      acuityAppointmentId: `exp-${randomToken(8)}`,
      status: "COMPLETED",
      scheduledAt: new Date(iso),
      endAt: new Date(new Date(iso).getTime() + 30 * 60_000),
      completedAt: new Date(iso),
      price,
    },
  });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  const owner = await signup("expenses-owner");
  ownerCookie = owner.cookie;
  shopId = await makeShop(ownerCookie, `Expense Cuts ${randomToken(4)}`, "America/New_York");

  const manager = await signup("expenses-manager");
  managerCookie = manager.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: manager.userId, role: "MANAGER" } });
  const barber = await signup("expenses-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER" } });

  const other = await signup("expenses-other");
  otherCookie = other.cookie;
  otherShopId = await makeShop(otherCookie, `Other Expense ${randomToken(4)}`, "America/New_York");
});

afterAll(async () => {
  vi.useRealTimers();
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

describe("CRUD", () => {
  it("adds, lists, replaces and archives an expense", async () => {
    const made = await create(ownerCookie, { ...RENT, label: "  Booth  " });
    expect(made.status).toBe(201);
    expect(made.body.expense).toMatchObject({
      category: "rent",
      label: "Booth", // trimmed
      amountCents: 120_000,
      cadence: "monthly",
      startDate: "2026-01-31",
      endDate: null,
    });
    const id = made.body.expense.id as string;

    const row = await prisma.shopExpense.findUnique({ where: { id } });
    expect(row?.shopId).toBe(shopId);
    expect(row?.createdByUserId).toBeTruthy();

    const listed = await list(ownerCookie);
    expect(listed.body.expenses.map((e: { id: string }) => e.id)).toContain(id);
    // The shop's calendar day (frozen 12:00 New York), for the form's default.
    expect(listed.body.today).toBe("2026-06-17");

    const put = await replace(ownerCookie, id, { ...RENT, amountCents: 125_000, label: "", endDate: "2026-12-31" });
    expect(put.status).toBe(200);
    expect(put.body.expense).toMatchObject({ amountCents: 125_000, label: null, endDate: "2026-12-31" });

    expect((await archive(ownerCookie, id)).status).toBe(200);
    expect((await list(ownerCookie)).body.expenses.map((e: { id: string }) => e.id)).not.toContain(id);
    // Soft delete: the row stays, stamped.
    expect((await prisma.shopExpense.findUnique({ where: { id } }))?.archivedAt).toBeInstanceOf(Date);
    // Archived is final from the API's side: no second archive, no edit.
    expect((await archive(ownerCookie, id)).status).toBe(404);
    expect((await replace(ownerCookie, id, RENT)).status).toBe(404);
  });

  it("refuses what the form must never send", async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ ...RENT, amountCents: 0 }, "amountCents_invalid"],
      [{ ...RENT, amountCents: -500 }, "amountCents_invalid"],
      [{ ...RENT, amountCents: 10_000_001 }, "amountCents_invalid"],
      [{ ...RENT, amountCents: 12.5 }, "amountCents_invalid"],
      [{ ...RENT, category: "booth" }, "category_invalid"],
      [{ ...RENT, cadence: "yearly" }, "cadence_invalid"],
      [{ ...RENT, startDate: "2026-02-30" }, "date_invalid"],
      [{ ...RENT, startDate: "2026-06-17T00:00:00Z" }, "date_invalid"],
      [{ ...RENT, startDate: "1999-01-01" }, "date_out_of_range"],
      [{ ...RENT, endDate: "2026-01-30" }, "end_before_start"],
      [{ ...PRODUCT, endDate: "2026-06-01" }, "once_has_no_end"],
      [{ ...RENT, label: "x".repeat(81) }, "label_invalid"],
      [{ ...RENT, shopId: "someone-else" }, "invalid_input"], // strict: no smuggled fields
    ];
    for (const [body, error] of bad) {
      const res = await create(ownerCookie, body);
      expect({ body, status: res.status, error: res.body.error }).toEqual({ body, status: 400, error });
    }
  });

  it("the database refuses what the route would, too", async () => {
    const base = { shopId, category: "rent", amountCents: 100, cadence: "monthly", startDate: new Date("2026-01-01T00:00:00Z") };
    await expect(prisma.shopExpense.create({ data: { ...base, amountCents: 0 } })).rejects.toThrow();
    await expect(prisma.shopExpense.create({ data: { ...base, category: "booth" } })).rejects.toThrow();
    await expect(prisma.shopExpense.create({ data: { ...base, cadence: "daily" } })).rejects.toThrow();
    await expect(
      prisma.shopExpense.create({ data: { ...base, endDate: new Date("2025-12-31T00:00:00Z") } }),
    ).rejects.toThrow();
    await expect(
      prisma.shopExpense.create({ data: { ...base, cadence: "once", endDate: new Date("2026-02-01T00:00:00Z") } }),
    ).rejects.toThrow();
  });
});

describe("who may", () => {
  it("a MANAGER may add and archive", async () => {
    const made = await create(managerCookie, PRODUCT);
    expect(made.status).toBe(201);
    expect((await archive(managerCookie, made.body.expense.id)).status).toBe(200);
  });

  it("🔴 a BARBER seat may not read or write expenses", async () => {
    expect((await list(barberCookie)).status).toBe(403);
    expect((await create(barberCookie, PRODUCT)).status).toBe(403);
    const mine = await create(ownerCookie, PRODUCT);
    expect((await replace(barberCookie, mine.body.expense.id, RENT)).status).toBe(403);
    expect((await archive(barberCookie, mine.body.expense.id)).status).toBe(403);
    expect((await prisma.shopExpense.findUnique({ where: { id: mine.body.expense.id } }))?.archivedAt).toBeNull();
    await archive(ownerCookie, mine.body.expense.id);
  });

  it("signed out is 401", async () => {
    expect((await request(app).get("/api/insights/expenses")).status).toBe(401);
  });
});

describe("🔴 one shop can never see or touch another shop's expenses", () => {
  it("lists only its own, and another shop's id is a 404 that changes nothing", async () => {
    const mine = await create(ownerCookie, { ...PRODUCT, label: "Shop A only" });
    expect(mine.status).toBe(201);
    const id = mine.body.expense.id as string;

    const theirs = await list(otherCookie);
    expect(theirs.status).toBe(200);
    expect(theirs.body.expenses.map((e: { id: string }) => e.id)).not.toContain(id);

    expect((await replace(otherCookie, id, { ...PRODUCT, amountCents: 1 })).status).toBe(404);
    expect((await archive(otherCookie, id)).status).toBe(404);
    const row = await prisma.shopExpense.findUnique({ where: { id } });
    expect(row).toMatchObject({ shopId, amountCents: PRODUCT.amountCents, archivedAt: null });

    await archive(ownerCookie, id);
  });
});

describe("Insights: expenses and take-home for the page's window", () => {
  let archivedId = "";

  beforeAll(async () => {
    // Shop A: rent $1,200 monthly from Jan 31 (clamps to May 31), $84.50 of
    // product on May 10, a June 1 supply run (outside May), and an archived
    // $9.99 that must count nowhere.
    expect((await create(ownerCookie, RENT)).status).toBe(201);
    expect((await create(ownerCookie, PRODUCT)).status).toBe(201);
    expect(
      (await create(ownerCookie, { category: "supplies", amountCents: 2_000, cadence: "once", startDate: "2026-06-01" })).status,
    ).toBe(201);
    const gone = await create(ownerCookie, { category: "other", amountCents: 999, cadence: "once", startDate: "2026-05-15" });
    archivedId = gone.body.expense.id as string;
    expect((await archive(ownerCookie, archivedId)).status).toBe(200);

    // Shop B spends a fortune in May. None of it is shop A's.
    expect(
      (await create(otherCookie, { category: "rent", amountCents: 5_000_000, cadence: "once", startDate: "2026-05-20" })).status,
    ).toBe(201);

    // Revenue in May (shop time): $100 mid-month, and $50 at 02:00 UTC Jun 1,
    // which is 10 PM May 31 in New York.
    await visitAt(shopId, "2026-05-15T16:00:00.000Z", 100);
    await visitAt(shopId, "2026-06-01T02:00:00.000Z", 50);
    // And $40 on Jun 1 shop time - outside May.
    await visitAt(shopId, "2026-06-01T16:00:00.000Z", 40);
  });

  it("a custom month: rent clamped to the 31st, the product, nothing archived, nothing of shop B's", async () => {
    const res = await insights(ownerCookie, "period=custom&from=2026-05-01&to=2026-05-31");
    expect(res.status).toBe(200);
    expect(res.body.windowStart).toBe("2026-05-01");
    expect(res.body.windowEnd).toBe("2026-05-31");
    expect(res.body.totals.revenue).toBe(150);
    expect(res.body.expenses).toEqual({
      totalCents: 120_000 + 8_450,
      byCategory: { rent: 120_000, products: 8_450, supplies: 0, other: 0 },
    });
    // Negative, and reported as negative.
    expect(res.body.takeHomeCents).toBe(15_000 - 128_450);
  });

  it("a preset window ending today (May 19 - Jun 17): rent on May 31, the Jun 1 supplies, not May 10", async () => {
    const res = await insights(ownerCookie, "period=30d");
    expect(res.status).toBe(200);
    expect(res.body.windowStart).toBe("2026-05-19");
    expect(res.body.windowEnd).toBe("2026-06-17");
    expect(res.body.expenses.byCategory).toEqual({ rent: 120_000, products: 0, supplies: 2_000, other: 0 });
    expect(res.body.totals.revenue).toBe(90);
    expect(res.body.takeHomeCents).toBe(9_000 - 122_000);
  });

  it("the other shop's page sees only its own spend", async () => {
    const res = await insights(otherCookie, "period=custom&from=2026-05-01&to=2026-05-31");
    expect(res.status).toBe(200);
    expect(res.body.expenses.totalCents).toBe(5_000_000);
    expect(res.body.totals.revenue).toBe(0);
    expect(res.body.takeHomeCents).toBe(-5_000_000);
  });

  it("no expenses: take-home is just revenue, in cents", async () => {
    const res = await insights(ownerCookie, "period=custom&from=2026-04-01&to=2026-04-29");
    expect(res.status).toBe(200);
    expect(res.body.expenses.totalCents).toBe(0);
    expect(res.body.takeHomeCents).toBe(0);
  });
});
