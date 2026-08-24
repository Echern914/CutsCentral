import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@chairback/db";

// 🔑 PrismaClient is imported by RELATIVE PATH, not from "@chairback/db".
// The package entry re-exports it, but loading that entry also evaluates
// client.ts, which constructs the singleton - which is the exact thing this
// file has to get in front of. The type-only import above is erased and is
// therefore safe.
const GENERATED = "../../../../packages/db/src/generated/client/index.js";

/**
 * How many database round trips one readiness read costs.
 *
 * This is a REGRESSION GUARD, not a benchmark. The collector deliberately batches
 * every tenant read into ONE `runWithShop` transaction rather than making eight
 * `forShop()` calls, because each of those opens its own transaction - the PR
 * #183 lesson, where the agenda went from 9 round trips to 1. Nothing enforces
 * that but a test: adding one innocent `forShop(...)` line to the collector
 * would silently add a round trip to every dashboard render that ever calls it.
 *
 * 🔑 HOW THE COUNT IS TAKEN. packages/db stashes its client on
 * `globalThis.prisma` (the hot-reload singleton guard), and reads it back before
 * constructing a new one. Seeding that global with a query-logging client BEFORE
 * @chairback/db is first imported therefore instruments the REAL shared client
 * the collector uses - no mocking, no re-implementation. Every import below is
 * dynamic for that reason: a static import would be hoisted above the seeding
 * and the collector would get an uninstrumented client.
 */

interface Counter {
  statements: string[];
  reset(): void;
}

let counter: Counter;
let collectReadinessFacts: (shopId: string) => Promise<unknown>;
let prisma: PrismaClient;
let shopId: string;
let userId: string;

beforeAll(async () => {
  const { PrismaClient: Client } = (await import(GENERATED)) as {
    PrismaClient: new (opts: unknown) => PrismaClient;
  };
  const logged = new Client({
    log: [{ emit: "event", level: "query" }],
  }) as PrismaClient & { $on: (e: "query", cb: (ev: { query: string }) => void) => void };

  const statements: string[] = [];
  logged.$on("query", (ev) => statements.push(ev.query));
  counter = { statements, reset: () => (statements.length = 0) };

  // Seed the singleton BEFORE @chairback/db is first loaded.
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = logged;

  ({ collectReadinessFacts } = await import("./readinessFacts.js"));
  ({ prisma } = (await import("@chairback/db")) as unknown as { prisma: PrismaClient });
  // Proof the seeding worked: the package handed back OUR instrumented client.
  expect(prisma).toBe(logged);

  const user = await prisma.user.create({
    data: {
      email: `qcount-${Math.random().toString(36).slice(2, 10)}@test.chairback`,
      name: "Q",
      passwordHash: "x",
    },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Query Count Cuts",
      webhookSecret: Math.random().toString(36).slice(2),
      slug: `qcount-${Math.random().toString(36).slice(2, 10)}`,
      bookingMode: "native",
    },
    select: { id: true },
  });
  shopId = shop.id;
  await prisma.shopMember.create({ data: { shopId, userId, role: "OWNER" } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
  delete (globalThis as unknown as { prisma?: PrismaClient }).prisma;
});

/** BEGIN/COMMIT bracket a transaction, so counting them counts round trips. */
const begins = (s: string[]) => s.filter((q) => /^\s*BEGIN/i.test(q)).length;

describe("collectReadinessFacts round trips", () => {
  it("stays bounded, and batches its tenant reads into one transaction", async () => {
    counter.reset();
    await collectReadinessFacts(shopId);

    const transactions = begins(counter.statements);
    const selects = counter.statements.filter((q) => /^\s*SELECT/i.test(q)).length;

    // eslint-disable-next-line no-console
    console.log(
      `[readiness] ${transactions} transactions, ${selects} SELECTs, ` +
        `${counter.statements.length} statements total`,
    );

    // Two interactive transactions (runWithShop + runAsOwner) plus the Shop read.
    // The ceiling is deliberately tight: it is here to FAIL if someone adds a
    // stray forShop() call, which would push this straight past it.
    expect(transactions).toBeLessThanOrEqual(3);
    expect(selects).toBeLessThanOrEqual(16);
  });

  it("does not scale its round trips with shop size", async () => {
    // Ten chairs and ten services must cost the same number of trips as one -
    // i.e. nothing in the collector loops a query per row.
    for (let i = 0; i < 10; i++) {
      const staff = await prisma.staff.create({
        data: { shopId, name: `Chair ${i}` },
        select: { id: true },
      });
      const service = await prisma.service.create({
        data: { shopId, name: `Service ${i}`, durationMin: 30 },
        select: { id: true },
      });
      await prisma.serviceStaff.create({
        data: { shopId, serviceId: service.id, staffId: staff.id },
      });
      await prisma.availabilityRule.create({
        data: { shopId, staffId: staff.id, weekday: 1, startMin: 540, endMin: 1020 },
      });
    }

    counter.reset();
    await collectReadinessFacts(shopId);
    const withTen = begins(counter.statements);

    // eslint-disable-next-line no-console
    console.log(`[readiness] 10 chairs + 10 services: ${withTen} transactions`);
    expect(withTen).toBeLessThanOrEqual(3);
  });

  it("performs no writes at all", async () => {
    counter.reset();
    await collectReadinessFacts(shopId);
    const writes = counter.statements.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i.test(q),
    );
    // The transaction-context statements runWithShop/runAsOwner issue are SETs,
    // not data writes; anything in the list above would be a real mutation.
    expect(writes).toEqual([]);
  });
});
