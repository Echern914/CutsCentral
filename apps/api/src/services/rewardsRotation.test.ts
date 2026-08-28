import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * The platform rotation RUN: durable, exclusive, resumable.
 *
 * Every test here confines the traversal to its own shop via `__testScope` -
 * a real unscoped run would rotate every client in the shared test database
 * and flake every suite beside this one. The production path takes no scope
 * at all, and that is pinned separately (rewardsRotationRoute.test.ts).
 *
 * Wallet pokes are mocked so pass-refresh outcomes are decided by the test
 * rather than by whether APNs certs happen to be configured.
 */

type PokeResult = import("../wallet/pass.js").WalletPokeResult;
type Readiness = import("../wallet/pass.js").WalletDeliveryReadiness;

const poke = vi.hoisted(() =>
  vi.fn(async (_clientId: string): Promise<PokeResult> => "delivered"),
);
const readiness = vi.hoisted(() => vi.fn((): Readiness => "ready"));
vi.mock("../wallet/pass.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../wallet/pass.js")>();
  return { ...real, pokeWalletPass: poke, walletDeliveryReadiness: readiness };
});

import { createApp } from "../app.js";
import {
  processRotationRun,
  readLatestRotationRun,
  startOrGetRotationRun,
  ROTATE_ALL_KIND,
} from "./rewardsRotation.js";

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let ownerCookie: string;
let shopId: string;
let adminUserId: string;

async function signupAndShop(label: string, shopName: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, smsAttested: true });
  const user = await prisma.user.findUnique({ where: { email } });
  return { cookie, shopId: shop.body.id as string, userId: user!.id };
}

/** A client with a DETERMINISTIC createdAt, so "inside/outside the corpus
 * cutoff" is never a same-millisecond coin flip. */
async function clientAt(offsetMs: number, cutoff: Date): Promise<string> {
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", ownerCookie)
    .send({ firstName: "Corpus" });
  expect(created.status).toBe(201);
  await prisma.client.update({
    where: { id: created.body.id },
    data: { createdAt: new Date(cutoff.getTime() + offsetMs) },
  });
  return created.body.id as string;
}

const tokenOf = async (id: string) =>
  (await prisma.client.findUnique({ where: { id } }))!.magicToken;

const runRow = () =>
  prisma.platformOperation.findFirst({
    where: { kind: ROTATE_ALL_KIND },
    orderBy: { createdAt: "desc" },
  });

beforeAll(async () => {
  const a = await signupAndShop("prot-owner", "Platform Rotate Cuts");
  ownerCookie = a.cookie;
  shopId = a.shopId;
  adminUserId = a.userId;
});

beforeEach(() => {
  poke.mockReset();
  poke.mockResolvedValue("delivered");
  readiness.mockReset();
  readiness.mockReturnValue("ready");
});

/** Start a run and assert it was not refused - most cases are about the
 * traversal, not the preflight. */
async function startRun(now?: Date) {
  const r = await startOrGetRotationRun({ adminUserId, ...(now ? { now } : {}) });
  if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
  return r;
}

afterEach(async () => {
  // A leftover PENDING/RUNNING row would block the next test's run creation
  // (that is the whole point of the partial unique index).
  await prisma.platformOperation.deleteMany({ where: { kind: ROTATE_ALL_KIND } });
  // 🔴 And leftover CLIENTS would silently widen the next case's corpus: the
  // scope is the shop, and every fixture is backdated before its own cutoff,
  // so yesterday's rows are inside tomorrow's run. Counts would drift.
  await prisma.client.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("exclusivity", () => {
  it("two concurrent requests create exactly ONE run", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => startOrGetRotationRun({ adminUserId })),
    );
    for (const r of results) expect(r.ok).toBe(true);
    const handles = results.filter((r) => r.ok);
    const ids = new Set(handles.map((r) => r.runId));
    expect(ids.size).toBe(1);
    expect(handles.filter((r) => r.created)).toHaveLength(1);
    const rows = await prisma.platformOperation.findMany({
      where: { kind: ROTATE_ALL_KIND },
    });
    expect(rows).toHaveLength(1);
  });

  it("a second request while RUNNING joins the same run, never a new traversal", async () => {
    const first = await startRun();
    await prisma.platformOperation.update({
      where: { id: first.runId },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    const second = await startRun();
    expect(second.runId).toBe(first.runId);
    expect(second.created).toBe(false);
    expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(1);
  });

  it("resumes a FAILED run rather than starting a fresh one", async () => {
    const first = await startRun();
    await prisma.platformOperation.update({
      where: { id: first.runId },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorCode: "batch_error",
        checkpoint: "somewhere",
        rotatedCount: 7,
      },
    });
    const resumed = await startRun();
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.status).toBe("PENDING");
    const row = await runRow();
    // The progress survives: checkpoint and counts are NOT reset, so no
    // client rotates twice for this run.
    expect(row!.checkpoint).toBe("somewhere");
    expect(row!.rotatedCount).toBe(7);
    expect(row!.errorCode).toBeNull();
  });
});

