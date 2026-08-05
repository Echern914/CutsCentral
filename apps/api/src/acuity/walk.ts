import { logger } from "../logger.js";
import type { ListParams } from "./client.js";
import type { AcuityAppointment } from "./types.js";

/**
 * The one Acuity list-walk. Acuity's GET /appointments has NO offset/page
 * pagination - the only way to read more than one page is a date cursor. Both
 * the connect-time backfill and the periodic resync used to hand-roll this walk
 * and both stopped on `page.length < requestedMax`, which silently truncates
 * the moment Acuity caps `max` below what we ask for (it caps at 100; we asked
 * for 200 - so every walk ended after ONE page and shops synced at most 100
 * appointments per pass). This walk never infers anything from page shortness.
 */

/**
 * Ask for exactly what Acuity serves. Requesting more is harmless on a server
 * that honors it and catastrophic on one that silently caps (see above), so
 * pin the request to the cap.
 */
export const ACUITY_PAGE_SIZE = 100;

/** The one method the walk needs - keeps tests to a tiny fake. */
type AcuityLister = {
  listAppointments(params: ListParams): Promise<AcuityAppointment[]>;
};

/**
 * Walk every appointment in [minDate, maxDate?] in ascending order and hand
 * each one to `handle` exactly once. Returns how many were handled.
 *
 * Every iteration strictly advances: it either handles at least one never-seen
 * appointment or moves the cursor at least one second forward, so the walk
 * always terminates - on an EMPTY page, never on a short or stale one.
 * minDate is inclusive, so each page re-reads the appointments sharing the
 * cursor timestamp; the seen-set drops them. Cursor comparisons use parsed
 * epoch millis (never string order - Acuity datetimes carry mixed UTC
 * offsets). The only way to lose data is more than a full page booked at the
 * SAME second - versus the old guard, which abandoned the whole remaining
 * window when one day filled a page.
 */
export async function walkAcuityAppointments(
  acuity: AcuityLister,
  opts: { shopId: string; minDate: string; maxDate?: string; canceled: boolean },
  handle: (appt: AcuityAppointment) => Promise<void>,
): Promise<number> {
  const seen = new Set<string>();
  let cursor = opts.minDate;
  // NaN for a bare YYYY-MM-DD start - the first page always advances it.
  let cursorMs = Date.parse(opts.minDate);
  let handled = 0;

  for (;;) {
    const page = await acuity.listAppointments({
      minDate: cursor,
      maxDate: opts.maxDate,
      max: ACUITY_PAGE_SIZE,
      direction: "ASC",
      canceled: opts.canceled,
    });
    if (page.length === 0) break;

    // Newest parseable datetime on the page - the cursor anchor.
    let maxMs = Number.NaN;
    let maxRaw = "";
    for (const appt of page) {
      const ms = Date.parse(appt.datetime);
      if (Number.isNaN(ms)) continue; // ingest skips these too
      if (Number.isNaN(maxMs) || ms > maxMs) {
        maxMs = ms;
        maxRaw = appt.datetime;
      }
    }

    let fresh = 0;
    for (const appt of page) {
      if (seen.has(appt.id)) continue;
      seen.add(appt.id);
      fresh++;
      await handle(appt);
      handled++;
    }

    if (Number.isNaN(maxMs)) {
      // A page of nothing but unparseable datetimes - no anchor to advance on.
      logger.warn(
        { shopId: opts.shopId, cursor },
        "acuity walk: page had no parseable datetimes; stopping",
      );
      break;
    }

    const atOrBehindCursor = !Number.isNaN(cursorMs) && maxMs <= cursorMs;
    if (fresh === 0 || atOrBehindCursor) {
      // Either the whole page was re-reads, or it's all pinned at the cursor
      // instant: a full page shares one second. Step one second past it - the
      // next page is empty (done) or whatever follows. NEVER break here: with
      // an inclusive minDate a re-request at the same cursor returns this same
      // page forever, and "nothing fresh" alone doesn't mean nothing is LATER.
      cursorMs = (Number.isNaN(cursorMs) ? maxMs : Math.max(cursorMs, maxMs)) + 1000;
      cursor = new Date(cursorMs).toISOString();
      logger.info(
        { shopId: opts.shopId, cursor, fresh },
        "acuity walk: page did not advance; nudging cursor 1s",
      );
    } else {
      cursorMs = maxMs;
      cursor = maxRaw;
    }
  }

  return handled;
}
