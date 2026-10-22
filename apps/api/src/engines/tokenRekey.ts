import { prisma, runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { claimDigest, previousClaimDigest } from "../services/customerIdentity.js";
import { openTokenNoting, sealToken, tokenKeys } from "../services/tokenKey.js";

/**
 * MOVE EVERYTHING STORED UNDER THE OLD AT-REST KEY ONTO THE NEW ONE.
 *
 * Runs at boot (index.ts). With no rotation underway it only CHECKS: if stored
 * integration tokens exist and none of them opens, the key was changed without
 * TOKEN_ENCRYPTION_KEY_PREVIOUS, and every Acuity and Square shop is about to
 * lose its sync - the log says so, in words, with the fix.
 *
 * With TOKEN_ENCRYPTION_KEY_PREVIOUS set it reseals, row by row:
 *   - AcuityConnection / SquareConnection access + refresh tokens;
 *   - CustomerClientLink.claimDigest for claimed records.
 * Short-lived rows (sign-in deliveries, recovery challenges) are left to
 * expire; services/tokenKey.ts opens them under either key meanwhile.
 *
 * 🔴 EVERY WRITE IS A COMPARE-AND-SWAP on the value that was read. A token
 * refresh can rewrite a connection between our read and our write, and that
 * newer token - already sealed under the new key - must win. A lost swap is
 * counted as current, because whoever won wrote under the current key. Safe on
 * any number of replicas booting at once, and safe to run again.
 */

export interface RekeyCounts {
  /** Moved from the previous key to the current one by this run. */
  resealed: number;
  /** Already under the current key. */
  current: number;
  /** Opened by neither key - those integrations need reconnecting. */
  unreadable: number;
}

export interface RekeyReport {
  rotating: boolean;
  acuity: RekeyCounts;
  square: RekeyCounts;
  claims: RekeyCounts;
  /** Admin authenticator secrets (services/adminStepUp.ts). */
  adminTotp: RekeyCounts;
}

const zero = (): RekeyCounts => ({ resealed: 0, current: 0, unreadable: 0 });

type Opened = { plaintext: string; stale: boolean } | null;

function tryOpen(sealed: string): Opened {
  try {
    return openTokenNoting(sealed);
  } catch {
    return null;
  }
}

async function rekeyAcuity(out: RekeyCounts, rotating: boolean): Promise<void> {
  const rows = await runAsOwner((tx) =>
    tx.acuityConnection.findMany({ select: { id: true, accessToken: true, refreshToken: true } }),
  );
  for (const r of rows) {
    const access = tryOpen(r.accessToken);
    const refresh = r.refreshToken === null ? null : tryOpen(r.refreshToken);
    if (!access || (r.refreshToken !== null && !refresh)) {
      out.unreadable++;
      continue;
    }
    if (!rotating || (!access.stale && !refresh?.stale)) {
      out.current++;
      continue;
    }
    const swapped = await runAsOwner((tx) =>
      tx.acuityConnection.updateMany({
        where: { id: r.id, accessToken: r.accessToken, refreshToken: r.refreshToken },
        data: {
          accessToken: access.stale ? sealToken(access.plaintext) : r.accessToken,
          refreshToken: refresh?.stale ? sealToken(refresh.plaintext) : r.refreshToken,
        },
      }),
    );
    if (swapped.count === 1) out.resealed++;
    else out.current++;
  }
}

async function rekeySquare(out: RekeyCounts, rotating: boolean): Promise<void> {
  const rows = await runAsOwner((tx) =>
    tx.squareConnection.findMany({ select: { id: true, accessToken: true, refreshToken: true } }),
  );
  for (const r of rows) {
    const access = tryOpen(r.accessToken);
    const refresh = tryOpen(r.refreshToken);
    if (!access || !refresh) {
      out.unreadable++;
      continue;
    }
    if (!rotating || (!access.stale && !refresh.stale)) {
      out.current++;
      continue;
    }
    const swapped = await runAsOwner((tx) =>
      tx.squareConnection.updateMany({
        where: { id: r.id, accessToken: r.accessToken, refreshToken: r.refreshToken },
        data: {
          accessToken: access.stale ? sealToken(access.plaintext) : r.accessToken,
          refreshToken: refresh.stale ? sealToken(refresh.plaintext) : r.refreshToken,
        },
      }),
    );
    if (swapped.count === 1) out.resealed++;
    else out.current++;
  }
}

/**
 * A claim digest that matches neither key is NOT unreadable: it is a record
 * whose rewards link was rotated since the claim, which the settle logic
 * detaches on purpose. Only old-key matches are rewritten; everything else is
 * left exactly as it was and counted as current.
 */
async function rekeyClaims(out: RekeyCounts, rotating: boolean): Promise<void> {
  if (!rotating) return;
  const links = await runAsOwner((tx) =>
    tx.customerClientLink.findMany({
      where: { matchedBy: "claim", claimDigest: { not: null } },
      select: { id: true, claimDigest: true, client: { select: { magicToken: true } } },
    }),
  );
  for (const l of links) {
    const old = previousClaimDigest(l.client.magicToken);
    if (old === null || l.claimDigest !== old) {
      out.current++;
      continue;
    }
    const swapped = await runAsOwner((tx) =>
      tx.customerClientLink.updateMany({
        where: { id: l.id, claimDigest: old },
        data: { claimDigest: claimDigest(l.client.magicToken) },
      }),
    );
    if (swapped.count === 1) out.resealed++;
    else out.current++;
  }
}

/**
 * The admin authenticator secret (and one waiting to be confirmed), sealed
 * with the same key - an unread one only costs its admin a fresh setup, by
 * the emailed-code fallback, so it is reported but never fatal.
 */
async function rekeyAdminTotp(out: RekeyCounts, rotating: boolean): Promise<void> {
  const rows = await prisma.user.findMany({
    where: { OR: [{ adminTotpSecretEnc: { not: null } }, { adminTotpPendingEnc: { not: null } }] },
    select: { id: true, adminTotpSecretEnc: true, adminTotpPendingEnc: true },
  });
  for (const r of rows) {
    const secret = r.adminTotpSecretEnc === null ? null : tryOpen(r.adminTotpSecretEnc);
    const pending = r.adminTotpPendingEnc === null ? null : tryOpen(r.adminTotpPendingEnc);
    if ((r.adminTotpSecretEnc !== null && !secret) || (r.adminTotpPendingEnc !== null && !pending)) {
      out.unreadable++;
      continue;
    }
    if (!rotating || (!secret?.stale && !pending?.stale)) {
      out.current++;
      continue;
    }
    const swapped = await prisma.user.updateMany({
      where: { id: r.id, adminTotpSecretEnc: r.adminTotpSecretEnc, adminTotpPendingEnc: r.adminTotpPendingEnc },
      data: {
        adminTotpSecretEnc: secret?.stale ? sealToken(secret.plaintext) : r.adminTotpSecretEnc,
        adminTotpPendingEnc: pending?.stale ? sealToken(pending.plaintext) : r.adminTotpPendingEnc,
      },
    });
    if (swapped.count === 1) out.resealed++;
    else out.current++;
  }
}

export async function rekeyStoredTokens(): Promise<RekeyReport> {
  const rotating = tokenKeys().previous !== null;
  const report: RekeyReport = { rotating, acuity: zero(), square: zero(), claims: zero(), adminTotp: zero() };
  await rekeyAcuity(report.acuity, rotating);
  await rekeySquare(report.square, rotating);
  await rekeyClaims(report.claims, rotating);
  await rekeyAdminTotp(report.adminTotp, rotating);
  return report;
}

/** What the deploy log should say about a report, or null for nothing. */
export function rekeySummary(r: RekeyReport): { level: "info" | "error"; message: string } | null {
  const unreadable = r.acuity.unreadable + r.square.unreadable;
  const stored = unreadable + r.acuity.current + r.acuity.resealed + r.square.current + r.square.resealed;
  if (!r.rotating) {
    if (unreadable === 0) return null;
    return {
      level: "error",
      message:
        unreadable === stored
          ? `None of the ${stored} stored Acuity/Square tokens opens with TOKEN_ENCRYPTION_KEY. If the key was just changed, set TOKEN_ENCRYPTION_KEY_PREVIOUS to the old value and redeploy - until then those shops cannot sync, and claimed My ChairBack records will detach.`
          : `${unreadable} of ${stored} stored Acuity/Square tokens do not open with TOKEN_ENCRYPTION_KEY - those shops need to reconnect.`,
    };
  }
  const resealed = r.acuity.resealed + r.square.resealed + r.claims.resealed + r.adminTotp.resealed;
  if (r.adminTotp.unreadable > 0 && unreadable === 0) {
    return {
      level: "error",
      message: `Key rotation: ${resealed} moved to the new key, but ${r.adminTotp.unreadable} admin authenticator secret(s) open with NEITHER key - that admin signs in with an emailed code and sets the app up again.`,
    };
  }
  if (unreadable > 0) {
    return {
      level: "error",
      message: `Key rotation: ${resealed} moved to the new key, but ${unreadable} stored Acuity/Square tokens open with NEITHER key. Check TOKEN_ENCRYPTION_KEY_PREVIOUS is the exact old value before removing it.`,
    };
  }
  return {
    level: "info",
    message: `Key rotation: ${resealed} moved to the new key, nothing left on the old one. TOKEN_ENCRYPTION_KEY_PREVIOUS can now be removed.`,
  };
}

/** Boot hook: never throws, never delays listening. */
export function rekeyStoredTokensAtBoot(): void {
  void rekeyStoredTokens()
    .then((report) => {
      const s = rekeySummary(report);
      if (!s) return;
      const fields = { acuity: report.acuity, square: report.square, claims: report.claims, adminTotp: report.adminTotp };
      if (s.level === "error") logger.error(fields, s.message);
      else logger.info(fields, s.message);
    })
    .catch((err) => logger.error({ err }, "token re-key at boot failed - it runs again on the next boot"));
}
