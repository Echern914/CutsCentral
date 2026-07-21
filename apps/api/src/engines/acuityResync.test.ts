import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { runAcuityResync } from "./acuityResync.js";

/**
 * The Acuity re-sync sweep talks to the live Acuity API per connected shop, so
 * the meaningful ingest path is exercised by the shared ingest tests (webhook +
 * backfill). What we pin here is the SAFE no-op contract the scheduler depends
 * on: with no Acuity connections the sweep must query cleanly, ingest nothing,
 * and never throw - so the cron tick is harmless on envs (local, most shops)
 * that have never connected Acuity.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

describe("runAcuityResync", () => {
  it("is a clean no-op when no shops have an Acuity connection", async () => {
    // The local/test DB has no AcuityConnection rows; if a run ever seeds one,
    // this still holds because the sweep returns the ingested count (0 here).
    const existing = await prisma.acuityConnection.count();
    if (existing === 0) {
      await expect(runAcuityResync()).resolves.toBe(0);
    } else {
      // Defensive: on a DB that happens to have a connection, just assert it
      // resolves to a number and does not throw (can't hit live Acuity in CI).
      await expect(runAcuityResync()).resolves.toEqual(expect.any(Number));
    }
  });
});