describe("the corpus boundary and the traversal", () => {
  it("rotates every client inside the cutoff exactly once, and excludes later ones", async () => {
    const cutoff = new Date();
    const inside = [
      await clientAt(-3 * 3600_000, cutoff),
      await clientAt(-2 * 3600_000, cutoff),
      await clientAt(-1 * 3600_000, cutoff),
    ];
    // Created DURING the run: excluded by design - its link postdates the
    // write-side hygiene, so no stored body ever carried it.
    const after = await clientAt(+3600_000, cutoff);

    const before = new Map<string, string>();
    for (const id of [...inside, after]) before.set(id, await tokenOf(id));

    const run = await startRun(cutoff);
    const tick = await processRotationRun({
      batchSize: 2,
      __testScope: { shopId },
    });
    expect(tick!.runId).toBe(run.runId);
    expect(tick!.done).toBe(true);

    for (const id of inside) {
      expect(await tokenOf(id)).not.toBe(before.get(id));
    }
    expect(await tokenOf(after)).toBe(before.get(after));

    const row = await runRow();
    expect(row!.status).toBe("COMPLETED");
    expect(row!.rotatedCount).toBe(inside.length);
    expect(row!.completedAt).not.toBeNull();
  });

  it("resumes after an interrupted run without re-rotating completed clients", async () => {
    const cutoff = new Date();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await clientAt(-(i + 1) * 3600_000, cutoff));
    const original = new Map<string, string>();
    for (const id of ids) original.set(id, await tokenOf(id));

    await startRun(cutoff);

    // One committed batch, then the process "dies": maxBatches models exactly
    // the on-disk state a kill -9 after a committed batch leaves behind.
    const first = await processRotationRun({
      batchSize: 2,
      maxBatches: 1,
      __testScope: { shopId },
    });
    expect(first!.rotated).toBe(2);
    expect(first!.done).toBe(false);
    const mid = await runRow();
    expect(mid!.status).toBe("RUNNING");
    expect(mid!.checkpoint).not.toBeNull();

    // Snapshot what the FIRST batch minted - it must survive the restart
    // untouched (a second rotation would be a silent double-rotate). Which
    // rows those are is decided by what actually CHANGED, never by comparing
    // ids to the checkpoint in JS - that would assume the database's
    // collation matches UTF-16 ordering.
    const rotatedFirst = new Map<string, string>();
    for (const id of ids) {
      const now = await tokenOf(id);
      if (now !== original.get(id)) rotatedFirst.set(id, now);
    }
    expect(rotatedFirst.size).toBe(2);

    // Restart: a fresh worker tick picks the run back up at the checkpoint.
    const second = await processRotationRun({ batchSize: 2, __testScope: { shopId } });
    expect(second!.done).toBe(true);

    for (const [id, token] of rotatedFirst) {
      expect(await tokenOf(id)).toBe(token); // unchanged across the resume
    }
    const row = await runRow();
    expect(row!.rotatedCount).toBe(5); // exactly once each, no double count
    expect(row!.status).toBe("COMPLETED");
  });

  it("returns null when there is no active run (the steady state)", async () => {
    expect(await processRotationRun({ __testScope: { shopId } })).toBeNull();
  });
});

