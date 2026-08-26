import type { AgendaRow } from "./page";

/**
 * Reconcile one fetched window of agenda rows into the set the calendar already
 * holds.
 *
 * The calendar keeps rows for every month the barber has paged to, but each
 * fetch answers for ONE window. So a response is authoritative inside its own
 * range and says nothing at all outside it:
 *
 *   - a row that came back REPLACES the one held (statuses move: Booked ->
 *     En route -> Arrived, a price gets set, a block's note is edited);
 *   - a row that came back and wasn't held is ADDED;
 *   - a row that was held, falls INSIDE the window, and did NOT come back is
 *     RETRACTED - the server was asked about that slot and didn't list it, so
 *     it was cancelled, unblocked or deleted;
 *   - a row OUTSIDE the window is left exactly as-is.
 *
 * That last rule is the whole reason this takes a window at all. Every merge in
 * this calendar used to be additive - replace-by-id and append, never remove -
 * so a cancelled appointment or an unblocked band stayed on screen until a full
 * page load, and the barber's own action appeared not to have worked. Retracting
 * without the window bound would be worse than the bug: it would blank every
 * month the barber had already loaded, and `loadedMonths` would never refetch
 * them.
 *
 * (Same discipline as the Acuity block reconciler on the API side, which only
 * deletes rows inside the window it asked about.)
 *
 * Returns `prev` UNCHANGED (same reference) when nothing moved, so an idle poll
 * doesn't re-render the calendar every 20 seconds.
 */
export function mergeAgendaWindow(
  prev: AgendaRow[],
  incoming: AgendaRow[],
  window: { from?: string; to?: string },
): AgendaRow[] {
  const fresh = new Map(incoming.map((r) => [r.id, r]));
  // No window (older payload) => additive only. Never retract on a guess.
  const fromMs = window.from ? Date.parse(window.from) : NaN;
  const toMs = window.to ? Date.parse(window.to) : NaN;
  const canRetract = Number.isFinite(fromMs) && Number.isFinite(toMs);

  const out: AgendaRow[] = [];
  let changed = false;

  for (const row of prev) {
    const updated = fresh.get(row.id);
    if (updated) {
      fresh.delete(row.id);
      out.push(updated);
      if (!sameRow(row, updated)) changed = true;
      continue;
    }
    if (canRetract && overlapsWindow(row, fromMs, toMs)) {
      changed = true; // held, in range, not listed => gone
      continue;
    }
    out.push(row);
  }

  // Whatever is left in `fresh` is new to us. Appended rather than spliced in
  // order: every consumer buckets by day and sorts, so order here is not load
  // bearing and an insert would cost a scan per row.
  for (const row of fresh.values()) {
    out.push(row);
    changed = true;
  }

  return changed ? out : prev;
}

/**
 * The window a response may be reconciled against.
 *
 * `truncated` collapses it to "no window", which makes the merge additive: a
 * capped answer legitimately omits real rows, and retracting on that evidence
 * would delete bookings the barber still has. Falls back to the range that was
 * REQUESTED when the payload doesn't state one (an older cached response), and
 * to no window at all when there isn't one either.
 */
export function agendaWindowOf(
  data: { from?: string; to?: string; truncated?: boolean },
  requestedFrom?: string,
  requestedTo?: string,
): { from?: string; to?: string } {
  if (data.truncated) return {};
  return { from: data.from ?? requestedFrom, to: data.to ?? requestedTo };
}

/**
 * Does this row occupy any part of the fetched window?
 *
 * Deliberately an OVERLAP test, not `start >= from`. The API returns external
 * blocks whose span merely intersects the range, so an overnight block can
 * legitimately START before `from` - and if it were later removed in Acuity, a
 * start-only test would never retract it. A row with no end (nothing has one
 * today, but the type allows it) is treated as an instant.
 */
function overlapsWindow(row: AgendaRow, fromMs: number, toMs: number): boolean {
  const start = Date.parse(row.start);
  if (!Number.isFinite(start)) return false;
  const end = row.end ? Date.parse(row.end) : start;
  return start <= toMs && (Number.isFinite(end) ? end : start) >= fromMs;
}

/**
 * Field-wise equality over what the calendar actually renders, so an unchanged
 * poll keeps the previous array reference and the day view doesn't re-render
 * every 20 seconds. Missing a field here is a stale pill, so it covers every
 * value that drives a visible state: the span, the status pill and its check-in
 * sub-state, the money row (which flips the button to "Paid ✓"), the day-gauge
 * bucket, and the nudge counter.
 */
function sameRow(a: AgendaRow, b: AgendaRow): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.status === b.status &&
    a.clientName === b.clientName &&
    a.serviceName === b.serviceName &&
    a.serviceColor === b.serviceColor &&
    a.price === b.price &&
    a.paid === b.paid &&
    a.paidMethod === b.paidMethod &&
    a.prepaid === b.prepaid &&
    a.checkInStatus === b.checkInStatus &&
    a.etaMinutes === b.etaMinutes &&
    a.runningLate === b.runningLate &&
    a.categoryId === b.categoryId &&
    a.nudgesSent === b.nudgesSent &&
    a.notes === b.notes &&
    a.rewardReady?.rewardId === b.rewardReady?.rewardId &&
    (a.addOns?.length ?? 0) === (b.addOns?.length ?? 0)
  );
}
