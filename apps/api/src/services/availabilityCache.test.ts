import { describe, expect, it } from "vitest";
import { AvailabilityCache } from "./availabilityCache.js";

/**
 * The generation cache, alone, with a controllable clock and a controllable
 * "database". Every race here is DETERMINISTIC: the calculation is a promise
 * the test resolves by hand, and the shared generation is a number the test
 * advances by hand. Nothing waits on a timer.
 *
 * Two instances of the class with one shared `store` are two API processes
 * sharing one database - which is exactly the situation a process-local Map
 * could not handle.
 */

/** A promise the test resolves when it decides the calculation "finishes". */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the microtask queue completely: every pending `await` runs to its next await. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** The shared store: one generation per shop, plus a switch to make it "down". */
function makeStore() {
  const gens = new Map<string, number>();
  let down = false;
  return {
    gens,
    setDown(v: boolean) {
      down = v;
    },
    read: async (shopId: string) => {
      if (down) throw new Error("store unreachable");
      return gens.get(shopId) ?? 0;
    },
    bump(shopId: string) {
      gens.set(shopId, (gens.get(shopId) ?? 0) + 1);
    },
  };
}

function cacheOn(store: ReturnType<typeof makeStore>, name = "test") {
  return new AvailabilityCache<string>({ name, ttlMs: 60_000, readGeneration: store.read });
}

const SHOP = "shop_a";
const KEY = `${SHOP}|2026-09-10`;

describe("a calculation that began before a commit is never served as current", () => {
  it("🔴 pauses a calculation, commits underneath it, and neither returns nor stores the stale answer", async () => {
    const store = makeStore();
    const cache = cacheOn(store);
    let computeCalls = 0;
    const first = deferred<string>();
    const second = deferred<string>();
    const computes = [first, second];
    const compute = async () => {
      const d = computes[computeCalls++]!;
      return d.promise;
    };

    // 1. The request reads generation 0 and starts calculating from old data.
    const g0 = await store.read(SHOP);
    const request = cache.get(KEY, SHOP, g0, compute);
    let settled = false;
    void request.then(() => (settled = true));
    await flush();
    expect(computeCalls).toBe(1);

    // 2. A booking commits and advances the generation.
    store.bump(SHOP);
    cache.invalidateShop(SHOP); // what noteAvailabilityChanged does locally
    expect(settled).toBe(false);

    // 3. The OLD calculation completes with its pre-commit answer.
    first.resolve("STALE: slot still shown");
    await flush();

    // 4. It was not returned and not stored: the cache went back to work under
    //    the new generation instead.
    expect(settled).toBe(false);
    expect(cache.peek(KEY)).toBeUndefined();
    expect(computeCalls).toBe(2);

    second.resolve("FRESH: slot gone");
    const body = await request;
    expect(body).toBe("FRESH: slot gone");
    // 5. And what is stored is the fresh answer, under the current generation.
    expect(cache.peek(KEY)).toEqual({ generation: 1, body: "FRESH: slot gone" });
  });

  it("serves a stored body only while the generation it was computed under is still current", async () => {
    const store = makeStore();
    const cache = cacheOn(store);
    let calls = 0;
    const compute = async () => `v${++calls}`;
    expect(await cache.get(KEY, SHOP, await store.read(SHOP), compute)).toBe("v1");
    expect(await cache.get(KEY, SHOP, await store.read(SHOP), compute)).toBe("v1"); // hit
    expect(calls).toBe(1);
    store.bump(SHOP); // a commit somewhere - maybe in another process
    expect(await cache.get(KEY, SHOP, await store.read(SHOP), compute)).toBe("v2"); // miss
    expect(calls).toBe(2);
  });

  it("bounds the redo when a shop is written to faster than it can be read, returning the latest uncached", async () => {
    const store = makeStore();
    const cache = cacheOn(store);
    let calls = 0;
    // Every calculation is chased by a commit.
    const compute = async () => {
      calls++;
      store.bump(SHOP);
      return `v${calls}`;
    };
    const body = await cache.get(KEY, SHOP, await store.read(SHOP), compute);
    expect(body).toBe("v3"); // 1 + MAX_RECOMPUTES attempts, the last returned
    expect(calls).toBe(3);
    expect(cache.peek(KEY)).toBeUndefined(); // never published: it could not be verified
  });
});

