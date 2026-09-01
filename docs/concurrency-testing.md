# Testing a guard

A concurrency test is only worth something if it **fails when its guard is
removed**. Most of ours did not.

## What the audit found

On 2026-08-31 every advisory lock, unique index and compare-and-set in the API
was removed on purpose and the suite re-run. Out of **2,904 tests, 8 noticed**.
Sixteen tests whose names promised "two concurrent X" or "exactly one wins"
passed with their guard deleted — including the walk-in capacity lock and all
three booking tests literally named "REAL race".

They all had the same shape:

```ts
const results = await Promise.allSettled([doThing(), doThing()]);
expect(results.filter(ok)).toHaveLength(1);   // proves nothing
```

**`Promise.all` is not a race.** Node's event loop and a fast local Postgres
serialise the two calls: the first finishes before the second starts, so the
guard is never contended and the assertion holds whether or not it exists.

## The two shapes that work

### 1. Assert the constraint directly (preferred)

Deterministic, instant, no timing involved. Insert the second row and expect
the database to refuse it:

```ts
await expect(
  prisma.affiliateReward.create({ data: { referredShopId: sameShop, ... } }),
).rejects.toThrow();
```

Drop the index and this fails immediately. Use it whenever the guard *is* a
constraint.

### 2. A barrier (when the guard is a lock or a CAS)

Take the guard yourself on a separate connection, let the racers pile up behind
it, **check they are stuck**, then release. That check is the whole point — it
is the assertion a missing guard fails, because without the guard nobody waits.

```ts
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";

const { results, settledEarly } = await raceBehindAdvisoryLock(
  `appt:${staffId}`,                      // the SAME key the code uses
  [() => bookIt(), () => bookIt()],
);
expect(settledEarly).toBe(0);             // they really did contend
expect(winners(results)).toHaveLength(1);
```

`raceBehindRowLock("WalkInEntry", id, ...)` is the variant for a
compare-and-set: a plain `SELECT` does not block on `FOR UPDATE`, so both
racers read the same pre-condition and then queue at their `UPDATE` — which is
the only interleaving where a CAS matters.

Helpers live in `apps/api/src/testing/raceBarrier.ts`.

### Choosing a barrier that actually blocks

The barrier must be something the racers **write through**, not merely read.
Holding a row that both only read lets them sail past (`settledEarly` will be
non-zero and the test will tell you so). If there is no shared write point,
use shape 1 instead.

## Two things keep this from coming back

**`node scripts/falsify-guards.mjs`** removes the guards for real and reports
which tests noticed. Run it after touching a lock, an index or a CAS — and
periodically, because it is the only thing that measures substance. It refuses
to run on a dirty tree or against a non-local database, and restores everything
with `git checkout` + `prisma migrate reset`.

**`apps/api/src/concurrencyTestShape.test.ts`** runs in the normal suite and
fails if a test's *name* promises a race while its *body* uses neither shape.
It carries a frozen backlog of the tests that already existed on 2026-08-31 so
the suite stays green while they are reshaped one at a time; the list may only
shrink. Entries marked `UNPROVEN` are exactly that — nobody has removed their
guard and watched them fail.

## Reading a result honestly

- A test that fails when the guard is removed: the test is real **and** the
  guard works. Both facts, from one experiment.
- A test that passes: the test is theatre. It says nothing about the guard —
  the guard may be perfect or missing, and you still do not know.
- A test that fails **with** the guard in place: the guard is broken. Rare, and
  the most valuable outcome of all.
