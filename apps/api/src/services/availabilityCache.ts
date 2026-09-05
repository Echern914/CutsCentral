import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * The public booking page's availability caches (`/day`, `/open-days`), and
 * the one thing every availability-changing writer must call.
 *
 * ── THE PROBLEM A PLAIN TTL CACHE HAS ────────────────────────────────────────
 *
 * The first version of this module kept finished bodies in a Map and let
 * writers delete them. Two holes:
 *
 *  1. IN-FLIGHT. A `/day` calculation that began before a booking committed
 *     could finish afterwards and store its pre-booking answer - the writer's
 *     delete had already happened, so the stale body then served for the whole
 *     TTL. Deleting a finished entry says nothing to a calculation in progress.
 *  2. PROCESS-LOCAL. A Map in one API process cannot be seen from another.
 *     With two replicas, a booking taken on replica A left replica B serving
 *     the taken slot until its own TTL lapsed.
 *
 * ── THE FIX: A PER-SHOP GENERATION, IN THE DATABASE ──────────────────────────
 *
 * `Shop.availabilityGeneration` is an integer every availability-changing
 * writer advances by one, atomically, AFTER its transaction commits
 * (`noteAvailabilityChanged`). Readers:
 *
 *  - read the generation BEFORE computing (for `/day` and `/open-days` it rides
 *    on the shop row the route already loads - no extra query),
 *  - serve a cached body only while its generation equals the one just read,
 *  - join an in-flight calculation only if it was started under that same
 *    generation,
 *  - after computing, read the generation AGAIN; if it moved, the calculation
 *    may have seen a mix of before and after, so it is neither served nor
 *    stored - it is redone under the new generation (bounded), and if the store
 *    cannot be read at all the fresh result is returned uncached.
 *
 * Because "current" is defined by a number both processes read from the same
 * row, a body computed before a commit can only ever be stored under the OLD
 * generation, which no reader will ask for again. That is the invariant, and
 * it holds across replicas because the number lives in Postgres, not here.
 *
 * ── WHAT THIS IS STILL NOT ───────────────────────────────────────────────────
 *
 * Not the double-booking guard. The atomic write guard in
 * engines/bookingWrite.ts (advisory lock + overlap re-check + the partial
 * unique index) runs on every write regardless of what any cache served, and
 * it is authoritative even if this whole module is wrong or the generation
 * column is unreachable. A stale page costs a customer a retry; it cannot cost
 * a chair a double booking.
 *
 * The TTL stays as an upper bound for the one thing a generation cannot see:
 * time itself. A hold lapsing or `now` moving past a slot's lead time changes
 * availability without any write, and that staleness is in the SAFE direction
 * (a free slot shown as taken, never the reverse), so the TTL is enough for it.
 */

/**
 * TTL 0 under vitest, the same pattern as middleware/rateLimit.ts: suites edit
 * hours or services with bare `prisma.*` writes (which bump nothing) and
 * immediately re-read the day. Tests of the cache itself set a real TTL
 * through `setTtlForTests`.
 */
export const DAY_TTL_MS = process.env.VITEST === "true" ? 0 : 60_000;
export const OPEN_DAYS_TTL_MS = process.env.VITEST === "true" ? 0 : 60_000;

/** How many times one request may redo its calculation because the world moved. */
const MAX_RECOMPUTES = 2;

/** Reads a shop's current availability generation from the shared store. */
export type GenerationReader = (shopId: string) => Promise<number>;

/**
 * The default reader: the shop row. Throws when the shop is missing or the
 * database is unreachable - callers treat a throw as "cannot verify" and fall
 * back to a fresh, uncached calculation.
 */
export async function readAvailabilityGeneration(shopId: string): Promise<number> {
  const row = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { availabilityGeneration: true },
  });
  if (!row) throw new Error("availability generation: shop not found");
  return row.availabilityGeneration;
}

interface Entry<T> {
  shopId: string;
  generation: number;
  at: number;
  body: T;
}

interface InFlight<T> {
  shopId: string;
  generation: number;
  promise: Promise<T>;
}

export class AvailabilityCache<T> {
  private readonly done = new Map<string, Entry<T>>();
  private readonly inFlight = new Map<string, InFlight<T>>();
  private ttlMs: number;
  readonly name: string;
  private readonly readGeneration: GenerationReader;

  constructor(opts: { name: string; ttlMs: number; readGeneration: GenerationReader }) {
    this.name = opts.name;
    this.ttlMs = opts.ttlMs;
    this.readGeneration = opts.readGeneration;
  }

