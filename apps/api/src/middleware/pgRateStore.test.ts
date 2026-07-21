import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { PgRateStore, sweepExpiredRateCounters } from "./pgRateStore.js";
import type { Options } from "express-rate-limit";

/**
 * The Postgres rate-limit store, tested directly against the shared DB (the
 * limiters themselves fall back to MemoryStore under VITEST, so this exercises
 * the real store class). Proves the atomic increment counts within a window,
 * resets after the window expires, decrements/resets a key, and that the sweep
 * removes long-dead rows.
 */
function storeWith(windowMs: number, prefix: string): PgRateStore {
  const s = new PgRateStore(prefix);
  s.init({ windowMs } as Options);
  return s;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PgRateStore", () => {
  let key: string;
  beforeEach(() => {
    // Unique key per test so parallel/repeat runs don't collide.
    key = `k-${randomToken(8)}`;
  });

  it("increments hits within a window and reports the reset time", async () => {
    const store = storeWith(60_000, "t:");
    const a = await store.increment(key);
    const b = await store.increment(key);
    const c = await store.increment(key);
    expect(a.totalHits).toBe(1);
    expect(b.totalHits).toBe(2);
    expect(c.totalHits).toBe(3);
    // resetTime is ~now+window and stable across hits in the same window.
    expect(a.resetTime).toBeInstanceOf(Date);
    expect(b.resetTime!.getTime()).toBe(a.resetTime!.getTime());
  });

  it("resets to 1 once the window has expired", async () => {
    // A 1ms window: the row is already expired by the next call, so it resets.
    const store = storeWith(1, "t:");
    const first = await store.increment(key);
    expect(first.totalHits).toBe(1);
    await new Promise((r) => setTimeout(r, 15));
    const afterExpiry = await store.increment(key);
    expect(afterExpiry.totalHits).toBe(1); // window rolled over, not 2
  });

  it("decrement lowers the count but never below zero", async () => {
    const store = storeWith(60_000, "t:");
    await store.increment(key); // 1
    await store.increment(key); // 2
    await store.decrement(key); // 1
    const back = await store.increment(key); // 2
    expect(back.totalHits).toBe(2);
    await store.decrement(key);
    await store.decrement(key);
    await store.decrement(key); // floored at 0
    const afterFloor = await store.increment(key);
    expect(afterFloor.totalHits).toBe(1); // 0 -> +1
  });

  it("resetKey clears the counter", async () => {
    const store = storeWith(60_000, "t:");
    await store.increment(key);
    await store.increment(key);
    await store.resetKey(key);
    const fresh = await store.increment(key);
    expect(fresh.totalHits).toBe(1);
  });

  it("keeps different prefixes in separate buckets", async () => {
    const a = storeWith(60_000, "auth:");
    const b = storeWith(60_000, "lead:");
    await a.increment(key);
    await a.increment(key);
    const bHit = await b.increment(key); // same raw key, different prefix
    expect(bHit.totalHits).toBe(1); // not 3 - isolated
  });

  it("sweep removes long-expired rows", async () => {
    const store = storeWith(1, "t:");
    await store.increment(key); // creates a row that expires in 1ms
    // Force its expiry far into the past so the >1h sweep window catches it.
    await prisma.$executeRawUnsafe(
      `UPDATE "rate_limit_counter" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "key" = 't:${key}'`,
    );
    const deleted = await sweepExpiredRateCounters();
    expect(deleted).toBeGreaterThanOrEqual(1);
    const row = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT count(*)::int AS c FROM "rate_limit_counter" WHERE "key" = 't:${key}'`,
    );
    expect(row[0]!.c).toBe(0);
  });
});
