import {
  apiEnv,
  DEMO,
  platformNoticePushBody,
  platformNoticeState,
  platformNoticeVisible,
  PLATFORM_NOTICE_FIXED_SHOWS_MS,
  type PlatformNoticeSeverity,
  type PlatformNoticeState,
} from "@chairback/config";
import { runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { pushDispatchMode, sendPushToUser } from "../messaging/push.js";

/**
 * PLATFORM NOTICES - the status banner the platform owner posts from the admin
 * portal ("we know about it and we're fixing it"), shown on every barber's
 * dashboard while it is live.
 *
 * 🔴 EVERY QUERY GOES THROUGH runAsOwner. Both tables are FORCE row-level
 * security with no policy (default-deny, the PlatformSwitch shape), and FORCE
 * binds the owner connection too: a plain read in production returns ZERO rows.
 * The local test database connects as a superuser, which bypasses RLS - so a
 * plain query would pass every test and show no banner in production.
 */

export interface NoticeRow {
  id: string;
  title: string;
  body: string;
  severity: string;
  startsAt: Date;
  endsAt: Date | null;
  resolvedAt: Date | null;
  pushedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ROW_SELECT = {
  id: true,
  title: true,
  body: true,
  severity: true,
  startsAt: true,
  endsAt: true,
  resolvedAt: true,
  pushedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** What a barber's dashboard receives. Nothing about who posted it. */
export interface BarberNotice {
  id: string;
  title: string;
  body: string;
  severity: PlatformNoticeSeverity;
  state: "active" | "resolved";
  startsAt: string;
  endsAt: string | null;
  resolvedAt: string | null;
  /**
   * This person closed its banner. The banner leaves it out; the bell still
   * lists it, so a closed notice can be read again while it is live.
   */
  dismissed: boolean;
}

/** The admin list: every field, plus where the notice is in its life. */
export function toAdminNotice(n: NoticeRow, now: Date) {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    severity: n.severity as PlatformNoticeSeverity,
    state: platformNoticeState(n, now) as PlatformNoticeState,
    startsAt: n.startsAt.toISOString(),
    endsAt: n.endsAt?.toISOString() ?? null,
    resolvedAt: n.resolvedAt?.toISOString() ?? null,
    pushedAt: n.pushedAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The barber read: cheap, because every dashboard page load asks it.
// ---------------------------------------------------------------------------

/**
 * How stale another replica may be after an admin writes. This process drops
 * its copy at once on any write; others follow within this window.
 */
export const NOTICE_CACHE_MS = 10_000;

let cache: { at: number; rows: NoticeRow[] } | null = null;

/** Test seam, and what every admin write calls. */
export function __resetNoticeCacheForTests(): void {
  cache = null;
}
const bustCache = __resetNoticeCacheForTests;

/**
 * Every notice that is, or could within the cache window become, visible. One
 * query per process per NOTICE_CACHE_MS however many barbers are loading pages;
 * the per-request filter below applies the exact state at the request's `now`.
 */
async function candidateNotices(now: Date): Promise<NoticeRow[]> {
  if (cache && now.getTime() - cache.at < NOTICE_CACHE_MS && now.getTime() >= cache.at) {
    return cache.rows;
  }
  const rows = await runAsOwner((tx) =>
    tx.platformNotice.findMany({
      where: {
        AND: [
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          {
            OR: [
              { resolvedAt: null },
              { resolvedAt: { gt: new Date(now.getTime() - PLATFORM_NOTICE_FIXED_SHOWS_MS) } },
            ],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: ROW_SELECT,
    }),
  );
  cache = { at: now.getTime(), rows };
  return rows;
}

/** Live problems first, then planned work, then news; a "Fixed" line last. */
const SEVERITY_RANK: Record<string, number> = { issue: 0, maintenance: 1, info: 2 };

/**
 * The notices this person's dashboard should show right now: live or recently
 * fixed, each marked with whether they closed its banner. The dismissal read
 * is skipped entirely when nothing is live - the common case costs no query.
 */
export async function noticesForUser(userId: string, now = new Date()): Promise<BarberNotice[]> {
  const visible = (await candidateNotices(now))
    .map((n) => ({ n, state: platformNoticeState(n, now) }))
    .filter((x) => platformNoticeVisible(x.state));
  if (visible.length === 0) return [];

  const dismissed = await runAsOwner((tx) =>
    tx.platformNoticeDismissal.findMany({
      where: { userId, noticeId: { in: visible.map((x) => x.n.id) } },
      select: { noticeId: true },
    }),
  );
  const closed = new Set(dismissed.map((d) => d.noticeId));

  return visible
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === "active" ? -1 : 1;
      const r = (SEVERITY_RANK[a.n.severity] ?? 9) - (SEVERITY_RANK[b.n.severity] ?? 9);
      return r !== 0 ? r : b.n.createdAt.getTime() - a.n.createdAt.getTime();
    })
    .map(({ n, state }) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      severity: n.severity as PlatformNoticeSeverity,
      state: state as "active" | "resolved",
      startsAt: n.startsAt.toISOString(),
      endsAt: n.endsAt?.toISOString() ?? null,
      resolvedAt: n.resolvedAt?.toISOString() ?? null,
      dismissed: closed.has(n.id),
    }));
}

/**
 * This person closed this notice's banner. Idempotent. False when there is no
 * such notice (deleted meanwhile) - the caller answers 404.
 */
export async function dismissNotice(userId: string, noticeId: string): Promise<boolean> {
  return runAsOwner(async (tx) => {
    const exists = await tx.platformNotice.findUnique({ where: { id: noticeId }, select: { id: true } });
    if (!exists) return false;
    await tx.platformNoticeDismissal.upsert({
      where: { noticeId_userId: { noticeId, userId } },
      create: { noticeId, userId },
      update: {},
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// The admin writes.
// ---------------------------------------------------------------------------

export async function listNoticesForAdmin(): Promise<NoticeRow[]> {
  return runAsOwner((tx) =>
    tx.platformNotice.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: ROW_SELECT }),
  );
}

export interface NoticeInput {
  title: string;
  body: string;
  severity: PlatformNoticeSeverity;
  startsAt?: Date;
  endsAt?: Date | null;
}

export async function createNotice(input: NoticeInput, adminUserId: string): Promise<NoticeRow> {
  const row = await runAsOwner((tx) =>
    tx.platformNotice.create({
      data: {
        title: input.title,
        body: input.body,
        severity: input.severity,
        ...(input.startsAt ? { startsAt: input.startsAt } : {}),
        endsAt: input.endsAt ?? null,
        createdById: adminUserId,
      },
      select: ROW_SELECT,
    }),
  );
  bustCache();
  return row;
}

export async function findNotice(id: string): Promise<NoticeRow | null> {
  return runAsOwner((tx) => tx.platformNotice.findUnique({ where: { id }, select: ROW_SELECT }));
}

export async function updateNotice(id: string, patch: Partial<NoticeInput>): Promise<NoticeRow | null> {
  const row = await runAsOwner(async (tx) => {
    const found = await tx.platformNotice.findUnique({ where: { id }, select: { id: true } });
    if (!found) return null;
    return tx.platformNotice.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
        ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
        ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
      },
      select: ROW_SELECT,
    });
  });
  bustCache();
  return row;
}

/**
 * Mark it fixed. The first resolve stamps the time; a second press keeps the
 * original (the "Fixed" banner's few hours run from when it was fixed).
 */
export async function resolveNotice(id: string, now = new Date()): Promise<NoticeRow | null> {
  const row = await runAsOwner(async (tx) => {
    await tx.platformNotice.updateMany({ where: { id, resolvedAt: null }, data: { resolvedAt: now } });
    return tx.platformNotice.findUnique({ where: { id }, select: ROW_SELECT });
  });
  bustCache();
  return row;
}

export async function deleteNotice(id: string): Promise<boolean> {
  const { count } = await runAsOwner((tx) => tx.platformNotice.deleteMany({ where: { id } }));
  bustCache();
  return count > 0;
}

// ---------------------------------------------------------------------------
// The one push to shop owners' phones.
// ---------------------------------------------------------------------------

/**
 * What happened to "notify phones":
 *  - sending:      claimed just now; the fan-out runs after the response;
 *  - dry_run:      DRY_RUN is on, so no device is touched - and nothing is
 *                  stamped, exactly like every other push while simulated;
 *  - already_sent: this notice has already pushed once. It never pushes twice;
 *  - resolved:     a fixed notice is not news worth a buzz;
 *  - not_found.
 */
export type NoticePushOutcome = "sending" | "dry_run" | "already_sent" | "resolved" | "not_found";

let testMode: "live" | "dry_run" | undefined;
/**
 * Test seam: force the dispatch mode. Needed because an injected push sender
 * makes the shared pushDispatchMode() report "live" - which is right for the
 * delivery loop, but would leave the DRY_RUN branch here untestable.
 */
export function __setNoticePushModeForTests(mode: "live" | "dry_run" | undefined): void {
  testMode = mode;
}

/**
 * 🔴 AT MOST ONCE, BY CONSTRUCTION. The claim is a compare-and-set on
 * pushedAt IS NULL: two presses, two tabs or two replicas racing all reach
 * this UPDATE, and exactly one of them changes a row. Only that one sends.
 * The stamp goes on BEFORE the fan-out on purpose - a crash mid-send leaves
 * some owners un-notified rather than buzzing everyone twice.
 */
export async function claimNoticePush(id: string, now = new Date()): Promise<NoticePushOutcome> {
  const mode = testMode ?? pushDispatchMode();
  if (mode === "dry_run") {
    const found = await findNotice(id);
    if (!found) return "not_found";
    if (found.pushedAt) return "already_sent";
    if (found.resolvedAt) return "resolved";
    logger.info({ noticeId: id }, "[dry-run] platform notice push suppressed");
    return "dry_run";
  }
  // No read-then-check in front of this: the UPDATE's own WHERE is the only
  // guard, so there is nothing a racing request can slip between.
  const { count } = await runAsOwner((tx) =>
    tx.platformNotice.updateMany({
      where: { id, pushedAt: null, resolvedAt: null },
      data: { pushedAt: now },
    }),
  );
  if (count === 1) return "sending";
  // Lost (or never eligible): say why.
  const after = await findNotice(id);
  if (!after) return "not_found";
  return after.pushedAt ? "already_sent" : "resolved";
}

/**
 * Send the notice to every shop owner who registered a device. Owners only
 * (staff hear about it in the dashboard), one send per PERSON however many
 * shops they own, never the demo account. Runs after the response; never
 * throws. Returns how many people were sent to, for logs and tests.
 */
export async function pushNoticeToOwners(notice: { id: string; title: string; body: string }): Promise<number> {
  try {
    const subs = await runAsOwner((tx) =>
      tx.pushSubscription.findMany({
        where: {
          userId: { not: null },
          user: { shops: { some: {} }, email: { not: DEMO.OWNER_EMAIL } },
        },
        select: { userId: true, shopId: true },
        distinct: ["userId"],
      }),
    );
    const payload = {
      title: notice.title,
      body: platformNoticePushBody(notice.body),
      url: `${apiEnv().APP_BASE_URL}/dashboard`,
      tag: `platform-notice-${notice.id}`,
    };
    let people = 0;
    for (const s of subs) {
      if (!s.userId) continue;
      people += 1;
      await sendPushToUser({ userId: s.userId, shopId: s.shopId, payload });
    }
    logger.info({ noticeId: notice.id, people }, "platform notice pushed to owners");
    return people;
  } catch (err) {
    logger.error({ err, noticeId: notice.id }, "platform notice push failed");
    return 0;
  }
}
