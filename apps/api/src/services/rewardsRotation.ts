import { Prisma, forShop, prisma, runAsOwner } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { captureError } from "../sentry.js";
import { pokeWalletPass } from "../wallet/pass.js";

/**
 * magicToken rotation - the READ-side answer to the credential corpus.
 *
 * The write-side hygiene (messaging/auditBody.ts) stops NEW bearer URLs from
 * being stored, but months of Nudge history, message threads, screenshots and
 * forwarded texts already carry /r/<magicToken> links, and a magicToken never
 * expires. Rotation is the only operation that retires that corpus: mint a
 * fresh token, and every previously issued link for the client dies at once -
 * wherever it sits, including places no scrubber can reach.
 *
 * What a rotation breaks, and why that's now survivable:
 * - Old texted links land on the /r dead-link page, which offers the
 *   phone-recovery door (/my-rewards, #340 + #342). The verified phone is
 *   the identity; the link was always just the shortcut.
 * - The Apple Wallet pass QR embeds the rewards URL, so rotation POKES the
 *   pass: registered devices re-fetch and get the current token baked in.
 *   Un-poked or offline passes scan to the dead-link page - same door.
 * - A mobile app that adopted the old token cold-starts onto the dead-link
 *   page inside its WebView and recovers through the same door; builds with
 *   the native recovery flow (#340) re-adopt cleanly.
 *
 * NEVER rotate as a side effect. Both entry points are explicit human
 * decisions: a manager retiring one client's leaked link, or the platform
 * run retiring the whole historical corpus.
 */

/** Rotate ONE client's link (manager action, shop-scoped). Archived clients
 * rotate too - an archived client's leaked link is still a live credential. */
export async function rotateClientMagicToken(
  shopId: string,
  clientId: string,
): Promise<"ok" | "not_found"> {
  const client = await forShop(shopId).client.findFirst({
    where: { id: clientId },
  });
  if (!client) return "not_found";
  await runAsOwner((tx) =>
    tx.client.update({
      where: { id: clientId },
      data: { magicToken: randomToken() },
    }),
  );
  // Refresh the Wallet pass QR - best-effort, never blocks the rotation.
  void pokeWalletPass(clientId).catch(() => {});
  logger.info({ shopId, clientId }, "rewards link rotated");
  return "ok";
}

/* ------------------------------------------------------------------------- *
 * The platform-wide corpus retirement: a DURABLE, EXCLUSIVE, RESUMABLE run.
 *
 * Why not a loop in a request handler: the customer table is unbounded, an
 * HTTP timeout or a deploy mid-loop would strand a half-rotated corpus with
 * no resume point, and two admins double-submitting would traverse twice.
 * Instead the admin POST only creates (or resumes) a PlatformOperation row
 * and answers 202; the scheduled `rewards-rotation` job - lease-guarded like
 * every other job, so one replica at a time - does the work in bounded
 * batches:
 *
 * - EXCLUSIVE: at most one PENDING/RUNNING run per kind, enforced by a
 *   partial unique INDEX - two concurrent valid confirmations race INSERTs
 *   and exactly one run exists afterward, whoever wins.
 * - ATOMIC BATCHES: each batch rotates its clients, enqueues their Wallet
 *   pass-refresh tasks and advances the checkpoint in ONE transaction. A
 *   crash rolls the whole batch back; a restart resumes at the last
 *   COMMITTED checkpoint, so no client ever rotates twice for one run and
 *   completed clients keep their newly rotated token.
 * - FIXED CORPUS: only clients with createdAt <= the run's cutoffAt (stamped
 *   at creation) rotate. Clients created during the run are EXCLUDED by
 *   design: their links postdate the write-side hygiene, so no stored body
 *   ever carried them - there is nothing to retire.
 * - PASS REFRESH IS ITS OWN LEDGER: one task per rotated client that holds a
 *   Wallet registration, retried up to PASS_MAX_ATTEMPTS with state tracked
 *   independently of rotation - a failed or interrupted push can never roll
 *   back or repeat a token rotation, and never blocks later batches.
 * - FAILURE HALTS LOUDLY: an unexpected batch error marks the run FAILED
 *   with a FIXED classification (never exception text - a unique-violation
 *   message can embed a live token). The same admin POST resumes it.
 * ------------------------------------------------------------------------- */

export const ROTATE_ALL_KIND = "rewards_rotate_all";
const ACTIVE = ["PENDING", "RUNNING"];
const PASS_MAX_ATTEMPTS = 3;

