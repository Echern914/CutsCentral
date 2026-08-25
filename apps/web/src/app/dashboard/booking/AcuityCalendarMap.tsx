"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  getAcuityMappingAction,
  setStaffAcuityCalendarAction,
  type AcuityMappingData,
} from "./actions";

/**
 * WHICH ACUITY CALENDAR IS WHICH CHAIR.
 *
 * Shown only in the one configuration where it matters: ChairBack is taking
 * the bookings AND an Acuity account is still connected. That shop has two
 * front doors onto one chair, and until this mapping exists ChairBack cannot
 * tell Acuity a time is taken — which is exactly how a ChairBack booking that
 * had held 6:10pm for eleven days got sold over from the Acuity side.
 *
 * Mapping is per chair and never guessed. Acuity blocks are calendar-scoped:
 * a block with no calendar lands wherever Acuity defaults, which on a
 * multi-barber account clears the WRONG barber's day while the real conflict
 * stays bookable. So an unmapped bookable chair blocks enforcement shop-wide
 * rather than half-protecting the shop.
 */
export function AcuityCalendarMap() {
  const [data, setData] = useState<AcuityMappingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [, start] = useTransition();
  const { toast } = useToast();

  const load = useCallback(async () => {
    const res = await getAcuityMappingAction();
    if (res.ok && res.data) {
      setData(res.data);
      setError(null);
    } else {
      setError(res.error ?? "failed");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function save(staffId: string, calendarId: string | null) {
    setSavingId(staffId);
    start(async () => {
      const res = await setStaffAcuityCalendarAction(staffId, calendarId);
      setSavingId(null);
      if (!res.ok) {
        // The id was rejected against the live account — almost always a stale
        // tab after a reconnect. Reloading re-reads the real calendar list.
        toast(
          res.error === "calendar_not_on_account"
            ? "That calendar isn't on your Acuity account anymore — refreshed the list."
            : "Couldn't save that mapping",
          "error",
        );
        void load();
        return;
      }
      toast(calendarId ? "Chair mapped" : "Mapping cleared", "success");
      void load();
    });
  }

  if (loading) {
    return (
      <Card className="p-5">
        <p className="text-sm text-muted">Loading your Acuity calendars…</p>
      </Card>
    );
  }

  if (error === "acuity_not_connected") return null; // nothing to map

  if (error) {
    return (
      <Card className="p-5">
        <CardHeader
          title="Acuity chair mapping"
          subtitle="Couldn't reach Acuity just now. Your bookings are unaffected — try again, or reconnect Acuity if this keeps happening."
        />
        <button
          onClick={() => {
            setLoading(true);
            void load();
          }}
          className="mt-3 h-11 rounded-lg border border-subtle px-4 text-xs font-medium text-offwhite hover:bg-charcoal-700 sm:h-9"
        >
          Try again
        </button>
      </Card>
    );
  }

  if (!data) return null;

  const bookable = data.staff.filter((s) => s.bookable);
  const blocking = bookable.filter((s) => s.problem !== null);

  return (
    <Card className="p-5">
      <CardHeader
        title="Acuity chair mapping"
        subtitle="You take bookings in ChairBack, and your Acuity account is still connected. Match each chair to its Acuity calendar so ChairBack can hold the time on both."
      />

      <div
        className={cn(
          "mt-4 rounded-lg border px-3 py-2 text-xs",
          data.ready
            ? "border-emerald-soft/40 bg-emerald-soft/10 text-emerald-soft"
            : "border-amber-400/40 bg-amber-400/10 text-amber-300",
        )}
        role="status"
      >
        {data.ready
          ? "Every bookable chair is mapped."
          : blocking.length === 0
            ? "Add a bookable chair (an active barber offering an active service) to finish setup."
            : `${blocking.length} ${blocking.length === 1 ? "chair still needs" : "chairs still need"} a calendar before ChairBack can hold time in Acuity.`}
      </div>

      <ul className="mt-4 flex flex-col gap-3">
        {data.staff.map((s) => {
          const value = s.calendarId ?? "";
          // Unambiguous shape (one chair, one calendar): preselect it in the
          // control so one tap saves — but still SHOW it, because an unseen
          // default is how the wrong barber gets blocked.
          const suggested =
            !s.calendarId && data.preselectCalendarId ? data.preselectCalendarId : null;
          return (
            <li
              key={s.id}
              className="flex flex-col gap-2 rounded-lg border border-subtle p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="[overflow-wrap:anywhere] text-sm font-semibold text-offwhite">
                  {s.name}
                  {!s.bookable && (
                    <span className="ml-2 rounded-full bg-charcoal-700 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                      {s.active ? "No active services" : "Inactive"}
                    </span>
                  )}
                </p>
                {s.bookable && s.problem && (
                  <p className="mt-0.5 text-[11px] text-amber-300">
                    {s.problem === "unmapped"
                      ? "Not mapped yet"
                      : s.problem === "stale"
                        ? "Mapped before you last reconnected Acuity — confirm it still points at the right chair"
                        : "That calendar is no longer on your Acuity account"}
                  </p>
                )}
              </div>

              <label className="flex shrink-0 items-center gap-2">
                <span className="sr-only">{`Acuity calendar for ${s.name}`}</span>
                <select
                  value={value || (suggested ?? "")}
                  disabled={savingId === s.id}
                  onChange={(e) => save(s.id, e.target.value || null)}
                  className="h-11 min-w-[12rem] rounded-lg border border-subtle bg-charcoal-900 px-3 text-sm text-offwhite disabled:opacity-50 sm:h-9"
                >
                  <option value="">Not mapped</option>
                  {data.calendars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name ?? `Calendar ${c.id}`}
                    </option>
                  ))}
                  {/* A stored id that vanished from Acuity still needs to be
                      visible, or the row would silently read "Not mapped". */}
                  {s.calendarId && !data.calendars.some((c) => c.id === s.calendarId) && (
                    <option value={s.calendarId}>{`Unknown calendar (${s.calendarId})`}</option>
                  )}
                </select>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-[11px] text-muted">
        Holding time in Acuity is off until you turn it on. Mapping chairs here changes
        nothing on its own.
      </p>
    </Card>
  );
}
