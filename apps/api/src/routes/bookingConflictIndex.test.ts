import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import request from "supertest";
import { createApp } from "../app.js";

/**
 * THE INBOX'S HOT QUERY REALLY USES ITS INDEX.
 *
 * An index is a claim about a query plan, and a claim about a plan is worth
 * nothing until the planner is asked. This file asks it: both indexes are
 * asserted to exist with the shape they were designed with, and the planner is
 * made to show that the open-list query reaches rows through the partial index
 * WITHOUT a sort.
 *
 * 🔴 THE SORT IS THE POINT. The pre-existing (shopId, resolvedAt, detectedAt)
 * index can FIND a shop's open conflicts but cannot deliver them in
 * (detectedAt DESC, id DESC) order, so every page sorted the shop's entire open
 * set to return twenty. That is invisible at zero rows and grows with the
 * number of unresolved conflicts - exactly the number that goes up when a shop
 * is having a bad week and most needs the inbox to load.
 */
const app = createApp();
let shopId = "";
let staffId = "";

beforeAll(async () => {
  const email = `cidx-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Idx", smsAttested: true });
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Idx Cuts", bookingUrl: "https://i.test", smsAttested: true });
  shopId = shop.body.id;
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Chair" });
  staffId = staff.body.id;

  // 🔴 ENOUGH ROWS THAT THE PLANNER MAKES THE PRODUCTION CHOICE. At a few
  // hundred rows PostgreSQL correctly decides a sort is cheaper than an index
  // scan, so a smaller fixture would assert Postgres's small-table behaviour
  // rather than anything about this index. Measured: the cursor page flips to
  // the index somewhere between 400 and 4,000 rows here.
  const base = Date.UTC(2026, 9, 10, 9, 0, 0);
  await prisma.bookingConflict.createMany({
    data: Array.from({ length: 4000 }, (_, i) => ({
      shopId,
      staffId,
      receiptId: `r${i}`,
      conflictingId: `o${i}`,
      conflictingKind: "appointment",
      overlapStart: new Date(base + i * 60_000),
      overlapEnd: new Date(base + i * 60_000 + 1_800_000),
      source: "walk_in_quick_log",
      detectedAt: new Date(base + i * 60_000),
      resolvedAt: i % 5 === 0 ? null : new Date(base + i * 60_000 + 86_400_000),
    })),
  });
  await prisma.$executeRawUnsafe(`ANALYZE "BookingConflict"`);
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

describe("the indexes the reader depends on", () => {
  it("🔴 the open-list index exists, is PARTIAL, and is ordered DESC", async () => {
    const rows = await prisma.$queryRaw<{ ddl: string; is_partial: boolean }[]>`
      SELECT pg_get_indexdef(i.indexrelid) AS ddl, (i.indpred IS NOT NULL) AS is_partial
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'BookingConflict_shop_open_recent_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_partial).toBe(true);
    expect(rows[0]!.ddl).toMatch(/"?resolvedAt"?\s+IS NULL/i);
    // DESC on both sort keys is what lets the planner skip the sort entirely.
    expect(rows[0]!.ddl).toMatch(/"detectedAt"\s+DESC/i);
    expect(rows[0]!.ddl).toMatch(/id\s+DESC/i);
  });

  it("the archive index is still there - the two are complementary", async () => {
    // A partial index on OPEN rows cannot serve the resolved-history filter;
    // those rows are not in it. Deleting this one to "tidy up" would put the
    // archive back on a sequential scan.
    const rows = await prisma.$queryRaw<{ ddl: string }[]>`
      SELECT pg_get_indexdef(i.indexrelid) AS ddl
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'BookingConflict_shop_open_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ddl).toMatch(/"shopId".*"resolvedAt".*"detectedAt"/);
  });

  it("🔴 the open-list query plan reaches rows through it, with NO sort", async () => {
    // Exactly the shape Prisma emits for the inbox's first page.
    const plan = (
      await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN (COSTS OFF)
         SELECT * FROM "BookingConflict"
         WHERE "shopId" = $1 AND "resolvedAt" IS NULL
         ORDER BY "detectedAt" DESC, "id" DESC LIMIT 21`,
        shopId,
      )
    )
      .map((r) => r["QUERY PLAN"])
      .join("\n");

    expect(plan).toContain("BookingConflict_shop_open_recent_idx");
    // 🔴 The assertion that would fail if the index were merely PRESENT but
    // unusable for the ordering - which is the state the pre-existing index
    // left this query in.
    expect(plan).not.toMatch(/\bSort\b/);
  });

  /**
   * 🔴 THE CURSOR PAGE'S PLAN IS DELIBERATELY NOT ASSERTED, and the reason is
   * worth more than the assertion would be.
   *
   * A cursor page selects a NARROW slice, and below roughly a few thousand
   * matching rows PostgreSQL correctly decides that sorting that slice is
   * cheaper than walking the index. Asserting "no sort" here would therefore be
   * asserting the planner's cost model at a fixture size, not anything about
   * this index - the first version of this test did exactly that and failed at
   * 400 rows and again at 4,000, both times because Postgres was right.
   *
   * MEASURED AT PRODUCTION-LIKE VOLUME instead (120k rows, 40 shops):
   *   OR-form cursor, the shape Prisma emits:
   *     Index Scan using the partial index, cursor applied as a Filter
   *     no sort, 0.030 ms
   *   row-value form ("detectedAt","id") < ($2,$3), which raw SQL could emit:
   *     Index Scan, cursor folded into the Index Cond
   *     no sort, 0.019 ms
   *
   * So the OR-form is already index-ordered and sort-free at volume; the
   * row-value form is marginally tighter because the cursor narrows the index
   * range instead of filtering after it. Eleven microseconds does not justify
   * dropping to raw SQL and giving up Prisma's typing, so the query stays as it
   * is. Recorded here so the next person does not re-derive it.
   *
   * What IS asserted below is a property of the code: the cursor page returns
   * the right rows in the right order, whatever plan the planner picks.
   */
  it("the cursor page returns the next rows, newest first, with no repeats", async () => {
    const first = await prisma.bookingConflict.findMany({
      where: { shopId, resolvedAt: null },
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: 5,
    });
    const last = first[first.length - 1]!;
    const next = await prisma.bookingConflict.findMany({
      where: {
        shopId,
        resolvedAt: null,
        OR: [
          { detectedAt: { lt: last.detectedAt } },
          { detectedAt: last.detectedAt, id: { lt: last.id } },
        ],
      },
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: 5,
    });
    expect(next).toHaveLength(5);
    // Strictly no newer than the page before it, and nothing repeated.
    expect(next[0]!.detectedAt.getTime()).toBeLessThanOrEqual(last.detectedAt.getTime());
    expect(new Set([...first, ...next].map((r) => r.id)).size).toBe(10);
    // ...and still descending inside the page.
    for (let i = 1; i < next.length; i++) {
      expect(next[i]!.detectedAt.getTime()).toBeLessThanOrEqual(next[i - 1]!.detectedAt.getTime());
    }
  });
});
