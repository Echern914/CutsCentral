"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { useVisiblePoll } from "@/lib/useVisiblePoll";
import {
  barberWalkInAction,
  getBarberWalkInsAction,
  type BarberWalkInsData,
  type BarberWalkInVerb,
} from "./barberWalkInActions";

/**
 * The barber's own slice of the walk-in line, on their home screen - the ONE
 * screen an employee seat has (they never reach /dashboard/booking).
 *
 * Shows THEIR claimed customers with the next action, then the claimable
 * WAITING line. Claiming is one tap; the server's CAS decides races (two
 * barbers tapping the same customer = one winner, the loser's board just
 * refreshes). Renders NOTHING when Walk-In Mode is off or dark - a quiet
 * feature, not an ad for it.
 */

const ACT_BTN =
  "flex h-11 items-center justify-center rounded-full px-4 text-xs font-semibold transition-colors disabled:opacity-40";

function displayName(e: { firstName: string; lastName: string | null }): string {
  const initial = e.lastName?.trim()?.[0];
  return initial ? `${e.firstName} ${initial.toUpperCase()}.` : e.firstName;
}

export function BarberWalkIns() {
  const [data, setData] = useState<BarberWalkInsData | null>(null);
  const [hidden, setHidden] = useState(false);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const res = await getBarberWalkInsAction();
    if (res.ok && res.data) {
      setData(res.data);
      setHidden(false);
    } else if (res.status === 404 || res.error === "walk_in_disabled") {
      setHidden(true);
    }
    // Network trouble: keep the last board silently; the poll retries.
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useVisiblePoll(load, 20_000, !hidden);

  const act = useCallback(
    (id: string, verb: BarberWalkInVerb) => {
      setPending(true);
      void (async () => {
        await barberWalkInAction(id, verb);
        // Whatever happened (won, lost the race, stale), the truth is one
        // reload away - the server's CAS already made it safe.
        await load();
        setPending(false);
      })();
    },
    [load],
  );

  const { mine, claimable } = useMemo(() => {
    const entries = data?.entries ?? [];
    const chair = data?.chairStaffId ?? null;
    return {
      mine: entries.filter(
        (e) =>
          chair !== null &&
          e.assignedStaffId === chair &&
          ["ASSIGNED", "READY", "IN_SERVICE"].includes(e.status),
      ),
      claimable: entries.filter((e) => e.status === "WAITING"),
    };
  }, [data]);

  if (hidden || !data) return null;
  if (mine.length === 0 && claimable.length === 0) return null;
  const canAct = data.chairStaffId !== null;

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="border-b border-subtle px-5 py-4">
        <h2 className="font-display text-lg">Walk-in line</h2>
        <p className="text-xs text-muted">
          {claimable.length === 0
            ? "Nobody waiting to be claimed."
            : `${claimable.length} waiting · tap Claim to take the next one`}
        </p>
      </div>
      <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
        {mine.map((e) => (
          <li key={e.id} className="flex min-w-0 flex-wrap items-center gap-3 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium text-offwhite">
                {displayName(e)}
                <span className="ml-2 rounded-full bg-emerald-soft/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-soft">
                  {e.status === "IN_SERVICE"
                    ? "In your chair"
                    : e.status === "READY"
                      ? "Ready"
                      : "Yours"}
                </span>
              </p>
              <p className="mt-0.5 break-words text-xs text-muted">
                {e.services.map((s) => s.name).join(" + ")} · {e.totalDurationMin} min
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {e.status === "ASSIGNED" && (
                <button
                  type="button"
                  className={cn(ACT_BTN, "bg-emerald-soft/15 text-emerald-soft")}
                  disabled={pending}
                  onClick={() => act(e.id, "ready")}
                >
                  Ready
                </button>
              )}
              {(e.status === "ASSIGNED" || e.status === "READY") && (
                <>
                  <button
                    type="button"
                    className={cn(ACT_BTN, "bg-gold text-charcoal")}
                    disabled={pending}
                    onClick={() => act(e.id, "start")}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className={cn(ACT_BTN, "text-muted hover:bg-charcoal-700")}
                    disabled={pending}
                    onClick={() => act(e.id, "return")}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className={cn(ACT_BTN, "text-danger-soft hover:bg-danger-soft/10")}
                    disabled={pending}
                    onClick={() => act(e.id, "no-show")}
                  >
                    No-show
                  </button>
                </>
              )}
              {e.status === "IN_SERVICE" && (
                <button
                  type="button"
                  className={cn(ACT_BTN, "bg-gold text-charcoal")}
                  disabled={pending}
                  onClick={() => act(e.id, "complete")}
                >
                  Complete
                </button>
              )}
            </div>
          </li>
        ))}
        {claimable.map((e) => (
          <li key={e.id} className="flex min-w-0 items-center gap-3 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium text-offwhite">
                {displayName(e)}
              </p>
              <p className="mt-0.5 break-words text-xs text-muted">
                {e.services.map((s) => s.name).join(" + ")} · {e.totalDurationMin} min
                {e.estimate.waitMin !== null && ` · est. ~${e.estimate.waitMin}m`}
              </p>
            </div>
            <button
              type="button"
              className={cn(ACT_BTN, "shrink-0 bg-gold text-charcoal")}
              disabled={pending || !canAct}
              title={canAct ? undefined : "Your login isn't linked to a chair yet"}
              onClick={() => act(e.id, "claim")}
            >
              Claim
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
