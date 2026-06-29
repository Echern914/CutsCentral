import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { withLease } from "./lease.js";

/**
 * The job_lease cross-replica mutex. The load-bearing test is "mutual exclusion
 * under contention": many concurrent withLease() calls on the same job must run
 * the body EXACTLY ONCE. That is the property that stops a multi-replica
 * scheduler from texting every customer N times. The rest cover re-acquire after
 * release, TTL self-heal of a dead holder, and an actively-held lease blocking.
 *
 * Each test uses a UNIQUE lease name (no shared row → no cross-test bleed), and
 * seeds expiresAt RELATIVE TO THE DB CLOCK via raw SQL (not a JS Date), so the
 * seed and withLease compare against the same authoritative clock with no
 * timezone/skew boundary flake. expiresAt is `timestamp without time zone` and
 * Prisma stores UTC, so the seed also uses `now() AT TIME ZONE 'UTC'`.
 */

const names: string[] = [];

/** A fresh lease row, expiresAt = (db now UTC) + offsetSeconds, held by `holder`. */
async function seedLease(offsetSeconds: number, holder = ""): Promise<string> {
  const name = `test-${randomUUID()}`;
  names.push(name);
  await prisma.$executeRaw`
    INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
    VALUES (
      ${name}, ${holder},
      (now() AT TIME ZONE 'UTC') + (${offsetSeconds}::int * interval '1 second'),
      now() AT TIME ZONE 'UTC'
    )
  `;
  return name;
}

afterAll(async () => {
  if (names.length > 0) {
    await prisma.jobLease.deleteMany({ where: { name: { in: names } } });
  }
});

describe("withLease", () => {
  it("runs the body exactly once under concurrent contention (no double-execute)", async () => {
    const RACERS = 8;
    const name = await seedLease(-60); // free (expired 60s ago)
    let started = 0;
    let maxConcurrent = 0;
    let active = 0;
    let settled = 0; // withLease calls that have returned (losers + finished winner)

    // The winner's body must KEEP HOLDING the lease until every other racer has
    // lost its acquire — otherwise a straggler could win the lease after the
    // winner releases (legitimate re-acquire), inflating `started` and making the
    // test flaky. Deterministic signal (no sleeps): the losers return immediately
    // after a 0-row acquire, so once RACERS-1 calls have settled, only the winner
    // is left holding — safe to release it. In prod the body runs for the whole
    // job duration, so the lease is genuinely held across the tick; this models
    // that without timing assumptions.
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((r) => (releaseBarrier = r));

    const body = async () => {
      started += 1;
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await barrier;
      active -= 1;
    };

    const racers = Array.from({ length: RACERS }, () =>
      withLease(name, 60_000, body).finally(() => {
        settled += 1;
        // All losers have returned; only the blocked winner remains. Let it go.
        if (settled >= RACERS - 1) releaseBarrier();
      }),
    );
    await Promise.all(racers);

    // Exactly one replica ran the body, and it was never run concurrently.
    expect(started).toBe(1);
    expect(maxConcurrent).toBe(1);
  });

  it("re-acquires after the previous holder releases", async () => {
    const name = await seedLease(-60);
    let runs = 0;
    const body = async () => {
      runs += 1;
    };

    await withLease(name, 60_000, body); // wins, runs, releases on completion
    await withLease(name, 60_000, body); // lease is free again -> wins again

    expect(runs).toBe(2);
  });

  it("self-heals: acquires a lease whose holder died (expired in the past)", async () => {
    // Simulate a crashed replica that grabbed the lease and never released.
    const name = await seedLease(-1, "dead-replica:999");

    let ran = false;
    await withLease(name, 60_000, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it("does NOT run when another replica holds an unexpired lease", async () => {
    // Lease held by someone else, valid well into the future.
    const name = await seedLease(60, "other-replica:1");

    let ran = false;
    await withLease(name, 60_000, async () => {
      ran = true;
    });

    expect(ran).toBe(false);

    // And the existing holder/expiry are untouched (we didn't stomp the lease).
    const row = await prisma.jobLease.findUniqueOrThrow({ where: { name } });
    expect(row.holder).toBe("other-replica:1");
  });

  it("releases the lease even if the body throws", async () => {
    const name = await seedLease(-60);
    await expect(
      withLease(name, 60_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Released (expiresAt pulled into the past) so the next tick can re-acquire.
    let ran = false;
    await withLease(name, 60_000, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
