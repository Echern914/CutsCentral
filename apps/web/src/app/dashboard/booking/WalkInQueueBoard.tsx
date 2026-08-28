"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { useVisiblePoll } from "@/lib/useVisiblePoll";
import {
  getWalkInQueueAction,
  walkInAssignAction,
  walkInReorderAction,
  walkInStartAction,
  walkInTransitionAction,
  type WalkInEntryRow,
  type WalkInQueueData,
  type WalkInSimpleAction,
} from "./actions";
import type { StaffRow } from "./page";


/**
 * The Live Queue - the walk-in line as the person running the desk works it.
 *
 * 🔴 NOT the waitlist board's data, deliberately its visual sibling: the
 * waitlist is "call me when a future slot opens"; this is "these people are
 * STANDING IN THE SHOP". The two live one tab apart and share nothing but
 * the card language.
 *
 * Buttons here are CONVENIENCE, not authority: every action lands on the
 * server's CAS lifecycle, so a stale board (someone else claimed, the
 * customer left from their phone) answers 409 and the board refreshes to
 * the truth. `slot_taken` on Start is the one expected conflict - an online
 * booking landed on that instant first - and it reads as exactly that.
 *
 * Estimates come from the ONE engine and are always LABELED estimates - the
 * same numbers the kiosk quoted and the customer's phone shows.
 */

const ACTIVE_STATUSES = ["WAITING", "ASSIGNED", "READY", "IN_SERVICE"] as const;

const STATUS_BADGE: Record<string, string> = {
  WAITING: "bg-gold/15 text-gold",
  ASSIGNED: "bg-sky-400/15 text-sky-300",
  READY: "bg-emerald-soft/15 text-emerald-soft",
  IN_SERVICE: "bg-emerald-soft/15 text-emerald-soft",
  COMPLETED: "bg-charcoal-700 text-muted",
  LEFT: "bg-charcoal-700 text-muted",
  NO_SHOW: "bg-danger-soft/15 text-danger-soft",
  CANCELED: "bg-charcoal-700 text-muted",
  EXPIRED: "bg-charcoal-700 text-muted",
};

const STATUS_LABEL: Record<string, string> = {
  WAITING: "Waiting",
  ASSIGNED: "Claimed",
  READY: "Ready",
  IN_SERVICE: "In the chair",
  COMPLETED: "Done",
  LEFT: "Left",
  NO_SHOW: "No-show",
  CANCELED: "Removed",
  EXPIRED: "Expired",
};

/** 44px-on-mobile action pill (relaxes once there's a pointer). */
const ACT_BTN =
  "flex h-11 items-center justify-center rounded-full px-4 text-xs font-semibold transition-colors disabled:opacity-40 sm:h-9 sm:px-3.5";

function displayName(e: Pick<WalkInEntryRow, "firstName" | "lastName">): string {
  const initial = e.lastName?.trim()?.[0];
  return initial ? `${e.firstName} ${initial.toUpperCase()}.` : e.firstName;
}

function minutesSince(iso: string, nowIso: string): number {
  return Math.max(
    0,
    Math.round((new Date(nowIso).getTime() - new Date(iso).getTime()) / 60_000),
  );
}

