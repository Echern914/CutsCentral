"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { cap, useVocab } from "@/components/VocabProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  getAcuityMappingAction,
  setStaffAcuityCalendarAction,
  setStaffAcuityExtraCalendarsAction,
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
  const vocab = useVocab();
  const [data, setData] = useState<AcuityMappingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingExtrasId, setSavingExtrasId] = useState<string | null>(null);
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

  function save(staffId: string, calendarId: string | null, connectedAt: string | null) {
    setSavingId(staffId);
    start(async () => {
      const res = await setStaffAcuityCalendarAction(staffId, calendarId, connectedAt);
      setSavingId(null);
      if (!res.ok) {
        // The id was rejected against the live account — almost always a stale
        // tab after a reconnect. Reloading re-reads the real calendar list.
        toast(
          res.error === "calendar_not_on_account"
            ? "That calendar isn't on your Acuity account anymore — refreshed the list."
            : res.error === "calendar_already_mapped"
              ? `Another ${vocab.stationNoun} already uses that calendar. One calendar per ${vocab.stationNoun}.`
              : res.error === "acuity_connection_changed"
                ? "Your Acuity connection changed while you were choosing — refreshed the list, please pick again."
                : "Couldn't save that mapping",
          "error",
        );
        void load();
        return;
      }
      toast(calendarId ? `${cap(vocab.stationNoun)} mapped` : "Mapping cleared", "success");
      void load();
    });
  }

  /**
   * Turn one EXTRA calendar on or off for a chair.
   *
   * The whole list is sent, not a delta: the server validates every id against
   * the live account and owns the "one calendar, one chair" rule, so a list is
   * the only shape that can be checked as a unit.
   */
  function toggleExtra(
    staffId: string,
    current: string[],
    calendarId: string,
    on: boolean,
    connectedAt: string | null,
  ) {
    const next = on
      ? [...current, calendarId]
      : current.filter((id) => id !== calendarId);
    setSavingExtrasId(staffId);
    start(async () => {
      const res = await setStaffAcuityExtraCalendarsAction(staffId, next, connectedAt);
      setSavingExtrasId(null);
      if (!res.ok) {
        toast(
          res.error === "calendar_not_on_account"
            ? "That calendar isn't on your Acuity account anymore — refreshed the list."
            : res.error === "calendar_already_mapped"
              ? `Another ${vocab.stationNoun} already uses that calendar. One calendar per ${vocab.stationNoun}.`
              : res.error === "acuity_connection_changed"
                ? "Your Acuity connection changed while you were choosing — refreshed the list, please pick again."
                : "Couldn't save that calendar",
          "error",
        );
        void load();
        return;
      }
      toast(on ? "Calendar added" : "Calendar removed", "success");
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
          title={`Acuity ${vocab.stationNoun} mapping`}
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

  /**
   * Calendars this chair may ALSO be blocked on: everything on the account
   * except its own primary and anything another chair already owns.
   *
   * A stored extra that has vanished from Acuity is kept in the list, marked
   * unknown - dropping it would leave a broken id doing nothing, with no way
   * for the owner to see it or clear it.
   */
  const extrasFor = (staffId: string, primaryId: string) => {
    const onAccount = data.calendars.filter(
      (c) => c.id !== primaryId && (c.takenByStaffId === null || c.takenByStaffId === staffId),
    );
    const stored = data.staff.find((s) => s.id === staffId)?.extraCalendarIds ?? [];
    const missing = stored
      .filter((id) => !data.calendars.some((c) => c.id === id))
      .map((id) => ({ id, name: `Unknown calendar (${id})`, takenByStaffId: staffId }));
    return [...onAccount, ...missing];
  };

  return (
    <Card className="p-5">
      <CardHeader
        title={`Acuity ${vocab.stationNoun} mapping`}
        subtitle={`You take bookings in ChairBack, and your Acuity account is still connected. Match each ${vocab.stationNoun} to its Acuity calendar so ChairBack can hold the time on both.`}
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
          ? `Every bookable ${vocab.stationNoun} is mapped.`
          : blocking.length === 0
            ? `Add a bookable ${vocab.stationNoun} (an active ${vocab.providerNoun} offering an active service) to finish setup.`
            : `${blocking.length} ${blocking.length === 1 ? `${vocab.stationNoun} still needs` : `${vocab.stationNounPlural} still need`} a calendar before ChairBack can hold time in Acuity.`}
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
            <li key={s.id} className="flex flex-col gap-3 rounded-lg border border-subtle p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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
                          ? `Mapped before you last reconnected Acuity — confirm it still points at the right ${vocab.stationNoun}`
                          : s.problem === "extra_invalid"
                            ? "One of the extra calendars below is no longer on your Acuity account — untick it"
                            : "That calendar is no longer on your Acuity account"}
                    </p>
                  )}
                </div>

                <label className="flex shrink-0 items-center gap-2">
                  <span className="sr-only">{`Acuity calendar for ${s.name}`}</span>
                  <select
                    value={value || (suggested ?? "")}
                    disabled={savingId === s.id}
                    onChange={(e) => save(s.id, e.target.value || null, data.connectedAt)}
                    className="h-11 min-w-[12rem] rounded-lg border border-subtle bg-charcoal-900 px-3 text-sm text-offwhite disabled:opacity-50 sm:h-9"
                  >
                    <option value="">Not mapped</option>
                    {data.calendars.map((c) => {
                      // One calendar, one chair: a calendar another chair owns is
                      // shown but unselectable, so the owner can see WHY it is
                      // unavailable instead of hitting a conflict on save.
                      const taken = c.takenByStaffId !== null && c.takenByStaffId !== s.id;
                      return (
                        <option key={c.id} value={c.id} disabled={taken}>
                          {(c.name ?? `Calendar ${c.id}`) + (taken ? " — already mapped" : "")}
                        </option>
                      );
                    })}
                    {/* A stored id that vanished from Acuity still needs to be
                        visible, or the row would silently read "Not mapped". */}
                    {s.calendarId && !data.calendars.some((c) => c.id === s.calendarId) && (
                      <option value={s.calendarId}>{`Unknown calendar (${s.calendarId})`}</option>
                    )}
                  </select>
                </label>
              </div>

              {/* THE OTHER CALENDARS THIS SAME PERSON IS SOLD ON.
                  Acuity blocks are calendar-scoped, so an account that splits
                  one barber across "Haircut" / "Retwists" / "After hours"
                  needs every one of them blocked for a single booking — which
                  is what those barbers are already doing by hand. Hidden
                  unless there is a primary calendar and something else to
                  pick, so the ordinary one-calendar shop never sees it. */}
              {s.calendarId && extrasFor(s.id, s.calendarId).length > 0 && (
                <div className="border-t border-subtle pt-2">
                  <p className="text-[11px] font-medium text-muted">
                    {`Also block these calendars when ${s.name} is booked`}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {`Only if Acuity sells ${s.name} through more than one calendar. Each one you tick gets blocked too, so the same hour can't be sold twice.`}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                    {extrasFor(s.id, s.calendarId).map((c) => {
                      const on = s.extraCalendarIds.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className="flex items-center gap-2 text-xs text-offwhite"
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={savingExtrasId === s.id}
                            onChange={(e) =>
                              toggleExtra(
                                s.id,
                                s.extraCalendarIds,
                                c.id,
                                e.target.checked,
                                data.connectedAt,
                              )
                            }
                            className="h-4 w-4 rounded border-subtle bg-charcoal-900 disabled:opacity-50"
                          />
                          <span className="[overflow-wrap:anywhere]">
                            {c.name ?? `Calendar ${c.id}`}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {s.extraCalendarIds.length > 0 && (
                    <p className="mt-2 text-[11px] text-muted">
                      {`One booking will block ${s.extraCalendarIds.length + 1} calendars.`}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-[11px] text-muted">
        Holding time in Acuity is off until you turn it on. Mapping{" "}
        {vocab.stationNounPlural} here changes nothing on its own.
      </p>
    </Card>
  );
}
