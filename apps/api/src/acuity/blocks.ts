import { runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import type { AcuityBlock } from "./types.js";
import { blockReference } from "../engines/acuityMirrorRules.js";

/**
 * Sync Acuity's BLOCKED-OFF TIME into ExternalBlock rows.
 *
 * Appointments were only half the picture: a barber who blocks 2-4pm in Acuity
 * (lunch, a school run, a day off) had that time still offered by ChairBack's
 * native picker, missing from the calendar, and counted by Chair time as open
 * hours that "went unsold" - which drags the utilization number down for time
 * he deliberately took off.
 *
 * RECONCILING, not just upserting: a block DELETED in Acuity has to disappear
 * here too, and unlike an appointment there is no canceled flag to tell us -
 * its absence from the response IS the signal. So within the synced window we
 * upsert what Acuity returned and delete the rows it no longer lists. Outside
 * the window nothing is touched, so a narrow sweep can never wipe history.
 */

/** Acuity spells the times a couple of ways; take whichever is parseable. */
function parseSpan(b: AcuityBlock): { startsAt: Date; endsAt: Date } | null {
  const parse = (v: unknown): Date | null => {
    if (typeof v !== "string" || v.trim() === "") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const startsAt = parse(b.start) ?? parse(b.startTime);
  const endsAt = parse(b.end) ?? parse(b.endTime);
  if (!startsAt || !endsAt) return null;
  // A zero/negative-length block would block nothing; a reversed one would
  // block everything between. Neither is a real Acuity state - skip both.
  if (endsAt.getTime() <= startsAt.getTime()) return null;
  return { startsAt, endsAt };
}

export interface BlockSyncResult {
  upserted: number;
  removed: number;
  skipped: number;
}

/**
 * Reconcile one shop's blocks for [from, to). `blocks` is what Acuity returned
 * for that same window.
 */
export async function syncAcuityBlocks(
  shopId: string,
  blocks: AcuityBlock[],
  from: Date,
  to: Date,
): Promise<BlockSyncResult> {
  let rows: {
    externalId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string | null;
    externalCalendarId: string | null;
  }[] = [];
  let skipped = 0;
  for (const b of blocks) {
    const span = parseSpan(b);
    if (!span) {
      skipped++;
      continue;
    }
    // Only reconcile what falls in the window we asked for - a block Acuity
    // volunteers outside it would look "missing" on the next narrow sweep and
    // get deleted right back off.
    if (span.startsAt >= to || span.endsAt <= from) continue;
    rows.push({
      externalId: `acuity:${b.id}`,
      ...span,
      reason: b.notes?.trim() || b.description?.trim() || null,
      externalCalendarId: b.calendarID != null ? String(b.calendarID) : null,
    });
  }

  const result = await runWithShop(shopId, async (tx) => {
    // SELF-ECHO GUARD. Blocks ChairBack itself created (engines/acuityMirror)
    // come straight back through GET /blocks, and without this they would be
    // imported as ExternalBlock rows - a phantom SECOND block laid over
    // ChairBack's own appointment. Harmless while the booking stands, but on
    // cancel the appointment disappears and the echo does not, so the chair
    // stays blocked until the next sweep: cancelling would fail to free the
    // slot for up to half an hour. Matched by ID, not by note text, so a
    // barber who edits or clears the note cannot resurrect the loop.
    const owned = await tx.acuityOutboundBlock.findMany({
      where: { shopId, acuityBlockId: { not: null } },
      select: { acuityBlockId: true },
    });
    const ownedExternalIds = new Set(
      owned.map((o) => `acuity:${o.acuityBlockId}`),
    );
    // ...AND by reference. An id only covers the block we got an answer for.
    // An ambiguous create that Acuity honoured twice leaves a TWIN with a
    // different id, and the id match waves it straight in - Drick's 10 AM,
    // 2026-09-24: cancelled at 12:09, still blocked on ChairBack until the
    // 12:30 sweep dropped exactly two of these. Every block we write carries
    // `ChairBack ref <outbox id>` in its note, twins included, so a note that
    // names one of THIS shop's outbox rows in the window is ours whatever its
    // id. Scoped to real rows, never a bare prefix test, so a barber's own
    // block can't be dropped by what he happens to type.
    const ownedRows = await tx.acuityOutboundBlock.findMany({
      where: { shopId, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { id: true },
    });
    const ownedRefs = new Set(ownedRows.map((o) => blockReference(o.id)));
    rows = rows.filter(
      (r) => !ownedExternalIds.has(r.externalId) && !(r.reason && ownedRefs.has(r.reason)),
    );
    if (ownedRefs.size > 0) {
      await tx.externalBlock.deleteMany({
        where: { shopId, reason: { in: [...ownedRefs] } },
      });
    }
    // Self-healing, not just preventive: any echo imported before this guard
    // existed (or before we learned the block id, as when an ambiguous create
    // is later recovered) is deleted here rather than left to block a chair
    // nobody can explain.
    if (ownedExternalIds.size > 0) {
      await tx.externalBlock.deleteMany({
        where: { shopId, externalId: { in: [...ownedExternalIds] } },
      });
    }

    for (const r of rows) {
      await tx.externalBlock.upsert({
        where: { shopId_externalId: { shopId, externalId: r.externalId } },
        create: { shopId, ...r },
        update: {
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          reason: r.reason,
          externalCalendarId: r.externalCalendarId,
        },
      });
    }
    // Anything acuity-sourced that OVERLAPS this window but is no longer in
    // Acuity's answer was un-blocked there; drop it so the chair frees up.
    const keep = rows.map((r) => r.externalId);
    const { count } = await tx.externalBlock.deleteMany({
      where: {
        shopId,
        externalId: { startsWith: "acuity:", notIn: keep },
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
    });
    if (skipped > 0) {
      logger.warn({ shopId, skipped }, "acuity blocks: skipped unparseable rows");
    }
    return { upserted: rows.length, removed: count, skipped };
  });
  // Blocked time is the one busy source the write guard does NOT re-check, so
  // the grid is the only thing standing between a customer and a time the
  // barber has said he is not there for. A cached day built before the sync
  // defeats that entirely.
  if (result.upserted > 0 || result.removed > 0) {
    await noteAvailabilityChanged(shopId);
  }
  return result;
}
