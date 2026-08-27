import { createHash } from "node:crypto";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  markLeft,
  WalkInIllegalTransitionError,
  WalkInStaleTransitionError,
} from "./walkInQueue.js";
import { estimateQueue, type EntryForEstimate } from "./walkInEstimate.js";
import { ACTIVE_STATUSES, QUEUE_ORDER } from "./walkInLifecycle.js";

/**
 * "My Place in Line": the tracking credential exchange and the one read the
 * customer page is allowed to make.
 *
 * TWO CREDENTIALS, ONE OWNER. The SMS carries the TRACK TOKEN in a URL
 * FRAGMENT (#t=...), which browsers never send to any server - so it cannot
 * land in an access log or a Referer header. The page exchanges it exactly
 * once (POST body) for a bounded TRACKING SESSION; every later read carries
 * the session in a POST body. Both are 256-bit random values stored hash-only,
 * both are bound to exactly one entry (and through it one shop), and token
 * rotation or terminal cleanup invalidates everything downstream.
 *
 * Unknown, expired, revoked and foreign credentials all collapse into ONE
 * generic refusal - this surface must never become an oracle for which
 * tokens, entries, shops or phones exist.
 */

function sha256Hex(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

/** A session never outlives the entry's day and is re-checked server-side on
 * every read; 12h is the ceiling for a very early join. */
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

const ACTIVE = [...ACTIVE_STATUSES];

export type ExchangeOutcome = { ok: true; session: string } | { ok: false };

/**
 * One-time bootstrap: fragment token in, bounded session out. Re-opening the
 * SMS link re-exchanges and OVERWRITES the previous session - one live
 * session per entry, newest wins.
 */
export async function exchangeTrackToken(opts: {
  token: string;
  now: Date;
}): Promise<ExchangeOutcome> {
  const { token, now } = opts;
  if (token.length < 20 || token.length > 512) return { ok: false };
  const entry = await prisma.walkInEntry.findUnique({
    where: { trackTokenHash: sha256Hex(token) },
    select: {
      id: true,
      trackTokenExpiresAt: true,
      trackTokenRevokedAt: true,
    },
  });
  if (
    !entry ||
    entry.trackTokenRevokedAt ||
    !entry.trackTokenExpiresAt ||
    entry.trackTokenExpiresAt.getTime() <= now.getTime()
  ) {
    return { ok: false };
  }
  const session = randomToken(32);
  await prisma.walkInEntry.update({
    where: { id: entry.id },
    data: {
      trackSessionHash: sha256Hex(session),
      trackSessionExpiresAt: new Date(
        Math.min(
          entry.trackTokenExpiresAt.getTime(),
          now.getTime() + SESSION_MAX_MS,
        ),
      ),
    },
  });
  return { ok: true, session };
}

/** Resolve a session to its entry, or the one generic nothing. */
async function entryForSession(session: string, now: Date) {
  if (session.length < 20 || session.length > 512) return null;
  const entry = await prisma.walkInEntry.findUnique({
    where: { trackSessionHash: sha256Hex(session) },
    include: { services: true },
  });
  if (
    !entry ||
    !entry.trackSessionExpiresAt ||
    entry.trackSessionExpiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  return entry;
}

export interface TrackStatus {
  shopName: string;
  status: string;
  services: { name: string; durationMin: number }[];
  /** Display name only, and only the caller's own barber. */
  barberName: string | null;
  barberIsAssigned: boolean;
  ahead: number | null;
  waitMin: number | null;
  startsAt: string | null;
  acceptingNow: boolean;
  updatedAt: string;
}

export type StatusOutcome = { ok: true; status: TrackStatus } | { ok: false };

/**
 * Everything the customer page may know, recomputed LIVE from the queue and
 * the calendar via the one estimate engine - never a cached number replayed
 * as truth, and never one byte about anyone else in the line.
 */
export async function trackStatus(opts: {
  session: string;
  now: Date;
}): Promise<StatusOutcome> {
  const { session, now } = opts;
  const entry = await entryForSession(session, now);
  if (!entry) return { ok: false };

  const shop = await prisma.shop.findUnique({
    where: { id: entry.shopId },
    select: { name: true, walkInAcceptingNow: true },
  });
  if (!shop) return { ok: false };

  const services = [...entry.services]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({ name: s.nameAtJoin, durationMin: s.durationMinAtJoin }));

  // Terminal entries still answer (the customer deserves to see "you left
  // the line" rather than a dead link) - with no queue math.
  const isActive = (ACTIVE as string[]).includes(entry.status);
  let ahead: number | null = null;
  let waitMin: number | null = null;
  let startsAt: string | null = null;
  if (isActive) {
    const queueRows = await prisma.walkInEntry.findMany({
      where: { shopId: entry.shopId, status: { in: ACTIVE } },
      orderBy: [...QUEUE_ORDER],
      select: {
        id: true,
        status: true,
        position: true,
        joinedAt: true,
        preferredStaffId: true,
        assignedStaffId: true,
        services: { select: { serviceId: true, durationMinAtJoin: true } },
      },
    });
    const queue: EntryForEstimate[] = queueRows.map((e) => ({
      id: e.id,
      status: e.status,
      position: e.position,
      joinedAt: e.joinedAt,
      preferredStaffId: e.preferredStaffId,
      assignedStaffId: e.assignedStaffId,
      totalDurationMin: e.services.reduce(
        (s, x) => s + x.durationMinAtJoin,
        0,
      ),
      serviceIds: e.services.map((x) => x.serviceId),
    }));
    const mine = queueRows.findIndex((e) => e.id === entry.id);
    ahead = mine >= 0 ? mine : null;
    const est = await estimateQueue({ shopId: entry.shopId, now, queue });
    const own = est.get(entry.id);
    waitMin = own?.waitMin ?? null;
    startsAt = own?.startsAt ? own.startsAt.toISOString() : null;
  }

  // The barber shown is the CALLER'S: assigned wins, else their stated
  // preference. Display name only - the same exposure the public booking
  // page already makes.
  const barberId = entry.assignedStaffId ?? entry.preferredStaffId;
  const barber = barberId
    ? await prisma.staff.findFirst({
        where: { id: barberId, shopId: entry.shopId },
        select: { name: true },
      })
    : null;

  return {
    ok: true,
    status: {
      shopName: shop.name,
      status: entry.status,
      services,
      barberName: barber?.name ?? null,
      barberIsAssigned: Boolean(entry.assignedStaffId),
      ahead,
      waitMin,
      startsAt,
      acceptingNow: shop.walkInAcceptingNow,
      updatedAt: now.toISOString(),
    },
  };
}

export type LeaveOutcome =
  | { ok: true; status: string }
  | { ok: false };

/**
 * Leave the line - the customer's ONE write, through the lifecycle engine's
 * CAS. Repeated or raced taps are answered with the entry's current state,
 * never a partial write and never an error that leaks mechanics.
 */
export async function trackLeave(opts: {
  session: string;
  now: Date;
}): Promise<LeaveOutcome> {
  const { session, now } = opts;
  const entry = await entryForSession(session, now);
  if (!entry) return { ok: false };
  try {
    const left = await markLeft({
      shopId: entry.shopId,
      entryId: entry.id,
      actor: { kind: "customer" },
      now,
    });
    return { ok: true, status: left.status };
  } catch (err) {
    if (
      err instanceof WalkInIllegalTransitionError ||
      err instanceof WalkInStaleTransitionError
    ) {
      // Already terminal, a repeat tap, or a raced twin that lost the CAS:
      // answer with where the entry actually is. Idempotently safe - the CAS
      // guarantees no partial state, this branch guarantees no scary error.
      const current = await prisma.walkInEntry.findUnique({
        where: { id: entry.id },
        select: { status: true },
      });
      return current ? { ok: true, status: current.status } : { ok: false };
    }
    throw err;
  }
}
