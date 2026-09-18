import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, Prisma } from "@chairback/db";
import request from "supertest";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * WHAT THE IDEMPOTENCY INDEX ACTUALLY DOES, ASKED OF THE ENGINE.
 *
 * 🔴 THIS FILE EXISTS BECAUSE A COMMENT HERE WAS WRONG. The migration used to
 * claim the partial predicate was REQUIRED - that a plain unique index "cannot
 * be created at all" over the existing rows, because every one of them has a
 * NULL operationId. That is not how PostgreSQL works: NULLs are DISTINCT in a
 * unique index by default, so a plain index would have accepted all of them
 * happily. Measured on PG 17: the plain index built over 350 NULL rows, and a
 * 351st still inserted.
 *
 * The partial predicate is still right, for reasons that survive contact with
 * the engine - it indexes only rows that can participate in idempotency, it
 * states the scope instead of leaning on NULL semantics, and it does not depend
 * on NULLs-are-distinct remaining the default (NULLS NOT DISTINCT is a
 * per-index choice since PG 15). None of those are "it would not build".
 *
 * So the rule this file enforces is: the CONSTRAINT is proved by behaviour, and
 * the reasons written beside it have to be the real ones. Three behaviours,
 * against the real schema on the real engine:
 *   1. legacy rows with NULL operationId coexist without limit;
 *   2. two rows with the same operation id in one shop cannot both exist;
 *   3. the same operation id in a DIFFERENT shop is a different receipt.
 */
const app = createApp();

let shopA = "";
let shopB = "";
let staffA = "";
let staffB = "";
let serviceA = "";
let serviceB = "";

async function makeShop(label: string) {
  const email = `nullsem-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://n.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Chair" });
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staff.body.id] });
  return {
    shopId: shop.body.id as string,
    staffId: staff.body.id as string,
    serviceId: svc.body.id as string,
  };
}

beforeAll(async () => {
  const a = await makeShop("Null Semantics A");
  const b = await makeShop("Null Semantics B");
  shopA = a.shopId;
  staffA = a.staffId;
  serviceA = a.serviceId;
  shopB = b.shopId;
  staffB = b.staffId;
  serviceB = b.serviceId;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
});

/** A walk-in-shaped receipt, written straight in so the index is what answers. */
function receipt(
  shopId: string,
  staffId: string,
  serviceId: string,
  operationId: string | null,
  minuteOffset: number,
) {
  const startsAt = new Date(Date.UTC(2026, 9, 2, 10, minuteOffset, 0));
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Walk-in",
      status: "COMPLETED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
      ...(operationId ? { operationId } : {}),
    },
    select: { id: true, operationId: true },
  });
}

describe("the receipt idempotency index, as the database actually enforces it", () => {
  it("🔴 accepts UNLIMITED legacy rows with a NULL operationId", async () => {
    // The production shape on the day this ships: 274 appointments, every one
    // of them NULL. If the index constrained NULLs, this is where it would
    // break - and this is exactly what the old comment claimed would happen.
    const made = [];
    for (let i = 0; i < 12; i++) {
      made.push(await receipt(shopA, staffA, serviceA, null, i));
    }
    expect(made).toHaveLength(12);
    expect(made.every((r) => r.operationId === null)).toBe(true);

    const nulls = await prisma.appointment.count({
      where: { shopId: shopA, operationId: null },
    });
    expect(nulls).toBeGreaterThanOrEqual(12);
  });

  it("🔴 REFUSES a second row with the same operation id in the same shop", async () => {
    const opId = `op-${randomToken(10)}`;
    const first = await receipt(shopA, staffA, serviceA, opId, 20);
    expect(first.operationId).toBe(opId);

    await expect(receipt(shopA, staffA, serviceA, opId, 25)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002",
    );

    // Exactly one survived. This is the wall the route's P2002 branch replays
    // behind; without it two retries would both become receipts.
    expect(
      await prisma.appointment.count({ where: { shopId: shopA, operationId: opId } }),
    ).toBe(1);
  });

  it("scopes to the TENANT: the same operation id in another shop is its own receipt", async () => {
    // Operation ids are minted by a client, not by us - two shops can pick the
    // same string, and neither may swallow the other's money. The scope is
    // (shopId, operationId) for exactly this reason.
    const opId = `op-${randomToken(10)}`;
    const a = await receipt(shopA, staffA, serviceA, opId, 40);
    const b = await receipt(shopB, staffB, serviceB, opId, 40);
    expect(a.id).not.toBe(b.id);
    expect(
      await prisma.appointment.count({ where: { operationId: opId } }),
    ).toBe(2);
  });

  it("the index really is PARTIAL, and covers only rows that carry an id", async () => {
    // Read the catalog rather than trust the migration file: `indpred` is set
    // only for a partial index, and this is the fact the whole design rests on.
    const rows = await prisma.$queryRaw<
      { indexdef: string; is_partial: boolean }[]
    >`
      SELECT pg_get_indexdef(i.indexrelid) AS indexdef,
             (i.indpred IS NOT NULL)      AS is_partial
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'Appointment_shop_operation_key'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_partial).toBe(true);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/i);
    expect(rows[0]!.indexdef).toMatch(/"?operationId"?\s+IS NOT NULL/i);
    // 🔴 And NOT the thing that would break the legacy rows. If a future
    // migration ever adds this, every NULL row collides at once.
    expect(rows[0]!.indexdef).not.toMatch(/NULLS NOT DISTINCT/i);
  });
});