describe("wallet pass refresh, tracked independently", () => {
  async function clientWithPass(cutoff: Date): Promise<string> {
    const id = await clientAt(-3600_000, cutoff);
    await prisma.walletPassRegistration.create({
      data: {
        shopId,
        clientId: id,
        deviceLibraryIdentifier: `dev-${randomToken(6)}`,
        pushToken: randomToken(8),
      },
    });
    return id;
  }

  it("a failed push never rolls back or repeats the token rotation", async () => {
    const cutoff = new Date();
    const id = await clientWithPass(cutoff);
    const before = await tokenOf(id);
    poke.mockResolvedValue("attempted_failure"); // APNs refusing, every attempt

    await startRun(cutoff);
    await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    const afterFirst = await tokenOf(id);
    expect(afterFirst).not.toBe(before); // rotated once...

    // ...and stays exactly that across every retry tick.
    await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    expect(await tokenOf(id)).toBe(afterFirst);

    const task = await prisma.platformOperationPassTask.findFirst({
      where: { clientId: id },
    });
    expect(task!.status).toBe("FAILED"); // gave up after the attempt cap
    const row = await runRow();
    expect(row!.rotatedCount).toBe(1); // NOT re-rotated by the retries
    expect(row!.passFailedCount).toBe(1);
    expect(row!.passPendingCount).toBe(0);
  });

  it("an interrupted push resumes on its own, without touching the token", async () => {
    const cutoff = new Date();
    const id = await clientWithPass(cutoff);
    poke.mockResolvedValue("attempted_failure");

    await startRun(cutoff);
    await processRotationRun({ batchSize: 10, maxBatches: 1, __testScope: { shopId } });
    const rotated = await tokenOf(id);
    const midTask = await prisma.platformOperationPassTask.findFirst({
      where: { clientId: id },
    });
    // The property that matters: the refresh is RETRYABLE, not abandoned and
    // not terminal. (A tick retries within its own budget, so the exact
    // attempt count is the worker's business, not the contract's.)
    expect(midTask!.status).toBe("PENDING");
    expect(midTask!.attempts).toBeGreaterThanOrEqual(1);
    expect(midTask!.attempts).toBeLessThan(3);

    // The device comes back; the next tick finishes the refresh alone.
    poke.mockResolvedValue("delivered");
    await processRotationRun({ batchSize: 10, __testScope: { shopId } });

    const task = await prisma.platformOperationPassTask.findFirst({
      where: { clientId: id },
    });
    expect(task!.status).toBe("SUCCEEDED");
    expect(await tokenOf(id)).toBe(rotated); // token never re-rolled
    const row = await runRow();
    expect(row!.status).toBe("COMPLETED");
    expect(row!.passSucceededCount).toBe(1);
    expect(row!.rotatedCount).toBe(1);
  });

  it("does not complete the run while a pass refresh is still pending", async () => {
    const cutoff = new Date();
    await clientWithPass(cutoff);
    poke.mockResolvedValue("attempted_failure");
    await startRun(cutoff);
    const tick = await processRotationRun({
      batchSize: 10,
      maxBatches: 1,
      __testScope: { shopId },
    });
    expect(tick!.done).toBe(false);
    expect((await runRow())!.status).toBe("RUNNING");
  });
});

