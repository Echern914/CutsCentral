import { describe, expect, it } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { claimDueSends } from "./broadcastWorker.js";

/**
 * 🔴 A CLAIM TAKES AT MOST ITS LIMIT, UNDER ANY PLAN (#445).
 *
 * `UPDATE ... WHERE "id" IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` can
 * be planned as a nested-loop semi-join that re-runs the locked sub-select for
 * every outer row. Each re-run skips the rows this same UPDATE already changed,
 * so LIMIT 1 keeps handing back the next row: "asked for one, handed four".
 * Which plan is chosen depends on table statistics, so the broadcast tests
 * failed only some of the time, only on a long-lived test database.
 *
 * This test builds the statistics that pick that plan, deterministically: TEMP
 * copies of the two tables (they shadow the real ones in this session only),
 * a page with no live rows when ANALYZE ran, and the planner switches that
 * rule out the plans that run the sub-select once. Everything happens inside
 * ONE transaction that is always rolled back, so no shared row or statistic
 * is touched.
 *
 * The OLD shape runs first as a control: it MUST over-claim here, or this
 * harness is not reaching the bad plan and the real assertion proves nothing.
 */

const OLD_SHAPE_CLAIM = `
  UPDATE "BroadcastSend" SET "claimedAt" = now()::timestamp, "claimToken" = 'old_shape', "updatedAt" = now()
   WHERE "id" IN (
     SELECT s."id" FROM "BroadcastSend" s JOIN "Broadcast" b ON b."id" = s."broadcastId"
      WHERE s."status" = 'PENDING' AND b."status" IN ('QUEUED','SENDING') AND s."shopId" = 'shop1'
        AND (s."nextAttemptAt" IS NULL OR s."nextAttemptAt" <= now()::timestamp)
        AND (s."claimedAt" IS NULL OR s."claimedAt" < (now() - interval '5 minutes')::timestamp)
      ORDER BY s."nextAttemptAt" NULLS FIRST, s."createdAt"
      LIMIT 1
      FOR UPDATE OF s SKIP LOCKED)
  RETURNING "id"`;

class Rollback extends Error {}

/** Run `body` against the bad-plan harness, then roll everything back. */
async function underTheReRunPlan<T>(body: (tx: Prisma.TransactionClient) => Promise<T>) {
  let out: T | undefined;
  try {
    await prisma.$transaction(
      async (tx) => {
        const ex = (s: string) => tx.$executeRawUnsafe(s);
        await ex(`CREATE TEMP TABLE "Broadcast" (LIKE public."Broadcast" INCLUDING DEFAULTS) ON COMMIT DROP`);
        await ex(
          `CREATE TEMP TABLE "BroadcastSend" (LIKE public."BroadcastSend" INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP`,
        );
        await ex(
          `INSERT INTO "Broadcast" ("id","shopId","channel","body","status","updatedAt") VALUES ('b1','shop1','email','x','QUEUED', now())`,
        );
        const four = (prefix: string) =>
          ex(`INSERT INTO "BroadcastSend" ("id","broadcastId","shopId","clientId","nextAttemptAt")
              SELECT '${prefix}' || g, 'b1', 'shop1', 'c' || g, 'epoch'::timestamp FROM generate_series(1, 4) g`);
        // The statistics that pick the re-run plan: a page exists, but ANALYZE saw no live rows.
        await four("old");
        await ex(`DELETE FROM "BroadcastSend"`);
        await ex(`ANALYZE "BroadcastSend"`);
        await ex(`ANALYZE "Broadcast"`);
        // Four due recipients from one freeze, sharing a createdAt - as broadcast.ts writes them.
        await four("s");
        for (const knob of ["hashjoin", "mergejoin", "material", "hashagg", "sort"]) {
          await ex(`SET LOCAL enable_${knob} = off`);
        }
        out = await body(tx);
        throw new Rollback();
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out as T;
}

describe("a claim never takes more than its LIMIT (#445)", () => {
  it("control: the OLD `IN (... LIMIT 1 FOR UPDATE SKIP LOCKED)` shape over-claims under this plan", async () => {
    const claimed = await underTheReRunPlan((tx) => tx.$queryRawUnsafe<{ id: string }[]>(OLD_SHAPE_CLAIM));
    // If this ever stops being > 1, the harness no longer reaches the bad plan
    // and the next test would pass for the wrong reason.
    expect(claimed.length).toBeGreaterThan(1);
  });

  it("🔴 the broadcast claim takes exactly its LIMIT under the same plan", async () => {
    const now = new Date();
    const one = await underTheReRunPlan((tx) =>
      claimDueSends(tx, {
        now,
        staleBefore: new Date(now.getTime() - 5 * 60_000),
        batch: 1,
        claimToken: randomToken(8),
        shopId: "shop1",
      }),
    );
    expect(one).toHaveLength(1);

    const two = await underTheReRunPlan((tx) =>
      claimDueSends(tx, {
        now,
        staleBefore: new Date(now.getTime() - 5 * 60_000),
        batch: 2,
        claimToken: randomToken(8),
        shopId: "shop1",
      }),
    );
    expect(two).toHaveLength(2);
  });
});
