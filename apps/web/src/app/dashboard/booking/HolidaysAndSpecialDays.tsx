"use client";

import { useEffect, useMemo, useState } from "react";
import { HolidayPricing } from "./HolidayPricing";
import { SpecialDayCard } from "./SpecialDayCard";
import { LiveDayView } from "./LiveDayView";
import { listSpecialDaysAction, type SpecialDayRow } from "./actions";
import type { ServiceRow, StaffRow } from "./page";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * "THIS DATE IS DIFFERENT", in one place: Holiday pricing (a different price
 * on a named date) and Special day (the date run your own way) share ONE live
 * view of the day and one list of special days. Either card opens the same
 * LiveDayView, so there are not two disconnected tools for the same thought.
 */
export function HolidaysAndSpecialDays({
  services,
  staff,
  names,
  timezone,
  toast,
  onChanged,
}: {
  services: ServiceRow[];
  staff: StaffRow[];
  names?: Record<string, string>;
  timezone: string;
  toast: Toast;
  /** A special day was saved or removed (the Targeted slots list re-reads). */
  onChanged?: () => void;
}) {
  // Upcoming special days, one row per chair. null = still loading.
  const [rows, setRows] = useState<SpecialDayRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [live, setLive] = useState<{ dates: string[]; name?: string; price?: number | null } | null>(null);

  // Loads on its own, never behind a busy flag: a reload after a save must
  // not be dropped.
  function load() {
    void listSpecialDaysAction()
      .then((r) => {
        if (r.ok && r.specialDays) {
          setRows(r.specialDays);
          setLoadFailed(false);
        } else setLoadFailed(true);
      })
      .catch(() => setLoadFailed(true));
  }
  useEffect(() => {
    load();
  }, []);

  // Per date, across chairs - the badge on a holiday row.
  const byDate = useMemo(() => {
    const out: Record<string, { openings: number; booked: number }> = {};
    for (const r of rows ?? []) {
      const cur = out[r.date] ?? { openings: 0, booked: 0 };
      out[r.date] = { openings: cur.openings + r.openings, booked: cur.booked + r.booked };
    }
    return out;
  }, [rows]);

  function changed() {
    load();
    onChanged?.();
  }

  return (
    <>
      <HolidayPricing
        services={services}
        names={names}
        timezone={timezone}
        toast={toast}
        specialDays={byDate}
        onOpenLiveView={(dates, name, price) => setLive({ dates, name, price })}
      />
      <SpecialDayCard
        rows={rows}
        loadFailed={loadFailed}
        onReload={load}
        staff={staff}
        timezone={timezone}
        toast={toast}
        onOpen={(date, name) => setLive({ dates: [date], name: name ?? names?.[date] })}
        onChanged={changed}
      />
      {live && (
        <LiveDayView
          open
          dates={live.dates}
          defaultName={live.name}
          defaultPrice={live.price}
          services={services}
          staff={staff}
          toast={toast}
          onClose={() => setLive(null)}
          onSaved={changed}
        />
      )}
    </>
  );
}
