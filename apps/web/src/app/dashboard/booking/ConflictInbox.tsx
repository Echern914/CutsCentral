"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";
import {
  listConflictsAction,
  resolveConflictAction,
  type ConflictCursor,
  type ConflictRow,
  type ConflictStatus,
} from "./conflictActions";

/**
 * THE MANAGER'S CONFLICT INBOX.
 *
 * A double-booked chair used to live in three places, all of them fragile: an
 * amber panel on the screen of whoever logged the walk-in, a best-effort push,
 * and a row in a table nothing could open. This is the surface that makes the
 * third one readable - the one that is still there tomorrow, after the panel
 * was dismissed and the push went to a phone nobody was holding.
 *
 * 🔴 IT CHANGES NO BOOKING. "Mark resolved" records that a person dealt with
 * the collision. It does not cancel, move or refund either appointment, and the
 * UI says so in as many words before it will accept the click - a manager who
 * believes this button reschedules something will not go and ring the customer,
 * which is the one thing that actually fixes a double-booked chair.
 */

const PAGE = 20;

/** What each kind of collision IS, in the words a barber would use. */
const KIND_LABEL: Record<string, string> = {
  appointment: "Booked appointment",
  visit: "Synced booking",
  block: "Blocked time",
};
const KIND_HINT: Record<string, string> = {
  appointment: "A booking made in ChairBack.",
  visit: "Came from the shop's connected calendar (Acuity or Square).",
  block: "Time blocked off on the external calendar.",
};
const KIND_STYLE: Record<string, string> = {
  appointment: "border-gold/40 bg-gold/10 text-gold",
  visit: "border-sky-400/40 bg-sky-400/10 text-sky-300",
  block: "border-violet-400/40 bg-violet-400/10 text-violet-300",
};

function timeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = s.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${t(s)}–${t(e)}`;
}

function minutes(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
}

/**
 * How many double-booked chairs are waiting, for the tab badge.
 *
 * 🔴 FETCHED ON MOUNT, not when the Conflicts tab is opened. A count you only
 * see after finding the tab is not an entry point, and *not going looking* is
 * the exact failure this whole feature exists to fix.
 *
 * Lives here rather than inside BookingManager so it can be tested on its own -
 * and so the count's rules stay next to the surface that owns them. It returns
 * the setter too, so the open inbox can keep the badge in step as the manager
 * works through the list.
 *
 * There is deliberately NO module-level cache. Switching shops redirects to
 * /dashboard, which unmounts this; the count must come back from the server on
 * the way in, never from a variable still holding the previous shop's number.
 */
export function useUnresolvedConflictCount(): [number, (n: number) => void] {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    void listConflictsAction({ status: "open", limit: 1 }).then((r) => {
      // Silent on failure: a badge that cannot load must not put an error in
      // front of somebody who came here to do something else.
      if (live && r.ok && r.data) setCount(r.data.unresolvedCount);
    });
    return () => {
      live = false;
    };
  }, []);
  return [count, setCount];
}

/**
 * The count on the Conflicts tab.
 *
 * 🔴 RENDERS NOTHING AT ZERO. A badge showing "0" is a permanent mark on the
 * tab that means "everything is fine", which trains people to ignore it - and
 * the one time it says 1 they will not notice. Amber rather than red: nothing
 * is broken and no money was lost, somebody just has to make a call.
 */
export function ConflictTabBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="rounded-full bg-amber-400/20 px-1.5 text-[11px] font-semibold text-amber-300"
      aria-label={`${count} unresolved`}
    >
      {count}
    </span>
  );
}

export function ConflictInbox({
  onUnresolvedCount,
}: {
  /** Lets the tab badge track the count without a second request. */
  onUnresolvedCount?: (n: number) => void;
}) {
  const [status, setStatus] = useState<ConflictStatus>("open");
  const [rows, setRows] = useState<ConflictRow[]>([]);
  const [cursor, setCursor] = useState<ConflictCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConflictRow | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The open count, held locally so it can move the instant the manager acts.
   * Kept in step with the parent badge through `publishCount`: two copies that
   * can drift is how a badge ends up claiming work that is already done.
   */
  const [openCount, setOpenCount] = useState(0);

  const publishCount = useCallback(
    (n: number) => {
      const safe = Math.max(0, n);
      setOpenCount(safe);
      onUnresolvedCount?.(safe);
    },
    [onUnresolvedCount],
  );

  const load = useCallback(
    async (next: ConflictStatus) => {
      setLoading(true);
      setError(null);
      const res = await listConflictsAction({ status: next, limit: PAGE });
      setLoading(false);
      if (!res.ok || !res.data) {
        setError("Couldn't load conflicts.");
        return;
      }
      setRows(res.data.items);
      setCursor(res.data.nextCursor);
      publishCount(res.data.unresolvedCount);
    },
    [publishCount],
  );

  useEffect(() => {
    void load(status);
  }, [status, load]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const res = await listConflictsAction({ status, cursor, limit: PAGE });
    setLoadingMore(false);
    if (!res.ok || !res.data) {
      setError("Couldn't load more.");
      return;
    }
    // Append, and guard against a row arriving twice if one was resolved
    // between pages.
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [...prev, ...res.data!.items.filter((r) => !seen.has(r.id))];
    });
    setCursor(res.data.nextCursor);
    publishCount(res.data.unresolvedCount);
  }

  async function confirmResolve() {
    if (!confirming) return;
    setSaving(true);

    /**
     * 🔴 OPTIMISTIC, THEN RECONCILED, AND REVERTED IF IT FAILED.
     *
     * The badge drops the moment they confirm, because the manager is looking
     * at it and a badge that still says "3" after they dealt with one reads as
     * "it didn't work" - which is how somebody resolves the same conflict twice
     * or goes looking for a fourth that was never there.
     *
     * `before` is captured so a failure puts the truth back rather than leaving
     * the badge one short. The reload afterwards is the reconciliation: the
     * server's count wins, including when a teammate resolved something else in
     * the same moment.
     */
    const before = openCount;
    publishCount(before - 1);

    const res = await resolveConflictAction(confirming.id, note);
    setSaving(false);
    if (!res.ok) {
      publishCount(before);
      setNotice("Couldn't mark that resolved. Nothing was changed.");
      return;
    }
    // 🔴 Tell the truth about who resolved it. `changed: false` means somebody
    // else got there first, and the list shows THEIR name.
    setNotice(
      res.changed
        ? "Marked resolved. No booking was changed."
        : `Already resolved${res.resolvedByName ? ` by ${res.resolvedByName}` : ""}.`,
    );
    setConfirming(null);
    setNote("");
    void load(status);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <h2 className="text-base font-semibold text-offwhite">Double-booked chairs</h2>
        <p className="mt-1 text-sm text-muted">
          A walk-in was recorded on a chair that was already booked. The money stayed on the books
          and nothing was thrown away &mdash; but two people may be expecting the same slot, so
          someone needs to open both bookings and make a call.
        </p>
        <p className="mt-2 text-xs text-muted/80">
          Marking one resolved is a note for your records. It does not cancel, move or refund
          anything.
        </p>
      </Card>

      <div
        className="flex items-center gap-1 overflow-x-auto"
        role="tablist"
        aria-label="Conflict filter"
      >
        {(["open", "resolved", "all"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors duration-150",
              status === s
                ? "bg-gold/15 text-gold"
                : "text-muted hover:bg-charcoal-700 hover:text-offwhite",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {notice && (
        <p role="status" className="text-xs text-gold">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted">Loading&hellip;</p>
      ) : rows.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            {status === "open"
              ? "No double-booked chairs. Nothing to deal with."
              : "Nothing here."}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className={cn(r.resolvedAt && "opacity-70")}>
                {/* Wraps on a phone: the WebView shell is ~390px wide. */}
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                      KIND_STYLE[r.kind] ?? "border-subtle bg-charcoal-700 text-muted",
                    )}
                  >
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                  <span className="text-sm font-medium text-offwhite">
                    {r.staffName ?? "Unknown chair"}
                  </span>
                  {r.resolvedAt && (
                    <span className="rounded-full border border-subtle px-2 py-0.5 text-[11px] text-muted">
                      Resolved
                    </span>
                  )}
                </div>

                <p className="mt-2 text-sm text-offwhite">
                  {timeRange(r.overlapStart, r.overlapEnd)}{" "}
                  <span className="text-muted">
                    ({minutes(r.overlapStart, r.overlapEnd)} min overlap)
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  {KIND_HINT[r.kind] ?? "Something already held this chair."}
                </p>

                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <RefCell label="Walk-in recorded" ctx={r.receipt} />
                  <RefCell label="Already on the chair" ctx={r.conflicting} />
                </dl>

                {r.resolvedAt ? (
                  <p className="mt-3 text-xs text-muted">
                    Resolved by {r.resolvedByName ?? "a teammate"}
                    {r.resolutionNote ? ` — “${r.resolutionNote}”` : ""}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setNotice(null);
                      setNote("");
                      setConfirming(r);
                    }}
                    className="mt-3 rounded-lg border border-subtle px-3 py-1.5 text-xs font-semibold text-offwhite transition-colors hover:border-gold/50 hover:text-gold"
                  >
                    Mark resolved
                  </button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {cursor && !loading && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="self-start rounded-lg border border-subtle px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-gold/50 hover:text-gold disabled:opacity-60"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}

      {/* 🔴 CONFIRMATION, and it spends its words saying what this does NOT do. */}
      <Dialog
        open={confirming !== null}
        onClose={() => {
          if (!saving) setConfirming(null);
        }}
        title="Mark this resolved?"
        className="max-w-md"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={saving}
              className="rounded-lg border border-subtle px-3 py-1.5 text-sm text-muted transition-colors hover:text-offwhite disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmResolve()}
              disabled={saving}
              className="rounded-lg bg-gold px-3 py-1.5 text-sm font-semibold text-charcoal-900 transition-colors hover:bg-gold/90 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Mark resolved"}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-offwhite">
            This records that you&rsquo;ve dealt with the double-booking.
          </p>
          <p className="text-sm text-muted">
            It does <strong className="text-offwhite">not</strong> cancel, move or refund either
            booking, and it doesn&rsquo;t tell the customer anything. Both appointments stay exactly
            as they are.
          </p>
          <label className="flex flex-col gap-1 text-xs text-muted">
            <span>What did you do? (optional)</span>
            <input
              type="text"
              value={note}
              maxLength={280}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Called the client, moved them to 3pm"
              /* 16px floor: anything smaller makes iOS zoom on focus. */
              className="rounded-lg border border-subtle bg-charcoal-800 px-3 py-2 text-base text-offwhite placeholder:text-muted/60 focus:border-gold/50"
            />
          </label>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * One of the two records. Shows what it is and when - never who it is for.
 * A booking that has since been deleted still renders, saying so.
 */
function RefCell({ label, ctx }: { label: string; ctx: { exists: boolean; startsAt: string | null; endsAt: string | null; status: string | null } }) {
  return (
    <div className="min-w-0 rounded-lg border border-subtle bg-charcoal-800/60 px-2.5 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-offwhite">
        {ctx.exists && ctx.startsAt ? (
          <>
            {ctx.endsAt ? timeRange(ctx.startsAt, ctx.endsAt) : timeRange(ctx.startsAt, ctx.startsAt)}
            {ctx.status && <span className="ml-1 text-muted">&middot; {ctx.status}</span>}
          </>
        ) : (
          <span className="text-muted">No longer on the calendar</span>
        )}
      </dd>
    </div>
  );
}