export function WalkInQueueBoard({
  staff,
  walkInEnabled,
  timezone,
  toast,
}: {
  staff: StaffRow[];
  walkInEnabled: boolean;
  timezone: string;
  toast: (message: string, kind?: "success" | "error" | "info") => void;
}) {
  const [data, setData] = useState<WalkInQueueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [pending, setPending] = useState(false);

  const staffName = useMemo(() => {
    const m = new Map(staff.map((s) => [s.id, s.name]));
    return (id: string | null) => (id ? (m.get(id) ?? "Unknown chair") : null);
  }, [staff]);

  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
      }),
    [timezone],
  );

  const load = useCallback(async () => {
    const res = await getWalkInQueueAction();
    if (res.ok && res.data) {
      setData(res.data);
      setOffline(false);
    } else if (res.error === "walk_in_disabled") {
      setData(null);
      setOffline(false);
    } else {
      // Keep the last board; say so. Never render an empty line as truth.
      setOffline(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (walkInEnabled) void load();
    else setLoading(false);
  }, [walkInEnabled, load]);
  useVisiblePoll(load, 20_000, walkInEnabled);

  /** Run one server action, surface its answer honestly, reload the truth. */
  const act = useCallback(
    (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
      setPending(true);
      void (async () => {
        const res = await fn();
        if (res.ok) toast(okMsg);
        else if (res.error === "slot_taken")
          toast("That chair just got booked for this exact time — the queue re-estimated.");
        else if (res.error === "stale_transition" || res.error === "invalid_transition")
          toast("That one just moved — refreshing the line.");
        else toast("Couldn't do that — try again.");
        await load();
        setPending(false);
      })();
    },
    [load, toast],
  );

  if (!walkInEnabled) {
    return (
      <Card className="px-5 py-8 text-center">
        <p className="text-sm font-medium text-offwhite">Walk-In Mode is off</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted">
          When it&rsquo;s on, customers check themselves in on a shop tablet and
          this board runs the live line — claims, ready calls, and service
          starts. The switch arrives with the Walk-In settings card.
        </p>
      </Card>
    );
  }
  if (loading) {
    return <Card className="px-5 py-8 text-center text-sm text-muted">Loading the line…</Card>;
  }
  if (!data) {
    return (
      <Card className="px-5 py-8 text-center text-sm text-muted">
        Walk-In Mode isn&rsquo;t available right now.
      </Card>
    );
  }

  const active = data.entries.filter((e) =>
    (ACTIVE_STATUSES as readonly string[]).includes(e.status),
  );
  const waiting = active.filter((e) => e.status === "WAITING");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg text-offwhite">Live line</h2>
          <p className="text-xs text-muted">
            {active.length === 0
              ? "Nobody waiting right now."
              : `${active.length} in the line · estimates update as the day moves`}
            {!data.acceptingNow && " · NOT accepting new walk-ins"}
          </p>
        </div>
        <button
          type="button"
          className={cn(
            ACT_BTN,
            showDone
              ? "bg-gold/15 text-gold ring-1 ring-gold/30"
              : "text-muted hover:bg-charcoal-700 hover:text-offwhite",
          )}
          onClick={() => setShowDone((v) => !v)}
        >
          Done today{data.done?.length ? ` (${data.done.length})` : ""}
        </button>
      </div>

      {offline && (
        <p role="status" className="text-center text-xs text-danger-soft">
          Trouble reaching the queue — showing the last board and retrying.
        </p>
      )}

      {active.length === 0 && !showDone ? (
        <Card className="px-5 py-10 text-center">
          <p className="text-sm text-muted">
            The line is empty. Check-ins from the shop tablet land here the
            moment they verify their phone.
          </p>
        </Card>
      ) : (
        <ul className="flex min-w-0 flex-col gap-3">
          {active.map((e) => {
            const waitingIdx = waiting.findIndex((w) => w.id === e.id);
            return (
              <WalkInCard
                key={e.id}
                entry={e}
                nowIso={data.now}
                staff={staff}
                staffName={staffName}
                timeFmt={timeFmt}
                positionLabel={
                  e.status === "WAITING" && waitingIdx >= 0
                    ? `#${waitingIdx + 1}`
                    : null
                }
                pending={pending}
                onAction={(action) =>
                  act(
                    () => walkInTransitionAction(e.id, action),
                    action === "complete" ? "Marked done — it's on the books." : "Updated.",
                  )
                }
                onAssign={(staffId) =>
                  act(() => walkInAssignAction(e.id, staffId), "Assigned.")
                }
                onStart={(staffId) =>
                  act(() => walkInStartAction(e.id, staffId), "Service started.")
                }
                onMove={(dir) => {
                  if (waitingIdx < 0) return;
                  const after =
                    dir === "up"
                      ? (waiting[waitingIdx - 2]?.id ?? null)
                      : (waiting[waitingIdx + 1]?.id ?? null);
                  if (dir === "up" && waitingIdx === 0) return;
                  if (dir === "down" && waitingIdx === waiting.length - 1) return;
                  act(
                    () => walkInReorderAction(e.id, after, e.position),
                    "Moved.",
                  );
                }}
              />
            );
          })}
        </ul>
      )}

      {showDone && (
        <Card className="overflow-hidden">
          <p className="border-b border-subtle px-4 py-3 text-xs font-medium text-muted">
            Finished today
          </p>
          {!data.done || data.done.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted">
              Nothing finished yet today.
            </p>
          ) : (
            <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
              {data.done.map((e) => (
                <li key={e.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
                      STATUS_BADGE[e.status] ?? STATUS_BADGE.CANCELED,
                    )}
                  >
                    {STATUS_LABEL[e.status] ?? e.status}
                  </span>
                  <p className="min-w-0 flex-1 truncate text-sm text-offwhite">
                    {displayName(e)}
                    <span className="text-muted">
                      {" "}
                      · {e.services.map((s) => s.name).join(" + ")}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function WalkInCard({
  entry: e,
  nowIso,
  staff,
  staffName,
  timeFmt,
  positionLabel,
  pending,
  onAction,
  onAssign,
  onStart,
  onMove,
}: {
  entry: WalkInEntryRow;
  nowIso: string;
  staff: StaffRow[];
  staffName: (id: string | null) => string | null;
  timeFmt: Intl.DateTimeFormat;
  positionLabel: string | null;
  pending: boolean;
  onAction: (action: WalkInSimpleAction) => void;
  onAssign: (staffId: string) => void;
  onStart: (staffId?: string) => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The chair a WAITING start/assign will use unless the desk picks another:
  // the engine's own projection, so the button does what the estimate said.
  const [chairPick, setChairPick] = useState<string>("");
  const activeStaff = staff.filter((s) => s.active !== false);
  const pickedChair =
    chairPick || e.estimate.projectedStaffId || activeStaff[0]?.id || "";

  const waited = minutesSince(e.joinedAt, nowIso);
  const requested = e.preferredStaffId
    ? staffName(e.preferredStaffId)
    : "Next available";

  return (
    <li>
      <Card className="min-w-0 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          {positionLabel && (
            <span className="mt-0.5 shrink-0 font-display text-lg text-gold">
              {positionLabel}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="min-w-0 break-words text-base font-semibold text-offwhite">
                {displayName(e)}
              </p>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
                  STATUS_BADGE[e.status] ?? STATUS_BADGE.WAITING,
                )}
              >
                {STATUS_LABEL[e.status] ?? e.status}
              </span>
              {e.source === "KIOSK" && (
                <span className="shrink-0 rounded-full bg-charcoal-700 px-2 py-1 text-[10px] uppercase tracking-wide text-muted">
                  Kiosk
                </span>
              )}
            </div>
            <p className="mt-0.5 break-words text-xs text-muted">
              {e.services.map((s) => s.name).join(" + ")} ·{" "}
              {e.totalDurationMin} min
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Joined {timeFmt.format(new Date(e.joinedAt))} · waiting {waited}m
              {e.status === "WAITING" && (
                <>
                  {" "}
                  · asked for <span className="text-offwhite">{requested}</span>
                </>
              )}
              {e.assignedStaffId && (
                <>
                  {" "}
                  · with{" "}
                  <span className="text-offwhite">
                    {staffName(e.assignedStaffId)}
                  </span>
                </>
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {e.status === "IN_SERVICE" && e.startedAt
                ? `Started ${timeFmt.format(new Date(e.startedAt))}`
                : e.estimate.waitMin !== null
                  ? `Est. start ~${e.estimate.waitMin}m${
                      e.estimate.projectedStaffId && !e.assignedStaffId
                        ? ` (${staffName(e.estimate.projectedStaffId)})`
                        : ""
                    } — estimate`
                  : "Estimate unavailable — served in order"}
            </p>
          </div>
          {e.status === "WAITING" && (
            <div className="flex shrink-0 flex-col gap-1">
              <button
                type="button"
                aria-label={`Move ${displayName(e)} up the line`}
                className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-charcoal-700 hover:text-offwhite sm:h-8 sm:w-8"
                disabled={pending}
                onClick={() => onMove("up")}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${displayName(e)} down the line`}
                className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-charcoal-700 hover:text-offwhite sm:h-8 sm:w-8"
                disabled={pending}
                onClick={() => onMove("down")}
              >
                ↓
              </button>
            </div>
          )}
        </div>

        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          {(e.status === "WAITING" || e.status === "ASSIGNED") && (
            <select
              aria-label={`Chair for ${displayName(e)}`}
              className="h-11 min-w-0 rounded-full border border-subtle bg-charcoal-900 px-3 text-xs text-offwhite sm:h-9"
              value={pickedChair}
              disabled={pending}
              onChange={(ev) => {
                setChairPick(ev.target.value);
                if (e.status === "ASSIGNED" && ev.target.value !== e.assignedStaffId) {
                  onAssign(ev.target.value);
                }
              }}
            >
              {activeStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {e.status === "WAITING" && (
            <button
              type="button"
              className={cn(ACT_BTN, "bg-charcoal-700 text-offwhite hover:bg-charcoal-600")}
              disabled={pending || !pickedChair}
              onClick={() => onAssign(pickedChair)}
            >
              Assign
            </button>
          )}
          {e.status === "ASSIGNED" && (
            <button
              type="button"
              className={cn(ACT_BTN, "bg-emerald-soft/15 text-emerald-soft hover:bg-emerald-soft/25")}
              disabled={pending}
              onClick={() => onAction("ready")}
            >
              Mark ready
            </button>
          )}
          {(e.status === "WAITING" || e.status === "ASSIGNED" || e.status === "READY") && (
            <button
              type="button"
              className={cn(ACT_BTN, "bg-gold text-charcoal hover:bg-gold-muted")}
              disabled={pending || (e.status === "WAITING" && !pickedChair)}
              onClick={() =>
                onStart(e.status === "WAITING" ? pickedChair : undefined)
              }
            >
              Start service
            </button>
          )}
          {e.status === "IN_SERVICE" && (
            <button
              type="button"
              className={cn(ACT_BTN, "bg-gold text-charcoal hover:bg-gold-muted")}
              disabled={pending}
              onClick={() => onAction("complete")}
            >
              Complete
            </button>
          )}
          {(e.status === "ASSIGNED" || e.status === "READY") && (
            <>
              <button
                type="button"
                className={cn(ACT_BTN, "text-muted hover:bg-charcoal-700 hover:text-offwhite")}
                disabled={pending}
                onClick={() => onAction("return")}
              >
                Back to line
              </button>
              <button
                type="button"
                className={cn(ACT_BTN, "text-danger-soft hover:bg-danger-soft/10")}
                disabled={pending}
                onClick={() => onAction("no-show")}
              >
                No-show
              </button>
            </>
          )}
          {e.status !== "IN_SERVICE" && (
            <button
              type="button"
              className={cn(ACT_BTN, "text-muted hover:bg-charcoal-700 hover:text-offwhite")}
              disabled={pending}
              onClick={() => onAction("leave")}
            >
              Left
            </button>
          )}
          {confirmRemove ? (
            <>
              <button
                type="button"
                className={cn(ACT_BTN, "bg-danger text-offwhite")}
                disabled={pending}
                onClick={() => {
                  setConfirmRemove(false);
                  onAction("cancel");
                }}
              >
                Yes, remove
              </button>
              <button
                type="button"
                className={cn(ACT_BTN, "text-muted hover:bg-charcoal-700")}
                onClick={() => setConfirmRemove(false)}
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className={cn(ACT_BTN, "text-danger-soft hover:bg-danger-soft/10")}
              disabled={pending}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </button>
          )}
        </div>
      </Card>
    </li>
  );
}