describe("in-flight calculations", () => {
  it("joins a calculation started under the same generation, and only that one", async () => {
    const store = makeStore();
    const cache = cacheOn(store);
    let calls = 0;
    const d = deferred<string>();
    const compute = async () => {
      calls++;
      return d.promise;
    };
    const g = await store.read(SHOP);
    const a = cache.get(KEY, SHOP, g, compute);
    const b = cache.get(KEY, SHOP, g, compute); // same generation: joins
    expect(calls).toBe(1);
    expect(cache.peekInFlight(KEY)).toBe(0);

    store.bump(SHOP);
    const c = cache.get(KEY, SHOP, await store.read(SHOP), compute); // newer generation: does NOT join
    expect(calls).toBe(2);

    d.resolve("body");
    // a and b: their calculation now fails verification (gen moved) and redoes
    // itself - a third call; c: verified under gen 1.
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(rc).toBe("body");
    expect(ra).toBe("body");
    expect(rb).toBe("body");
    expect(calls).toBe(3);
  });

  it("🔴 an old promise's cleanup never deletes or replaces a newer in-flight calculation", async () => {
    // 🔑 THE SHAPE THAT CAN SEE THE BUG. The old calculation has to SETTLE
    // while a newer one is in flight under the same key - that is the only
    // moment a delete-by-key cleanup can reach across and remove the newer
    // entry. So the generation is deliberately NOT advanced here: this test is
    // about the cleanup's identity check, not about staleness. (An earlier
    // version bumped the generation, which made the old promise redo its work
    // and never settle at the point being asserted - so a delete-by-key
    // mutation passed it. Caught by the falsification sweep.)
    const store = makeStore();
    const cache = cacheOn(store);
    const old = deferred<string>();
    const fresh = deferred<string>();
    let calls = 0;
    const compute = async () => (++calls === 1 ? old.promise : fresh.promise);

    // A is in flight under generation 0.
    const a = cache.get(KEY, SHOP, 0, compute);
    expect(cache.peekInFlight(KEY)).toBe(0);

    // A writer drops what this process holds (the generation is unchanged - a
    // sibling shop's bump, or simply the local drop racing its own bump).
    cache.invalidateShop(SHOP);
    expect(cache.peekInFlight(KEY)).toBeUndefined();

    // B starts its own calculation and becomes the in-flight entry for the key.
    const b = cache.get(KEY, SHOP, 0, compute);
    expect(cache.peekInFlight(KEY)).toBe(0);
    expect(calls).toBe(2);

    // A settles. Its generation still verifies, so it finishes for real - and
    // its cleanup must leave B's entry alone.
    old.resolve("A");
    expect(await a).toBe("A");
    await flush();
    expect(cache.peekInFlight(KEY)).toBe(0); // B is still there

    // B then finishes on its own and overwrites the stored body with its own,
    // newer answer. Nothing about A's cleanup interfered with it.
    fresh.resolve("B");
    expect(await b).toBe("B");
    expect(cache.peek(KEY)).toEqual({ generation: 0, body: "B" });
    expect(calls).toBe(2); // never a third calculation
  });
});

describe("two API processes sharing one database", () => {
  it("🔴 a body cached in process A is not served by process B after the generation advanced, nor by A", async () => {
    const store = makeStore();
    const processA = cacheOn(store, "A");
    const processB = cacheOn(store, "B");
    let calls = 0;
    const compute = async () => `v${++calls}`;

    // Both processes warm up under generation 0.
    expect(await processA.get(KEY, SHOP, await store.read(SHOP), compute)).toBe("v1");
    expect(await processB.get(KEY, SHOP, await store.read(SHOP), compute)).toBe("v2");
    expect(processA.peek(KEY)?.generation).toBe(0);
    expect(processB.peek(KEY)?.generation).toBe(0);

    // A booking is taken through process A: it advances the shared generation
    // and drops ITS OWN map. Process B's map is untouched - it cannot be.
    store.bump(SHOP);
    processA.invalidateShop(SHOP);
    expect(processB.peek(KEY)?.generation).toBe(0); // still holding the old body

    // Process B's next request reads the shared generation first, so the old
    // body is not served - it is recomputed, and the old entry is dropped.
    expect(await processB.get(KEY, SHOP, await store.read(SHOP), compute)).toBe("v3");
    expect(processB.peek(KEY)?.generation).toBe(1);
    expect(await processA.get(KEY, SHOP, await store.read(SHOP), compute)).toBe("v4");
  });

  it("invalidation is per shop: another shop's cache is untouched", async () => {
    const store = makeStore();
    const cache = cacheOn(store);
    let calls = 0;
    const compute = async () => `v${++calls}`;
    await cache.get("shop_a|d", "shop_a", 0, compute);
    await cache.get("shop_b|d", "shop_b", 0, compute);
    store.bump("shop_a");
    cache.invalidateShop("shop_a");
    expect(cache.peek("shop_a|d")).toBeUndefined();
    expect(cache.peek("shop_b|d")).toEqual({ generation: 0, body: "v2" });
    expect(await cache.get("shop_b|d", "shop_b", await store.read("shop_b"), compute)).toBe("v2");
    expect(calls).toBe(2);
  });
});

describe("when the shared store is unavailable", () => {
  it("🔴 fails toward a fresh authoritative read, never a stale cached one", async () => {
    const store = makeStore();
    const cache = cacheOn(store);
    let calls = 0;
    const compute = async () => `v${++calls}`;
    expect(await cache.get(KEY, SHOP, 0, compute)).toBe("v1");
    expect(cache.peek(KEY)?.body).toBe("v1");

    // The caller could not read the generation (null): the cache is bypassed
    // entirely - not served, not stored.
    expect(await cache.get(KEY, SHOP, null, compute)).toBe("v2");
    expect(cache.peek(KEY)?.body).toBe("v1"); // untouched, and still not served

    // The store goes down AFTER a calculation: it cannot be verified, so it is
    // returned fresh and not stored.
    store.bump(SHOP);
    store.setDown(true);
    expect(await cache.get(KEY, SHOP, 1, compute)).toBe("v3");
    expect(cache.peek(KEY)).toBeUndefined(); // the gen-0 entry was dropped on the miss; nothing new stored
    store.setDown(false);
    expect(await cache.get(KEY, SHOP, 1, compute)).toBe("v4");
    expect(cache.peek(KEY)).toEqual({ generation: 1, body: "v4" });
  });

  it("a stored body is never served past its TTL, whatever the generation says", async () => {
    const store = makeStore();
    const cache = new AvailabilityCache<string>({ name: "t", ttlMs: 0, readGeneration: store.read });
    let calls = 0;
    const compute = async () => `v${++calls}`;
    expect(await cache.get(KEY, SHOP, 0, compute)).toBe("v1");
    expect(await cache.get(KEY, SHOP, 0, compute)).toBe("v2");
  });
});
