import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@chairback/db";
import { runAsOwner } from "@chairback/db";
import { purposeKeys } from "../services/tokenKey.js";

/**
 * CONFIRMATIONS: the only way a booking-chat change runs.
 *
 * A preview writes one AssistantConfirmation row and hands the person a random
 * token; only that person's own tap redeems it. The row - not process memory -
 * is what makes it run ONCE:
 *
 *   pending ──claim (compare-and-set)──▶ running ──▶ done | failed
 *                                          │
 *                       stale (the instance died mid-run)
 *                                          ▼
 *                    re-claimed by one caller, which FIRST checks whether the
 *                    change already happened (turn.ts alreadyApplied) before
 *                    doing anything.
 *
 * So two API instances, two taps, a phone that resends after a lost response,
 * and a restart in the middle all end with the change made once and the same
 * answer given to every caller. The row stores sha256(token), never the token,
 * so a copy of the database cannot confirm anything.
 *
 * It is bound to: the customer account, the shop, the action,
 * its resolved arguments, and a fingerprint of the appointment state the
 * preview was made from - a changed state at the tap gets a fresh preview.
 */

export const CONFIRM_TTL_MS = 5 * 60 * 1000;
/** A run older than this with no answer is presumed dead (an instance restarted). */
export const STALE_RUN_MS = 60 * 1000;

export type ConfirmAction = "book" | "move" | "cancel";

export interface ConfirmRow {
  id: string;
  shopId: string;
  actor: string;
  action: ConfirmAction;
  args: Record<string, string | number>;
  stateKey: string;
  summary: string;
  status: "pending" | "running" | "done" | "failed" | "superseded";
  result: unknown;
  expiresAt: Date;
  claimedAt: Date | null;
}

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export async function mintConfirm(
  c: { actor: string; shopId: string; action: ConfirmAction; args: Record<string, string | number>; stateKey: string; summary: string },
  now = new Date(),
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await runAsOwner((tx) =>
    tx.assistantConfirmation.create({
      data: {
        id: digest(token),
        shopId: c.shopId,
        actor: c.actor,
        action: c.action,
        args: c.args as Prisma.InputJsonValue,
        stateKey: c.stateKey,
        summary: c.summary,
        expiresAt: new Date(now.getTime() + CONFIRM_TTL_MS),
      },
    }),
  );
  return token;
}

export type LoadResult =
  | { ok: true; row: ConfirmRow }
  | { ok: false; reason: "unknown" | "wrong_actor" | "expired" };

export async function loadConfirm(token: string, expect: { actor: string; shopId: string }, now = new Date()): Promise<LoadResult> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { ok: false, reason: "unknown" };
  const row = (await runAsOwner((tx) => tx.assistantConfirmation.findUnique({ where: { id: digest(token) } }))) as ConfirmRow | null;
  // Someone else's token reads exactly like no token: it confirms nothing and
  // says nothing about whose it is.
  if (!row) return { ok: false, reason: "unknown" };
  if (row.actor !== expect.actor || row.shopId !== expect.shopId) return { ok: false, reason: "wrong_actor" };
  if (row.status === "pending" && row.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, row };
}

export type Claim =
  /** This caller runs it. `recovering` = a previous run died; check first. */
  | { kind: "run"; recovering: boolean }
  /** Someone else is running it right now. */
  | { kind: "busy" }
  /** Already settled: replay the stored answer. */
  | { kind: "settled"; row: ConfirmRow }
  | { kind: "expired" };

export async function claimConfirm(id: string, now = new Date()): Promise<Claim> {
  const fresh = await runAsOwner((tx) =>
    tx.assistantConfirmation.updateMany({
      where: { id, status: "pending", expiresAt: { gt: now } },
      data: { status: "running", claimedAt: now },
    }),
  );
  if (fresh.count === 1) return { kind: "run", recovering: false };
  const row = (await runAsOwner((tx) => tx.assistantConfirmation.findUnique({ where: { id } }))) as ConfirmRow | null;
  if (!row) return { kind: "expired" };
  if (row.status === "done" || row.status === "failed" || row.status === "superseded") return { kind: "settled", row };
  if (row.status === "pending") return { kind: "expired" };
  // running: alive, or abandoned by an instance that died mid-run.
  const staleBefore = new Date(now.getTime() - STALE_RUN_MS);
  if (row.claimedAt && row.claimedAt > staleBefore) return { kind: "busy" };
  const retake = await runAsOwner((tx) =>
    tx.assistantConfirmation.updateMany({
      where: { id, status: "running", claimedAt: { lt: staleBefore } },
      data: { claimedAt: now },
    }),
  );
  return retake.count === 1 ? { kind: "run", recovering: true } : { kind: "busy" };
}

export async function settleConfirm(
  id: string,
  status: "done" | "failed" | "superseded",
  result: unknown,
  now = new Date(),
): Promise<void> {
  await runAsOwner((tx) =>
    tx.assistantConfirmation.updateMany({
      where: { id, status: "running" },
      data: { status, result: result as Prisma.InputJsonValue, settledAt: now },
    }),
  );
}

/** A run that threw before changing anything goes back to pending (if still in date). */
export async function releaseConfirm(id: string): Promise<void> {
  await runAsOwner((tx) =>
    tx.assistantConfirmation.updateMany({ where: { id, status: "running" }, data: { status: "pending", claimedAt: null } }),
  );
}

export const confirmId = digest;

// ── pick tokens: what a BUTTON sends ─────────────────────────────────────
// A button the server drew carries its action and RESOLVED arguments (a real
// appointment id, a slot id), signed for this actor and shop. So a tap needs
// no interpretation at all, and a forged or edited button is refused
// like any bad token. Lives 30 minutes: a list left open on a phone. A pick
// only ever leads to a READ or a PREVIEW, so it needs no row: running it twice
// is harmless, and the change itself still waits for a confirmation row.

const PICK_PURPOSE = "assistant-pick";
const PICK_TTL_MS = 30 * 60 * 1000;

export interface PickClaims {
  actor: string;
  shopId: string;
  name: string;
  args: Record<string, string>;
  exp: number;
}

export function signPick(p: Omit<PickClaims, "exp">, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...p, exp: now + PICK_TTL_MS })).toString("base64url");
  return `${body}.${sign(body, purposeKeys(PICK_PURPOSE)[0]!)}`;
}

export function readPick(token: string, expect: { actor: string; shopId: string }, now = Date.now()): PickClaims | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  if (!purposeKeys(PICK_PURPOSE).some((k) => safeEqual(mac, sign(body, k)))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PickClaims;
    if (c.exp <= now || c.actor !== expect.actor || c.shopId !== expect.shopId) return null;
    return c;
  } catch {
    return null;
  }
}

function sign(body: string, key: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
