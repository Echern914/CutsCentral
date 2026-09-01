import { Prisma, prisma } from "@chairback/db";

/**
 * THE BARRIER: how to write a concurrency test that actually tests something.
 *
 * 🔴 `Promise.all` IS NOT A RACE. Node's event loop and a fast local Postgres
 * serialise the calls often enough that the guard is never contended, so the
 * test passes whether the guard exists or not. A mutation audit of this repo
 * found 17 of 28 "two concurrent X" tests passed with their lock, CAS or
 * unique index REMOVED. They asserted a count and proved nothing.
 *
 * The shape that works is a barrier: take the guard yourself, on your own
 * connection, let the racers pile up behind it, CHECK THAT THEY ARE STUCK, and
 * only then let go. The "check that they are stuck" step is the whole point -
 * it is the assertion a missing guard fails, because without the guard nobody
 * waits for anything.
 *
 * ```ts
 * const { results, settledEarly } = await raceBehindAdvisoryLock(
 *   `walkin:${shopId}`,
 *   [() => startEntry(...), () => startEntry(...)],
 * );
 * expect(settledEarly).toBe(0);          // they really did contend
 * expect(results.filter(ok)).toHaveLength(1);
 * ```
 *
 * Prefer asserting the DATABASE CONSTRAINT directly where one exists (insert
 * the second row, expect a rejection) - that is deterministic, instant, and
 * needs no barrier at all. Reach for a barrier when the guard is a lock or a
 * compare-and-set, which only a real interleaving can exercise.
 */

/** How long racers are given to prove they are blocked. */
const SETTLE_WINDOW_MS = 400;
/** Barrier transactions hold a connection open; keep the ceiling generous. */
const BARRIER_TIMEOUT_MS = 30_000;

export interface HeldBarrier {
  /** Release the guard and wait for the holding transaction to finish. */
  release(): Promise<void>;
}

/**
 * Take `pg_advisory_xact_lock(hashtext(key))` on a separate connection and
 * hold it. Resolves only once the lock is genuinely held, so a racer started
 * afterwards must queue behind it.
 *
 * The key must be byte-identical to the one the code under test uses -
 * `shopcreate:<ownerId>`, `walkin:<shopId>`, `appt:<staffId>` and so on.
 */
export async function holdAdvisoryLock(key: string): Promise<HeldBarrier> {
  let release!: () => void;
  let acquired!: () => void;
  let failed!: (err: unknown) => void;
  const gate = new Promise<void>((r) => (release = r));
  const ready = new Promise<void>((r, j) => {
    acquired = r;
    failed = j;
  });

  const held = prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`,
        );
        acquired();
        await gate;
      },
      { timeout: BARRIER_TIMEOUT_MS, maxWait: BARRIER_TIMEOUT_MS },
    )
    .catch((err: unknown) => {
      failed(err);
      throw err;
    });

  await ready;
  return {
    async release() {
      release();
      await held;
    },
  };
}

/**
 * Hold a ROW lock (`SELECT ... FOR UPDATE`) on one row, for guards that are a
 * compare-and-set rather than an advisory lock.
 *
 * This is what forces a genuine CAS interleaving: both racers get to READ the
 * row (a plain SELECT does not block on FOR UPDATE) and therefore both see the
 * pre-condition satisfied, then both queue at their UPDATE. Release, and the
 * loser's `WHERE status = <expected>` is the only thing standing between one
 * outcome and two.
 *
 * `table` is interpolated into SQL, so pass a literal - never user input.
 */
export async function holdRowLock(table: string, id: string): Promise<HeldBarrier> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`holdRowLock: unsafe table name ${table}`);
  }
  let release!: () => void;
  let acquired!: () => void;
  let failed!: (err: unknown) => void;
  const gate = new Promise<void>((r) => (release = r));
  const ready = new Promise<void>((r, j) => {
    acquired = r;
    failed = j;
  });

  const held = prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`,
          id,
        );
        acquired();
        await gate;
      },
      { timeout: BARRIER_TIMEOUT_MS, maxWait: BARRIER_TIMEOUT_MS },
    )
    .catch((err: unknown) => {
      failed(err);
      throw err;
    });

  await ready;
  return {
    async release() {
      release();
      await held;
    },
  };
}

export interface RaceOutcome<T> {
  results: PromiseSettledResult<T>[];
  /**
   * How many racers finished BEFORE the barrier was released. Assert this is
   * 0: a racer that finished early never touched the guard, which means the
   * test is not testing the guard. This is the assertion that fails when the
   * guard is removed.
   */
  settledEarly: number;
}

/**
 * Start every racer, verify they are all blocked on the barrier, release it,
 * and return what happened.
 */
export async function raceBehindBarrier<T>(
  barrier: HeldBarrier,
  racers: Array<() => Promise<T>>,
  settleWindowMs = SETTLE_WINDOW_MS,
): Promise<RaceOutcome<T>> {
  const tracked = racers.map((run) => {
    let settled = false;
    const promise = run().then(
      (value) => {
        settled = true;
        return value;
      },
      (err: unknown) => {
        settled = true;
        throw err;
      },
    );
    // Nothing awaits this copy; it only stops an early rejection becoming an
    // unhandled rejection while we wait out the settle window.
    void promise.catch(() => undefined);
    return { promise, isSettled: () => settled };
  });

  await new Promise((r) => setTimeout(r, settleWindowMs));
  const settledEarly = tracked.filter((t) => t.isSettled()).length;

  await barrier.release();
  const results = await Promise.allSettled(tracked.map((t) => t.promise));
  return { results, settledEarly };
}

/** Convenience: hold an advisory lock, race behind it, release. */
export async function raceBehindAdvisoryLock<T>(
  key: string,
  racers: Array<() => Promise<T>>,
  settleWindowMs?: number,
): Promise<RaceOutcome<T>> {
  const barrier = await holdAdvisoryLock(key);
  return raceBehindBarrier(barrier, racers, settleWindowMs);
}

/** Convenience: hold a row lock, race behind it, release. */
export async function raceBehindRowLock<T>(
  table: string,
  id: string,
  racers: Array<() => Promise<T>>,
  settleWindowMs?: number,
): Promise<RaceOutcome<T>> {
  const barrier = await holdRowLock(table, id);
  return raceBehindBarrier(barrier, racers, settleWindowMs);
}

/** The fulfilled results, for the usual "exactly one won" assertion. */
export function winners<T>(results: PromiseSettledResult<T>[]): T[] {
  return results
    .filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled")
    .map((r) => r.value);
}