describe("wallet delivery unavailable", () => {
  async function clientWithPass(cutoff: Date): Promise<string> {
    const id = await clientAt(-3600_000, cutoff);
    await prisma.walletPassRegistration.create({
      data: {
        shopId,
        clientId: id,
        deviceLibraryIdentifier: `dev-${randomToken(6)}`,
        pushToken: randomToken(8),
      },
    });
    return id;
  }

  for (const state of ["unconfigured", "suppressed"] as const) {
    it(`REFUSES a brand-new run when passes exist and delivery is ${state}`, async () => {
      const cutoff = new Date();
      const id = await clientWithPass(cutoff);
      const before = await tokenOf(id);
      readiness.mockReturnValue(state);

      const res = await startOrGetRotationRun({ adminUserId, now: cutoff });
      expect(res).toEqual({ ok: false, reason: "wallet_refresh_unavailable" });
      // Nothing created, nothing rotated, nothing enqueued.
      expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(0);
      expect(await prisma.platformOperationPassTask.count()).toBe(0);
      expect(await tokenOf(id)).toBe(before);
      expect(poke).not.toHaveBeenCalled();
    });
  }

  it("STARTS normally with zero registrations, however wallet is configured", async () => {
    const cutoff = new Date();
    const id = await clientAt(-3600_000, cutoff); // no pass registration
    const before = await tokenOf(id);
    readiness.mockReturnValue("unconfigured");

    const run = await startOrGetRotationRun({ adminUserId, now: cutoff });
    expect(run.ok).toBe(true);
    const tick = await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    expect(tick!.done).toBe(true);
    expect(await tokenOf(id)).not.toBe(before); // there was no QR to strand
    expect((await runRow())!.status).toBe("COMPLETED");
  });

  it("holds a task PENDING through an outage, spends NO attempt, and keeps the run RUNNING", async () => {
    const cutoff = new Date();
    const id = await clientWithPass(cutoff);
    const before = await tokenOf(id);
    await startRun(cutoff);

    // The outage begins AFTER the run is durable: the worker meets it mid-run.
    poke.mockResolvedValue("retryable_unavailable");
    const tick = await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    expect(tick!.done).toBe(false);

    const rotated = await tokenOf(id);
    expect(rotated).not.toBe(before); // rotated exactly once, by the batch

    for (let i = 0; i < 3; i++) {
      await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    }
    const stalled = await prisma.platformOperationPassTask.findFirst({
      where: { clientId: id },
    });
    expect(stalled!.status).toBe("PENDING");
    // 🔴 An outage is not an attempt: repeated ticks must not burn the cap.
    expect(stalled!.attempts).toBe(0);
    const midRow = await runRow();
    expect(midRow!.status).toBe("RUNNING"); // a pending pass blocks completion
    expect(midRow!.passPendingCount).toBe(1);
    expect(midRow!.passSucceededCount).toBe(0);
    expect(midRow!.passFailedCount).toBe(0);

    // Delivery comes back: the very next tick finishes the refresh.
    poke.mockResolvedValue("delivered");
    const recovered = await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    expect(recovered!.done).toBe(true);

    const task = await prisma.platformOperationPassTask.findFirst({
      where: { clientId: id },
    });
    expect(task!.status).toBe("SUCCEEDED");
    // 🔴 The token is IDENTICAL across the outage and the recovery: rotated
    // exactly once, never re-rolled by a configuration problem.
    expect(await tokenOf(id)).toBe(rotated);
    const row = await runRow();
    expect(row!.status).toBe("COMPLETED");
    expect(row!.rotatedCount).toBe(1);
    expect(row!.passSucceededCount).toBe(1);
  });

  it("treats an unregistered/deleted pass as nothing_to_do, not a failure", async () => {
    const cutoff = new Date();
    const id = await clientWithPass(cutoff);
    poke.mockResolvedValue("nothing_to_do"); // every device pruned as 410

    await startRun(cutoff);
    const tick = await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    expect(tick!.done).toBe(true);

    const task = await prisma.platformOperationPassTask.findFirst({
      where: { clientId: id },
    });
    expect(task!.status).toBe("SUCCEEDED");
    const row = await runRow();
    expect(row!.passSucceededCount).toBe(1);
    expect(row!.passFailedCount).toBe(0);
    expect(row!.status).toBe("COMPLETED");
  });
});

describe("the run record holds nothing person-shaped", () => {
  it("stores no token, URL, phone, name or body - only state and counts", async () => {
    const cutoff = new Date();
    const id = await clientAt(-3600_000, cutoff);
    await prisma.client.update({
      where: { id },
      data: { firstName: "Zebediah", lastName: "Quill", phone: "+12125557788" },
    });
    const oldToken = await tokenOf(id);

    await startRun(cutoff);
    await processRotationRun({ batchSize: 10, __testScope: { shopId } });
    const newToken = await tokenOf(id);

    const row = await runRow();
    const flat = JSON.stringify(row);
    for (const secret of [oldToken, newToken, "Zebediah", "Quill", "+12125557788", "/r/", "http"]) {
      expect(flat).not.toContain(secret);
    }
    // The same holds for the API-shaped status read.
    const status = JSON.stringify(await readLatestRotationRun());
    for (const secret of [oldToken, newToken, "Zebediah", "+12125557788"]) {
      expect(status).not.toContain(secret);
    }
    // Pass tasks reference a client by ID only - no denormalized identity.
    const task = await prisma.platformOperationPassTask.findFirst({
      where: { operationId: row!.id },
    });
    expect(JSON.stringify(task ?? {})).not.toContain("Zebediah");
  });
});