  /**
   * One cached answer.
   *
   * `generation` is the shop's generation as the CALLER read it before asking
   * (null = the caller could not read it: the store is unavailable). `compute`
   * is only ever run when no current answer exists.
   */
  async get(
    key: string,
    shopId: string,
    generation: number | null,
    compute: () => Promise<T>,
  ): Promise<T> {
    // The store could not be read: nothing can be verified, so nothing is
    // cached or served from cache. A fresh authoritative read is the only
    // honest answer - never a stale one.
    if (generation === null) return compute();

    const hit = this.done.get(key);
    if (hit) {
      if (hit.generation === generation && Date.now() - hit.at < this.ttlMs) return hit.body;
      // Stale by generation or by age. Delete rather than leave it: a body
      // that can never be served again is only memory.
      this.done.delete(key);
    }

    // Join a calculation already running for this key - but only one that
    // started under the SAME generation. One started earlier may have read the
    // world before a commit this caller has already observed.
    const flying = this.inFlight.get(key);
    if (flying && flying.generation === generation) return flying.promise;

    const entry: InFlight<T> = {
      shopId,
      generation,
      promise: this.run(key, shopId, generation, compute),
    };
    this.inFlight.set(key, entry);
    // 🔴 IDENTITY-GUARDED CLEANUP. This promise removes only ITSELF. By the
    // time it settles, `invalidateShop` may have dropped it and a newer
    // calculation may be in flight under the same key; deleting by key alone
    // would delete that newer one, and its joiners would then start a third.
    void entry.promise.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
    });
    return entry.promise;
  }

  private async run(
    key: string,
    shopId: string,
    startedUnder: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    let generation = startedUnder;
    for (let attempt = 0; ; attempt++) {
      const body = await compute();

      // Verify BEFORE publishing or returning: did the world move while we
      // were reading it?
      let after: number | null;
      try {
        after = await this.readGeneration(shopId);
      } catch (err) {
        after = null;
        logger.warn(
          { cache: this.name, shopId, err },
          "availability cache: generation unreadable after compute - returning fresh, uncached",
        );
      }
      if (after === null) return body; // cannot verify: fresh, not cached

      if (after === generation) {
        this.done.set(key, { shopId, generation, at: Date.now(), body });
        return body;
      }

      // A writer committed and advanced the generation while this calculation
      // ran. What it read may be a mix of before and after, so it is neither
      // stored nor returned as current. Redo it under the generation we now
      // hold; if a shop is being written to faster than it can be read, stop
      // after a bounded number of attempts and return the latest computation
      // uncached - it is still fresher than anything a cache could hold, and
      // the write guard, not this page, decides who gets the chair.
      if (attempt >= MAX_RECOMPUTES) {
        logger.warn(
          { cache: this.name, shopId, attempts: attempt + 1 },
          "availability cache: generation kept moving - returning latest computation uncached",
        );
        return body;
      }
      generation = after;
    }
  }

  /**
   * Forget everything held for one shop - finished bodies and in-flight
   * calculations alike. Called by `noteAvailabilityChanged` after the
   * generation has advanced. Strictly per shop: a busy shop's writes must not
   * cost every other shop its cache.
   */
  invalidateShop(shopId: string): void {
    for (const [key, entry] of this.done) {
      if (entry.shopId === shopId) this.done.delete(key);
    }
    for (const [key, entry] of this.inFlight) {
      if (entry.shopId === shopId) this.inFlight.delete(key);
    }
  }

  /** Test seam: what is held for a key, if anything. */
  peek(key: string): { generation: number; body: T } | undefined {
    const e = this.done.get(key);
    return e ? { generation: e.generation, body: e.body } : undefined;
  }

  /** Test seam: is a calculation in flight for this key, and under which generation? */
  peekInFlight(key: string): number | undefined {
    return this.inFlight.get(key)?.generation;
  }

  /** Test seam: the caches run with TTL 0 under vitest; tests of the cache itself need a real one. */
  setTtlForTests(ms: number): void {
    this.ttlMs = ms;
  }

  /** Test seam: forget everything. */
  clearForTests(): void {
    this.done.clear();
    this.inFlight.clear();
  }
}

/** Finished `/day` bodies, keyed `shopId|YYYY-MM-DD`. */
export const dayAvailabilityCache = new AvailabilityCache<unknown>({
  name: "day",
  ttlMs: DAY_TTL_MS,
  readGeneration: readAvailabilityGeneration,
});

/** Finished `/open-days` bodies, keyed by shop id. */
export const openDaysAvailabilityCache = new AvailabilityCache<unknown>({
  name: "open-days",
  ttlMs: OPEN_DAYS_TTL_MS,
  readGeneration: readAvailabilityGeneration,
});

/**
 * 🔴 THE ONE CALL EVERY AVAILABILITY-CHANGING WRITER MAKES, AFTER COMMIT.
 *
 * Advances the shop's generation in the database (one atomic UPDATE, on the
 * owner connection - the Shop row is outside tenant RLS), then drops whatever
 * this process holds for the shop. The order matters: the database number is
 * what other processes read, so it moves first; the local drop is a courtesy
 * that saves this process one wasted lookup.
 *
 * AFTER the commit, never inside the transaction: a reader that saw the new
 * number could otherwise read data the transaction had not yet committed and
 * publish it as current.
 *
 * Never throws. If the UPDATE fails the local caches are still dropped and the
 * failure is logged: other processes may then serve the shop stale for at most
 * one TTL, which is the documented residual, and the write guard is untouched.
 */
export async function noteAvailabilityChanged(shopId: string): Promise<void> {
  if (!shopId) return;
  try {
    await prisma.$executeRaw`UPDATE "Shop" SET "availabilityGeneration" = "availabilityGeneration" + 1 WHERE "id" = ${shopId}`;
  } catch (err) {
    logger.error(
      { shopId, err },
      "availability generation: bump failed - other processes may serve this shop stale until the TTL",
    );
  }
  dayAvailabilityCache.invalidateShop(shopId);
  openDaysAvailabilityCache.invalidateShop(shopId);
}

/** Same, for a set of shops - sync paths that touch several in one pass. */
export async function noteAvailabilityChangedFor(shopIds: Iterable<string>): Promise<void> {
  for (const id of new Set(shopIds)) await noteAvailabilityChanged(id);
}