/**
 * Production gate, DEFAULT FALSE and fail-closed: only the exact string
 * "true" enables the endpoint, anything else (unset, typo, "1") refuses.
 * Enabling it starts nothing - the run still needs the confirm phrase.
 * Deliberately read at call time and not part of the apiEnv schema: a
 * validation throw there takes the API down at boot, the wrong failure mode
 * for an ops switch.
 */
export function rotateAllEnabled(): boolean {
  return process.env.REWARDS_ROTATE_ALL_ENABLED === "true";
}

export interface RotationRunHandle {
  runId: string;
  status: string;
  /** True when this call created a brand-new run (vs returned/resumed one). */
  created: boolean;
}

/**
 * Create the platform rotation run, or return/resume the existing one.
 * Idempotent under concurrency: the partial unique index is the authority,
 * so two simultaneous valid requests produce exactly one run - the loser
 * reads the winner's row. A FAILED run is resumed (back to PENDING, keeping
 * cutoff, checkpoint and counts) rather than replaced.
 */
export async function startOrGetRotationRun(params: {
  adminUserId: string;
  now?: Date;
}): Promise<RotationRunHandle> {
  const now = params.now ?? new Date();

  const active = await runAsOwner((tx) =>
    tx.platformOperation.findFirst({
      where: { kind: ROTATE_ALL_KIND, status: { in: ACTIVE } },
    }),
  );
  if (active) return { runId: active.id, status: active.status, created: false };

  // Resume the latest FAILED run if one exists - CAS so two resumers can't
  // both think they flipped it.
  const failed = await runAsOwner((tx) =>
    tx.platformOperation.findFirst({
      where: { kind: ROTATE_ALL_KIND, status: "FAILED" },
      orderBy: { createdAt: "desc" },
    }),
  );
  if (failed) {
    const flipped = await runAsOwner((tx) =>
      tx.platformOperation.updateMany({
        where: { id: failed.id, status: "FAILED" },
        data: { status: "PENDING", failedAt: null, errorCode: null },
      }),
    );
    if (flipped.count === 1) {
      logger.warn({ runId: failed.id }, "platform rotation run resumed after failure");
      return { runId: failed.id, status: "PENDING", created: false };
    }
  }

  try {
    const run = await runAsOwner((tx) =>
      tx.platformOperation.create({
        data: {
          kind: ROTATE_ALL_KIND,
          status: "PENDING",
          initiatedByUserId: params.adminUserId,
          cutoffAt: now,
        },
        select: { id: true },
      }),
    );
    logger.warn({ runId: run.id }, "platform rotation run created");
    return { runId: run.id, status: "PENDING", created: true };
  } catch (err) {
    // Lost the creation race against the partial unique index - the winner's
    // run IS the run. Anything else is a real error.
    const unique =
      (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") ||
      (err instanceof Error && err.message.includes("one_active_per_kind"));
    if (!unique) throw err;
    const winner = await runAsOwner((tx) =>
      tx.platformOperation.findFirst({
        where: { kind: ROTATE_ALL_KIND, status: { in: ACTIVE } },
      }),
    );
    if (!winner) throw err; // vanished between statements - genuinely odd, surface it
    return { runId: winner.id, status: winner.status, created: false };
  }
}

/** The status read for the admin endpoint: counts and state ONLY. */
export async function readLatestRotationRun() {
  const run = await runAsOwner((tx) =>
    tx.platformOperation.findFirst({
      where: { kind: ROTATE_ALL_KIND },
      orderBy: { createdAt: "desc" },
    }),
  );
  if (!run) return null;
  return {
    runId: run.id,
    status: run.status,
    cutoffAt: run.cutoffAt.toISOString(),
    rotated: run.rotatedCount,
    passPending: run.passPendingCount,
    passSucceeded: run.passSucceededCount,
    passFailed: run.passFailedCount,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    failedAt: run.failedAt?.toISOString() ?? null,
    errorCode: run.errorCode,
  };
}

/**
 * One ATOMIC batch: pick the next `batchSize` clients inside the corpus
 * boundary past the checkpoint, rotate their tokens, enqueue pass tasks for
 * those holding Wallet registrations, and advance the checkpoint - all in a
 * single transaction, in a single SQL statement, so the checkpoint can never
 * disagree with what committed and "max id" is computed under Postgres's own
 * text ordering (never a JS sort, whose collation can differ).
 *
 * Tokens are minted IN SQL (two UUIDs, hyphens stripped: 64 hex chars) so a
 * batch is one set-based statement instead of N round trips; entropy and
 * shape are equivalent to the app's randomToken for this URL-path use, and
 * the column's UNIQUE constraint backstops the astronomically unlikely
 * collision by rolling the batch back.
 */
async function rotateOneBatch(
  runId: string,
  batchSize: number,
  scope: { shopId: string } | undefined,
): Promise<{ rotated: number } | null> {
  return runAsOwner(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`platop:${ROTATE_ALL_KIND}`}))`,
    );
    const run = await tx.platformOperation.findFirst({
      where: { id: runId, status: "RUNNING" },
      select: { cutoffAt: true, checkpoint: true },
    });
    if (!run) return null;

    const scopeFrag = scope
      ? Prisma.sql`AND "shopId" = ${scope.shopId}`
      : Prisma.empty;
    const ckptFrag = run.checkpoint
      ? Prisma.sql`AND "id" > ${run.checkpoint}`
      : Prisma.empty;

    const rows = await tx.$queryRaw<
      { rotated: number; last: string | null; tasks: number }[]
    >(Prisma.sql`
      WITH batch AS (
        SELECT "id" FROM "Client"
        WHERE "createdAt" <= ${run.cutoffAt.toISOString()}::timestamp
          ${scopeFrag}
          ${ckptFrag}
        ORDER BY "id"
        LIMIT ${batchSize}
      ),
      upd AS (
        UPDATE "Client" c
           SET "magicToken" = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
               "updatedAt" = now()
          FROM batch
         WHERE c."id" = batch."id"
        RETURNING c."id"
      ),
      tasks AS (
        INSERT INTO "PlatformOperationPassTask"
          ("id", "operationId", "clientId", "status", "attempts", "createdAt", "updatedAt")
        SELECT replace(gen_random_uuid()::text, '-', ''), ${runId}, r."clientId", 'PENDING', 0, now(), now()
          FROM (
            SELECT DISTINCT "clientId" FROM "WalletPassRegistration"
             WHERE "clientId" IN (SELECT "id" FROM upd)
          ) r
        ON CONFLICT ("operationId", "clientId") DO NOTHING
        RETURNING "clientId"
      )
      SELECT (SELECT count(*) FROM upd)::int  AS rotated,
             (SELECT max("id") FROM upd)      AS last,
             (SELECT count(*) FROM tasks)::int AS tasks`);

    const r = rows[0]!;
    if (r.rotated === 0) return { rotated: 0 };
    await tx.platformOperation.update({
      where: { id: runId },
      data: {
        checkpoint: r.last,
        rotatedCount: { increment: r.rotated },
        passPendingCount: { increment: r.tasks },
      },
    });
    return { rotated: r.rotated };
  });
}

/**
 * Attempt up to `limit` PENDING pass tasks once each. NEVER throws, never
 * touches a token: a push failure increments attempts (FAILED past the cap),
 * an interrupted process leaves the task PENDING for the next tick. Returns
 * how many tasks reached a terminal state this pass.
 */
async function drainPassTasks(runId: string, limit: number): Promise<number> {
  const tasks = await runAsOwner((tx) =>
    tx.platformOperationPassTask.findMany({
      where: { operationId: runId, status: "PENDING" },
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true, clientId: true, attempts: true },
    }),
  );
  let handled = 0;
  for (const t of tasks) {
    let ok = false;
    try {
      ok = await pokeWalletPass(t.clientId);
    } catch {
      ok = false; // pokeWalletPass shouldn't throw; belt anyway
    }
    const attempts = t.attempts + 1;
    const next = ok ? "SUCCEEDED" : attempts >= PASS_MAX_ATTEMPTS ? "FAILED" : "PENDING";
    try {
      await runAsOwner(async (tx) => {
        const upd = await tx.platformOperationPassTask.updateMany({
          where: { id: t.id, status: "PENDING" },
          data: { status: next, attempts },
        });
        if (upd.count === 1 && next !== "PENDING") {
          await tx.platformOperation.update({
            where: { id: runId },
            data: {
              passPendingCount: { decrement: 1 },
              ...(next === "SUCCEEDED"
                ? { passSucceededCount: { increment: 1 } }
                : { passFailedCount: { increment: 1 } }),
            },
          });
        }
      });
      if (next !== "PENDING") handled++;
    } catch {
      // Bookkeeping hiccup: the task stays PENDING and retries next tick.
      // Provider failures must never block later batches - and don't.
    }
  }
  return handled;
}

export interface RotationTickResult {
  runId: string;
  rotated: number;
  passHandled: number;
  done: boolean;
}

/**
 * One worker tick: claim the active run, process batches within the budget,
 * drain pass tasks per completed batch, and complete the run when the corpus
 * is exhausted AND no pass task is still PENDING. Called by the scheduled
 * `rewards-rotation` job (lease-guarded - one replica at a time); returns
 * null when there is no active run, which is the permanent steady state.
 *
 * `opts` beyond `now` exist for the TESTS: `batchSize`/`maxBatches` exercise
 * the keyset resume, `__testScope` confines a run to one shop so a real
 * traversal never rotates the shared test database's other fixtures. The
 * production entry points (the scheduler job, and nothing else) call this
 * with NO arguments - pinned by the scheduler-wiring test.
 */
export async function processRotationRun(
  opts: {
    now?: Date;
    batchSize?: number;
    maxBatches?: number;
    budgetMs?: number;
    __testScope?: { shopId: string };
  } = {},
): Promise<RotationTickResult | null> {
  const batchSize = opts.batchSize ?? 200;
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  const budgetMs = opts.budgetMs ?? 60_000;
  const scope = opts.__testScope;

  const run = await runAsOwner((tx) =>
    tx.platformOperation.findFirst({
      where: { kind: ROTATE_ALL_KIND, status: { in: ACTIVE } },
      select: { id: true, status: true, startedAt: true },
    }),
  );
  if (!run) return null;

  await runAsOwner((tx) =>
    tx.platformOperation.updateMany({
      where: { id: run.id, status: "PENDING" },
      data: { status: "RUNNING", startedAt: run.startedAt ?? (opts.now ?? new Date()) },
    }),
  );

  const startMs = Date.now();
  let rotated = 0;
  let passHandled = 0;
  let batches = 0;
  let corpusDone = false;

  try {
    while (batches < maxBatches && Date.now() - startMs < budgetMs) {
      const batch = await rotateOneBatch(run.id, batchSize, scope);
      if (batch === null) break; // no longer RUNNING - someone intervened
      batches++;
      rotated += batch.rotated;
      // Per completed batch: refresh that batch's passes (and any backlog).
      passHandled += await drainPassTasks(run.id, batchSize);
      if (batch.rotated < batchSize) {
        corpusDone = true;
        break;
      }
    }
  } catch (err) {
    // 🔴 FIXED classification only. The raw error is deliberately NOT logged
    // or forwarded: a unique-violation message can embed a freshly minted
    // token, and "no tokens in logs" outranks debuggability here - the run
    // row holds the checkpoint and counts, and the admin POST resumes.
    await runAsOwner((tx) =>
      tx.platformOperation.updateMany({
        where: { id: run.id, status: "RUNNING" },
        data: { status: "FAILED", failedAt: new Date(), errorCode: "batch_error" },
      }),
    ).catch(() => {});
    logger.error({ runId: run.id, errorCode: "batch_error" }, "platform rotation halted");
    captureError(new Error("rewards_rotation_batch_error"), { runId: run.id });
    return { runId: run.id, rotated, passHandled, done: false };
  }

  if (corpusDone) {
    // Keep draining passes within the budget; retries that stay PENDING keep
    // the run RUNNING for the next tick rather than spinning here.
    while (Date.now() - startMs < budgetMs) {
      const n = await drainPassTasks(run.id, batchSize);
      passHandled += n;
      if (n === 0) break;
    }
    const pendingPasses = await runAsOwner((tx) =>
      tx.platformOperationPassTask.count({
        where: { operationId: run.id, status: "PENDING" },
      }),
    );
    if (pendingPasses === 0) {
      const flipped = await runAsOwner((tx) =>
        tx.platformOperation.updateMany({
          where: { id: run.id, status: "RUNNING" },
          data: { status: "COMPLETED", completedAt: new Date() },
        }),
      );
      if (flipped.count === 1) {
        // The completion AUDIT EVENT: aggregate counts + the run id as the
        // correlation id. Nothing person-shaped exists to include.
        const final = await runAsOwner((tx) =>
          tx.platformOperation.findFirst({ where: { id: run.id } }),
        );
        logger.warn(
          {
            runId: run.id,
            kind: ROTATE_ALL_KIND,
            rotated: final?.rotatedCount ?? rotated,
            passSucceeded: final?.passSucceededCount ?? 0,
            passFailed: final?.passFailedCount ?? 0,
          },
          "platform rotation completed",
        );
      }
      return { runId: run.id, rotated, passHandled, done: true };
    }
  }
  return { runId: run.id, rotated, passHandled, done: false };
}
