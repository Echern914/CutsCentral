import { runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * PLATFORM SWITCHES - on/off controls an operator flips from the admin portal
 * and that take effect without a deploy.
 *
 * The first is texting ('sms'). It was an environment variable, which meant a
 * Railway edit and a restart every time the platform wanted to stop or resume
 * paying for texts. Now the admin page writes a row, and every API process
 * picks it up.
 *
 * 🔴 READ SYNCHRONOUSLY, FROM MEMORY. smsEnabled() is asked on every send path,
 * many of them synchronous, so this module keeps an in-process copy:
 *  - the process that handles the flip updates its copy immediately;
 *  - every process re-reads the table every REFRESH_MS, so another replica
 *    follows within seconds;
 *  - a failed read KEEPS THE LAST KNOWN VALUES. A database blip must never be
 *    what switches texting on (a bill) or off (silence).
 *
 * No row for a key means nobody has used that switch yet: the caller falls
 * back to its environment default (SMS_ENABLED for texting).
 *
 * 🔴 EVERY QUERY GOES THROUGH runAsOwner. The table is FORCE row-level security
 * with no policy (default-deny, the PlatformOperation shape), and FORCE binds
 * the owner connection too: a plain (non-runAsOwner) read in production
 * returns ZERO rows and a write is refused. The local test database connects
 * as a superuser, which bypasses RLS entirely - so a plain query would pass
 * every test and still read "never set" in production.
 */

export const PLATFORM_SWITCH_KEYS = ["sms"] as const;
export type PlatformSwitchKey = (typeof PLATFORM_SWITCH_KEYS)[number];

/** How stale another replica may be after a flip. */
export const REFRESH_MS = 15_000;

const current = new Map<PlatformSwitchKey, boolean>();

/** The stored value, or undefined when the switch has never been set. */
export function platformSwitch(key: PlatformSwitchKey): boolean | undefined {
  return current.get(key);
}

/** Re-read every switch. Never throws; on failure the last values stand. */
export async function refreshPlatformSwitches(): Promise<void> {
  try {
    const rows = await runAsOwner((tx) =>
      tx.platformSwitch.findMany({ select: { key: true, enabled: true } }),
    );
    const seen = new Set<string>();
    for (const row of rows) {
      current.set(row.key as PlatformSwitchKey, row.enabled);
      seen.add(row.key);
    }
    // A deleted row hands the switch back to its environment default.
    for (const key of [...current.keys()]) if (!seen.has(key)) current.delete(key);
  } catch (err) {
    logger.error({ err }, "platform switches refresh failed; keeping last known values");
  }
}

/**
 * Flip a switch. Written first, then this process's copy updated, so a failed
 * write changes nothing anywhere.
 */
export async function setPlatformSwitch(
  key: PlatformSwitchKey,
  enabled: boolean,
  updatedById: string,
): Promise<{ key: PlatformSwitchKey; enabled: boolean; updatedAt: Date }> {
  const row = await runAsOwner((tx) =>
    tx.platformSwitch.upsert({
      where: { key },
      create: { key, enabled, updatedById },
      update: { enabled, updatedById },
      select: { enabled: true, updatedAt: true },
    }),
  );
  current.set(key, row.enabled);
  logger.warn({ key, enabled: row.enabled, updatedById }, "platform switch flipped");
  return { key, enabled: row.enabled, updatedAt: row.updatedAt };
}

/** What the admin page shows: the stored row, fresh from the database. */
export async function readPlatformSwitch(key: PlatformSwitchKey): Promise<{
  enabled: boolean;
  updatedAt: Date;
  updatedByEmail: string | null;
} | null> {
  return runAsOwner(async (tx) => {
    const row = await tx.platformSwitch.findUnique({
      where: { key },
      select: { enabled: true, updatedAt: true, updatedById: true },
    });
    if (!row) return null;
    const by = row.updatedById
      ? await tx.user.findUnique({ where: { id: row.updatedById }, select: { email: true } })
      : null;
    return { enabled: row.enabled, updatedAt: row.updatedAt, updatedByEmail: by?.email ?? null };
  });
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Boot: read now, then keep following. Idempotent. */
export function startPlatformSwitchRefresh(): void {
  if (timer) return;
  void refreshPlatformSwitches();
  timer = setInterval(() => void refreshPlatformSwitches(), REFRESH_MS);
  timer.unref();
}

/** Test seam: forget every stored value (as if no row had ever been read). */
export function __resetPlatformSwitchesForTests(): void {
  current.clear();
}
