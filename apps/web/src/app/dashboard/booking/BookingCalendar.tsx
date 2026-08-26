"use client";

// TouchEvent is aliased because the DOM global of the same name is NOT the
// React synthetic one, and the `React.` namespace is off-limits in this repo
// (two @types/react copies resolve, so React.X picks the wrong one).
import {
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { cn } from "@/lib/cn";
import { fmtDuration } from "@/lib/duration";
import {
  BTN_BASE,
  NAME_WRAP_CLS,
  appointmentStatusPill,
  initialsOf,
} from "../_components/appointmentCardStyles";
import { serviceColorHex } from "@chairback/config/constants";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import type {
  AgendaCategory,
  AgendaResponse,
  AgendaRow,
  ServiceRow,
  StaffRow,
  WaitlistRow,
} from "./page";
import {
  applyRewardAction,
  approveAppointmentAction,
  cancelAppointmentAction,
  cancelSeriesAction,
  completeAppointmentAction,
  declineAppointmentAction,
  dismissAppointmentAction,
  getAgendaAction,
  getWaitlistAction,
  markArrivedAction,
  noShowAppointmentAction,
  nudgeAppointmentAction,
  recordWalkInAction,
  removeBlockAction,
  restoreAppointmentAction,
} from "./actions";
import { agendaWindowOf, mergeAgendaWindow } from "./agendaMerge";
import { swipeAllowedFrom, swipeIntent } from "./daySwipe";
import { dayTotals, type DayTotals } from "./dayTotals";
import { AppointmentForm } from "./AppointmentForm";
import {
  WAITLIST_BOOK_EVENT,
  type WaitlistBookDetail,
} from "./WaitlistBoard";
import { AppointmentSheet, type SheetView } from "./AppointmentSheet";
import { BlockOffForm } from "./BlockOffForm";
import { useRouter } from "next/navigation";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * The barber's schedule, in two views he switches between.
 *
 * MONTH is the overview: each day a cell, tapping one drops down that day's
 * hour-by-hour planner inline (every working hour shown, empty hours as open
 * gaps), with the haircut type on each booking.
 *
 * DAY is the same planner given the whole card, paged one day at a time. It
 * exists because the month grid answers "how does the month look" while the
 * barber standing at the chair is asking "what's my day" - and getting that
 * out of the month view costs a tap on the right cell, with the planner then
 * squeezed under six rows of grid.
 *
 * Both render the SAME `DayPlanner`, so a row action, the gauge and the
 * category chips behave identically in either. The views share `selectedDay`
 * too: switch to Day and you land on the day you were looking at; switch back
 * and that day is the one selected.
 *
 * Data: the current month is loaded server-side on first paint; paging to
 * another month refetches via getAgendaAction. Everything is bucketed and
 * formatted in the SHOP's timezone (a "day"/"hour" = the barber's local one).
 * Native ("appointment") rows can be marked done / no-show / canceled here;
 * synced ("visit") rows (Acuity/Square) are read-only.
 */

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * How long the Undo button stays on a row the barber just cancelled.
 *
 * Long enough to notice and reach, short enough that the card settles into
 * being cancelled rather than looking half-decided. The server allows longer
 * (see RESTORE_WINDOW_MS) so a slow network never eats the action.
 */
const UNDO_WINDOW_MS = 10_000;

/** Why a restore was refused, in words a barber can act on. */
const UNDO_FAILURES: Record<string, string> = {
  slot_taken: "That time was taken while this was on screen — book it again to keep it.",
  too_late: "Too long ago to undo — book it again.",
  not_restorable: "Already refunded or checked out, so book it again instead.",
  not_canceled: "That booking isn't cancelled.",
  slot_unavailable_external: "The connected calendar won't hold that time.",
};

/**
 * True while `until` is in the future, flipping itself false when it passes.
 *
 * Nothing else re-renders this card once the cancel settles, so without the
 * timer the Undo button would sit there looking live long after the server had
 * stopped accepting it.
 */
function useUndoWindow(until: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(t);
  }, [until]);
  return until !== null && until > now;
}

/**
 * Spoken label for a week-strip cell ("Wednesday, Aug 26"). Built from a LOCAL
 * noon Date like every other key formatter here, so there is no zone conversion
 * in either direction - the key already IS a shop wall-clock day.
 */
const WEEKDAY_FULL_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "short",
  day: "numeric",
});
const VIEWS = [
  { key: "month", label: "Month" },
  { key: "day", label: "Day" },
] as const;
type CalendarView = (typeof VIEWS)[number]["key"];
// Default planner window (barber's local hours). Runs to midnight because some
// barbers cut late into the night; the window auto-widens earlier/later to fit
// any booking outside it (e.g. a 6am or 1am appointment).
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 23; // 11 PM row shown; midnight+ bookings widen it further

export function BookingCalendar({
  initial,
  initialWaitlist,
  onOpenWaitlist,
  isNative,
  staff,
  services,
  toast,
}: {
  initial: AgendaResponse;
  initialWaitlist: WaitlistRow[];
  /** Switch the page to the Waitlist tab (the summary panel's only action). */
  onOpenWaitlist: () => void;
  /** Native booking = the barber can add appointments + block off time here. */
  isNative: boolean;
  staff: StaffRow[];
  services: ServiceRow[];
  toast: Toast;
}) {
  const tz = initial.timezone;
  const router = useRouter();
  // Which sheet is open, and the ISO instant / day it targets.
  const [addAt, setAddAt] = useState<string | null>(null);
  // "Book appointment" tapped on the waitlist board: the board dispatches the
  // entry, the calendar opens the SAME create form it uses everywhere else,
  // prefilled. Keeps one booking flow in the app rather than two.
  const [waitlistBooking, setWaitlistBooking] = useState<WaitlistBookDetail | null>(
    null,
  );
  const [blockDay, setBlockDay] = useState<{ dayKey: string; hour: number } | null>(null);

  // Live count for the waitlist shortcut. Seeded from the server prop so the
  // badge is right on the first frame, then reconciled against the API's own
  // per-status tally - which is computed with no status filter, so it counts
  // WAITING only and can never drift as the board's filters change.
  const [waitingCount, setWaitingCount] = useState(
    () => initialWaitlist.filter((w) => w.status === "WAITING").length,
  );

  const refreshWaitingCount = useCallback(() => {
    // limit:1 - the rows are thrown away; only `counts` is wanted.
    void getWaitlistAction({ status: "WAITING", limit: 1 }).then((res) => {
      if (res.ok) setWaitingCount(res.counts.WAITING);
    });
  }, []);

  // ---- Shop-tz formatters (a day/hour always means the barber's local one) ----
  const partsFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      }),
    [tz],
  );
  const monthTitleFmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", year: "numeric" }),
    [tz],
  );
  const dayTitleFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
    [tz],
  );
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
    [tz],
  );

  /** {year, month(1-12), day(1-31), hour(0-23), min(0-59)} of an ISO instant, in shop tz. */
  const shopParts = (iso: string) => {
    const p = partsFmt.formatToParts(new Date(iso));
    const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
    // Intl with hour12:false can report midnight as "24" - normalize to 0.
    return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, min: get("minute") };
  };
  const dayKeyOf = (iso: string) => {
    const { y, m, d } = shopParts(iso);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  // "Today" in shop tz (as a YYYY-MM-DD key + the y/m for the initial month).
  const todayParts = shopParts(new Date().toISOString());
  const todayKey = `${todayParts.y}-${String(todayParts.m).padStart(2, "0")}-${String(
    todayParts.d,
  ).padStart(2, "0")}`;

  // ---- Loaded agenda (starts server-provided, replaced when paging months) ----
  const [agenda, setAgenda] = useState<AgendaRow[]>(initial.agenda);
  // Day-gauge buckets (service groups + ungrouped services, with their targets).
  // Refreshed alongside the agenda so editing a target in another tab shows up
  // on the next poll rather than needing a reload.
  const [categories, setCategories] = useState<AgendaCategory[]>(
    initial.categories ?? [],
  );
  const [pendingMonth, startMonthLoad] = useTransition();
  // Which months we've already fetched, so re-visiting one doesn't refetch.
  const [loadedMonths, setLoadedMonths] = useState<Set<string>>(
    () => new Set([`${todayParts.y}-${todayParts.m}`]),
  );

  // Bucket every loaded row by its shop-tz day.
  const byDay = useMemo(() => {
    const map = new Map<string, AgendaRow[]>();
    for (const row of agenda) {
      const key = dayKeyOf(row.start);
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agenda, tz]);

  // ---- Visible month + selected day ----
  const [viewYear, setViewYear] = useState(todayParts.y);
  const [viewMonth, setViewMonth] = useState(todayParts.m); // 1-12
  const [selectedDay, setSelectedDay] = useState<string | null>(todayKey);
  // Month overview vs one-day planner. Day view needs a day, so the switch
  // falls back to today when the month view was sitting collapsed.
  const [view, setView] = useState<CalendarView>("month");
  const shownDay = selectedDay ?? todayKey;

  // Fetch a month's data on demand (paged to a month we haven't loaded yet).
  function ensureMonthLoaded(year: number, month1to12: number) {
    const tag = `${year}-${month1to12}`;
    if (loadedMonths.has(tag)) return;
    const start = new Date(year, month1to12 - 1, 1);
    const end = new Date(year, month1to12, 0);
    const from = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    startMonthLoad(async () => {
      const res = await getAgendaAction(from, to);
      if (!res.ok || !res.data) {
        toast("Couldn't load that month", "error");
        return;
      }
      // Reconcile the fetched window (padding weeks overlap months, so this
      // both de-dupes by id and refreshes rows the previous month already had).
      const win = agendaWindowOf(res.data, from, to);
      setAgenda((prev) => mergeAgendaWindow(prev, res.data!.agenda, win));
      if (res.data.categories) setCategories(res.data.categories);
      setLoadedMonths((prev) => new Set(prev).add(tag));
    });
  }

  // Refetch the visible month and REPLACE loaded rows by id (the merge in
  // ensureMonthLoaded only de-dupes - it would never refresh a stale row).
  // Used by the poll below and fired immediately after a row action.
  // The waitlist board lives in another tab; a window event is the lightest
  // hand-off that keeps ONE booking flow in the app.
  useEffect(() => {
    const onBook = (e: Event) =>
      setWaitlistBooking((e as CustomEvent<WaitlistBookDetail>).detail);
    window.addEventListener(WAITLIST_BOOK_EVENT, onBook);
    return () => window.removeEventListener(WAITLIST_BOOK_EVENT, onBook);
  }, []);

  const refreshAgenda = useCallback(() => {
    // A cancelled or declined booking can free a slot the waitlist wants, so
    // the badge moves with the agenda rather than lagging a poll behind it.
    refreshWaitingCount();
    const start = new Date(viewYear, viewMonth - 1, 1);
    const end = new Date(viewYear, viewMonth, 0);
    const from = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    void getAgendaAction(from, to).then((res) => {
      if (!res.ok || !res.data) return;
      if (res.data.categories) setCategories(res.data.categories);
      const win = agendaWindowOf(res.data, from, to);
      setAgenda((prev) => mergeAgendaWindow(prev, res.data!.agenda, win));
    });
  }, [viewYear, viewMonth, refreshWaitingCount]);

  /**
   * Adopt a server re-render.
   *
   * `agenda` is seeded from `initial.agenda` ONCE, so before this every
   * `router.refresh()` was thrown away: the server recomputed the whole page,
   * handed down fresh rows, and the calendar kept showing the old ones until
   * the 20-second poll happened to fire. That is why a block-off, a new
   * appointment or a cancel looked like it hadn't worked for ~10 seconds on
   * average - the toast said one thing and the calendar said another.
   *
   * Reconciled through the same window merge rather than replacing state
   * outright: `initial` only covers the CURRENT month, and blowing away the
   * other months the barber has paged to would leave them blank forever
   * (`loadedMonths` already counts them as loaded, so nothing would refetch).
   */
  useEffect(() => {
    setAgenda((prev) => mergeAgendaWindow(prev, initial.agenda, agendaWindowOf(initial)));
    if (initial.categories) setCategories(initial.categories);
  }, [initial]);

  // The waitlist board lives on another tab, and this component unmounts while
  // that tab is open - so mounting IS the moment to re-read a count the board
  // may have changed (added, contacted, booked or removed someone).
  useEffect(() => {
    refreshWaitingCount();
  }, [refreshWaitingCount]);

  // Live check-in updates: a light poll while the tab is showing. This is what
  // flips the Booked -> En route -> Arrived pill without a manual refresh when
  // a client taps "On my way".
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshAgenda();
      // Entries expire on a server cron - nothing client-side would ever tell
      // us, so the poll is the only thing that retires a stale badge.
      refreshWaitingCount();
    }, 20_000);
    return () => clearInterval(iv);
  }, [refreshAgenda, refreshWaitingCount]);

  function gotoMonth(delta: number) {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setViewYear(y);
    setViewMonth(m);
    setSelectedDay(null); // collapse the day panel when switching months
    ensureMonthLoaded(y, m);
  }

  /**
   * Move the day view by N days. Paging off the end of a month has to bring
   * `viewYear`/`viewMonth` with it: they're what `refreshAgenda` and the poll
   * fetch, so leaving them behind would show Sep 1 while quietly polling
   * August - and the new day's rows would never arrive.
   */
  function gotoDay(delta: number) {
    gotoDayKey(shiftDayKey(shownDay, delta));
  }

  /** Jump straight to a day (the week strip taps this; gotoDay routes through it). */
  function gotoDayKey(next: string) {
    const [y, m] = next.split("-").map(Number);
    setSelectedDay(next);
    if (y !== viewYear || m !== viewMonth) {
      setViewYear(y!);
      setViewMonth(m!);
      ensureMonthLoaded(y!, m!);
    }
  }

  /** Jump both views back to today (the day view's "you've paged away" escape). */
  function gotoToday() {
    setSelectedDay(todayKey);
    if (todayParts.y !== viewYear || todayParts.m !== viewMonth) {
      setViewYear(todayParts.y);
      setViewMonth(todayParts.m);
      ensureMonthLoaded(todayParts.y, todayParts.m);
    }
  }

  /**
   * Switching views keeps the day you were on. Month -> Day opens the selected
   * day (or today); Day -> Month pages the grid to that day's month so the cell
   * you were just looking at is on screen and selected, rather than dumping you
   * back on whatever month you started from.
   */
  function switchView(next: CalendarView) {
    setView(next);
    if (next === "day") {
      setSelectedDay(shownDay);
      const [y, m] = shownDay.split("-").map(Number);
      if (y !== viewYear || m !== viewMonth) {
        setViewYear(y!);
        setViewMonth(m!);
        ensureMonthLoaded(y!, m!);
      }
    }
  }

  // ---- Build the month grid (weeks of 7, Sun-first, incl. leading/trailing) --
  const weeks = useMemo(
    () => buildMonthGrid(viewYear, viewMonth),
    [viewYear, viewMonth],
  );

  // A representative title-date for the month header (noon avoids DST edges).
  const monthTitle = monthTitleFmt.format(new Date(viewYear, viewMonth - 1, 15, 12));

  const selectedRows = selectedDay ? byDay.get(selectedDay) ?? [] : [];
  const isDayView = view === "day";
  // The day view's own rows/title, independent of whether a month cell is
  // selected - `shownDay` always names a day.
  const shownDayRows = byDay.get(shownDay) ?? [];
  const dayTitle = labelFromKey(shownDay, dayTitleFmt);
  // Same computation the footer inside DayPlanner uses, so the pinned headline
  // and the detail below it can never quote different numbers for one day.
  const shownDayTotals = useMemo(() => dayTotals(shownDayRows), [shownDayRows]);

  /**
   * The Sun-Sat week `shownDay` sits in, each day with its booking count.
   *
   * Counted the same way the day gauge counts (`countByCategory`): blocked time
   * isn't a booking and a cancellation isn't one either, so neither inflates the
   * number the barber is reading to decide where the room is.
   *
   * Every day in this strip is guaranteed to have its rows loaded: each month
   * fetch pads by ±7 days, and a week never reaches further than 6 days from
   * the day it contains — so an end-of-month week can't show a phantom 0.
   */
  const weekDays = useMemo(() => {
    const sunday = shiftDayKey(shownDay, -weekdayOfKey(shownDay));
    return Array.from({ length: 7 }, (_, i) => {
      const key = shiftDayKey(sunday, i);
      const rows = byDay.get(key) ?? [];
      let count = 0;
      for (const r of rows) {
        if (r.source === "block" || r.status === "canceled") continue;
        count++;
      }
      return { key, count, day: Number(key.slice(8)) };
    });
  }, [shownDay, byDay]);

  // Swipe between days. `touchAction: pan-y` on the container tells the browser
  // we handle horizontal ourselves, which stops the day flipping AND the page
  // scrolling on one diagonal drag.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const daySwipeHandlers = {
    onTouchStart: (e: ReactTouchEvent<HTMLDivElement>) => {
      const t = e.touches[0];
      swipeStart.current =
        e.touches.length === 1 && t && swipeAllowedFrom(e.target)
          ? { x: t.clientX, y: t.clientY }
          : null;
    },
    onTouchEnd: (e: ReactTouchEvent<HTMLDivElement>) => {
      const start = swipeStart.current;
      swipeStart.current = null;
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const intent = swipeIntent(t.clientX - start.x, t.clientY - start.y);
      if (intent) gotoDay(intent === "prev" ? -1 : 1);
    },
  };

  const navBtn =
    "rounded-lg border border-subtle px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-offwhite";

  return (
    <div className="flex flex-col gap-4">
      {/* Waitlist dropdown sits ABOVE the calendar. */}
      <WaitlistPanel initial={initialWaitlist} onOpenTab={onOpenWaitlist} />

      <Card className="p-4 sm:p-5">
      {/* View switch. Above the pager because it changes what the pager PAGES
          (months vs days) - reading it after the arrows would be backwards. */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <Segmented
          options={VIEWS}
          value={view}
          onChange={switchView}
          ariaLabel="Calendar view"
        />
        {/* Only offered once it does something - on today it's a no-op button. */}
        {shownDay !== todayKey && (
          <button
            type="button"
            onClick={gotoToday}
            className="rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors duration-150 ease-out hover:border-gold/50 hover:text-gold"
          >
            Today
          </button>
        )}
      </div>

      {/* Pager: months in month view, days in day view. */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => (isDayView ? gotoDay(-1) : gotoMonth(-1))}
          aria-label={isDayView ? "Previous day" : "Previous month"}
          className={navBtn}
        >
          ‹
        </button>
        <h2 className="min-w-0 truncate text-center font-display text-lg">
          {isDayView ? dayTitle : monthTitle}
          {pendingMonth && <span className="ml-2 text-xs text-muted">loading…</span>}
        </h2>
        <button
          type="button"
          onClick={() => (isDayView ? gotoDay(1) : gotoMonth(1))}
          aria-label={isDayView ? "Next day" : "Next month"}
          className={navBtn}
        >
          ›
        </button>
      </div>

      {isDayView ? (
        /* DAY VIEW: the planner gets the whole card. Keyed on the day so it
           remounts as you page - which is what resets DayPlanner's category
           filter, exactly as tapping a different month cell does. */
        <div className="mt-4" style={{ touchAction: "pan-y" }} {...daySwipeHandlers}>
          <DayHeader
            days={weekDays}
            shownDay={shownDay}
            todayKey={todayKey}
            onPick={gotoDayKey}
            totals={shownDayTotals}
          />
          <DayPlanner
            key={shownDay}
            standalone
            rows={shownDayRows}
            categories={categories}
            title={dayTitle}
            hourOf={(iso) => shopParts(iso).h}
            minuteOf={(iso) => {
              const p = shopParts(iso);
              return p.h * 60 + p.min;
            }}
            timeFmt={timeFmt}
            toast={toast}
            isNative={isNative}
            staff={staff}
            onAddAt={(hour) => setAddAt(isoForDayHour(shownDay, hour, tz))}
            onBlock={() => setBlockDay({ dayKey: shownDay, hour: 12 })}
            onChanged={refreshAgenda}
            waitingCount={waitingCount}
            onOpenWaitlist={onOpenWaitlist}
          />
        </div>
      ) : (
      <>
      {/* Weekday header */}
      <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted">
        {WEEKDAY_LABELS.map((w, i) => (
          <div key={i} className="py-1">
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="mt-1 grid grid-cols-7 gap-1">
        {weeks.flat().map((cell) => {
          if (!cell) return <div key={Math.random()} />;
          const { key, dayNum, inMonth } = cell;
          const rows = byDay.get(key) ?? [];
          const active = rows.filter(
            (r) => r.source !== "block" && r.status !== "canceled",
          ).length;
          const isToday = key === todayKey;
          const isSelected = key === selectedDay;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedDay(isSelected ? null : key)}
              className={cn(
                "relative flex aspect-square flex-col items-center justify-center rounded-lg text-sm transition-colors",
                inMonth ? "text-offwhite" : "text-muted/40",
                isSelected
                  ? "bg-gold/20 ring-1 ring-gold/50"
                  : isToday
                    ? "bg-charcoal-700"
                    : "hover:bg-charcoal-700/60",
              )}
            >
              <span className={cn(isToday && !isSelected && "font-semibold text-gold")}>
                {dayNum}
              </span>
              {active > 0 && (
                <span
                  className={cn(
                    "mt-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none",
                    isSelected ? "bg-gold text-charcoal-900" : "bg-gold/20 text-gold",
                  )}
                >
                  {active}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Expanded day planner */}
      <AnimatePresence initial={false}>
        {selectedDay && (
          <motion.div
            key={selectedDay}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <DayPlanner
              rows={selectedRows}
              categories={categories}
              title={
                selectedRows[0]
                  ? dayTitleFmt.format(new Date(selectedRows[0].start))
                  : selectedDay === todayKey
                    ? dayTitleFmt.format(new Date())
                    : labelFromKey(selectedDay, dayTitleFmt)
              }
              hourOf={(iso) => shopParts(iso).h}
              minuteOf={(iso) => {
                const p = shopParts(iso);
                return p.h * 60 + p.min;
              }}
              timeFmt={timeFmt}
              toast={toast}
              isNative={isNative}
              staff={staff}
              onAddAt={(hour) => setAddAt(isoForDayHour(selectedDay, hour, tz))}
              onBlock={() => setBlockDay({ dayKey: selectedDay, hour: 12 })}
              onChanged={refreshAgenda}
            waitingCount={waitingCount}
            onOpenWaitlist={onOpenWaitlist}
            />
          </motion.div>
        )}
      </AnimatePresence>
      </>
      )}
      </Card>

      {/* New Appointment / Block Off sheets (native only). */}
      {isNative && addAt && (
        <AppointmentForm
          staff={staff}
          services={services}
          timezone={tz}
          prefillISO={addAt}
          onClose={() => setAddAt(null)}
          onCreated={() => {
            setAddAt(null);
            // Both, and both earn their place: `refreshAgenda` is one request
            // and puts the new row on the calendar immediately, while
            // `router.refresh()` re-reads the siblings this write also touches
            // (the waitlist board, the day's server-rendered summary). The
            // effect above is what finally lets the second one land at all.
            refreshAgenda();
            router.refresh();
          }}
          toast={toast}
        />
      )}
      {isNative && waitlistBooking && (
        <AppointmentForm
          staff={staff}
          services={services}
          timezone={tz}
          prefillISO={new Date().toISOString()}
          waitlist={{
            entryId: waitlistBooking.entryId,
            name: `${waitlistBooking.firstName} ${waitlistBooking.lastName ?? ""}`.trim(),
            phone: waitlistBooking.phone,
            email: waitlistBooking.email,
            serviceId: waitlistBooking.serviceId,
            staffId: waitlistBooking.staffId,
            windowHint: waitlistBooking.windowHint,
          }}
          onClose={() => setWaitlistBooking(null)}
          onCreated={() => {
            setWaitlistBooking(null);
            refreshAgenda();
            router.refresh();
          }}
          toast={toast}
        />
      )}
      {isNative && blockDay && (
        <BlockOffForm
          staff={staff}
          dayKey={blockDay.dayKey}
          timezone={tz}
          defaultFromHour={blockDay.hour}
          onClose={() => setBlockDay(null)}
          onCreated={() => {
            setBlockDay(null);
            refreshAgenda();
            router.refresh();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

/**
 * Build an ISO instant for a (YYYY-MM-DD day, hour) as a prefill. Converts in
 * the SHOP's tz (the zone the day grid is rendered in), so the anchor stays on
 * the tapped day/hour even when the device is in another zone. The appointment
 * form then fetches the REAL open slots for that day - this is only an anchor.
 */
function isoForDayHour(dayKey: string, hour: number, tz: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return zonedWallTimeToUtc(y!, m! - 1, d!, hour * 60, tz).toISOString();
}

/**
 * Collapsible "Waitlist (N)" panel above the calendar. Collapsed by default;
 * shows the count as a badge. Each row: who + what they want + how to reach them,
 * with status actions (Contacted / Booked / Remove). REMOVED/BOOKED entries are
 * hidden from the default view (they've been handled).
 */
function WaitlistPanel({
  initial,
  onOpenTab,
}: {
  initial: WaitlistRow[];
  onOpenTab: () => void;
}) {
  const waitingCount = initial.filter((w) => w.status === "WAITING").length;
  const contactedCount = initial.filter((w) => w.status === "CONTACTED").length;

  // Nothing to show and none ever added: hide the panel entirely to avoid clutter.
  if (initial.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onOpenTab}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-charcoal-700/40"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-display text-base">Waitlist</span>
          {waitingCount > 0 && (
            <span className="rounded-full bg-gold/15 px-2 py-0.5 text-xs font-semibold text-gold">
              {waitingCount} waiting
            </span>
          )}
          {contactedCount > 0 && (
            <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-xs font-medium text-sky-300">
              {contactedCount} contacted
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs font-medium text-muted">Open →</span>
      </button>
    </Card>
  );
}

/**
 * The week the shown day belongs to, pinned above the planner.
 *
 * Paging a day at a time through ‹ › told the barber nothing about the days
 * either side, so "where's my room this week?" meant seven taps or a trip back
 * to the month grid. The strip answers it in place: the count under each date
 * is that day's bookings, so a light day is visible without leaving the one
 * you're on.
 *
 * Rendered inside the pinned day header (see DayHeader), so it stays reachable
 * from the bottom of a long day.
 */
function WeekStrip({
  days,
  shownDay,
  todayKey,
  onPick,
}: {
  days: { key: string; count: number; day: number }[];
  shownDay: string;
  todayKey: string;
  onPick: (key: string) => void;
}) {
  return (
      <div className="grid grid-cols-7 gap-1">
        {days.map((d, i) => {
          const selected = d.key === shownDay;
          const isToday = d.key === todayKey;
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => onPick(d.key)}
              aria-current={selected ? "date" : undefined}
              // The visible content is three terse glyphs; the full sentence
              // lives here so it isn't "S 14 3" to a screen reader.
              aria-label={`${labelFromKey(d.key, WEEKDAY_FULL_FMT)}${
                isToday ? " (today)" : ""
              } — ${d.count === 0 ? "nothing booked" : `${d.count} booked`}`}
              className={cn(
                // min-h keeps the 44px touch target the rest of the app uses;
                // min-w-0 keeps a 7-col grid from being widened by its content
                // at 320px (a grid item's default min-width is auto).
                "flex min-h-[2.75rem] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1 transition-colors duration-150 ease-out",
                selected
                  ? "bg-gold text-charcoal-900"
                  : "text-muted hover:bg-charcoal-700 hover:text-offwhite",
              )}
            >
              <span className="text-[10px] font-medium leading-none">
                {WEEKDAY_LABELS[i]}
              </span>
              <span
                className={cn(
                  "text-sm font-semibold leading-none tabular-nums",
                  selected ? "" : isToday ? "text-gold" : "text-offwhite",
                )}
              >
                {d.day}
              </span>
              {/* A dot rather than "0": an empty day should read as empty at a
                  glance, not as a number to compare against the others. */}
              <span
                className={cn(
                  "text-[10px] leading-none tabular-nums",
                  selected ? "text-charcoal-900/70" : "text-muted",
                )}
              >
                {d.count === 0 ? "·" : d.count}
              </span>
            </button>
          );
        })}
      </div>
  );
}

/**
 * The pinned head of the day view: the week, then the day's money.
 *
 * ONE sticky container rather than two stacked ones - the week strip and the
 * total have to stay glued together, and stacking two `sticky` elements means
 * hand-maintaining a pixel offset that silently breaks the moment either one
 * changes height.
 *
 * Sits below the dashboard header (which is `sticky top-0 z-20`) at a lower z,
 * so it slides under rather than over it.
 *
 * The total here is deliberately the headline only. The full breakdown - done
 * vs to come, unpriced, awaiting approval, no-shows, and the to-fill chips -
 * stays in the footer at the bottom of the day, because pinning all of it would
 * cost about a third of a phone screen before any appointment was visible. Both
 * read from the same `dayTotals`, so they can never disagree.
 */
function DayHeader({
  days,
  shownDay,
  todayKey,
  onPick,
  totals,
}: {
  days: { key: string; count: number; day: number }[];
  shownDay: string;
  todayKey: string;
  onPick: (key: string) => void;
  totals: DayTotals;
}) {
  const showTotal =
    totals.count > 0 || totals.revenue > 0 || totals.blockedMin > 0;
  return (
    <div className="sticky top-16 z-10 -mx-1 mb-3 rounded-xl bg-charcoal-800/80 px-1 py-1.5 backdrop-blur">
      <WeekStrip days={days} shownDay={shownDay} todayKey={todayKey} onPick={onPick} />
      {showTotal && (
        <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-subtle/60 px-1.5 pt-1.5">
          <p className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
              On the books
            </span>
            <span className="truncate font-display text-base tabular-nums text-gold">
              ${Math.round(totals.revenue).toLocaleString()}
            </span>
          </p>
          <p className="shrink-0 text-[11px] tabular-nums text-muted">
            {totals.count} {totals.count === 1 ? "appointment" : "appointments"}
            {totals.blockedMin > 0 && ` · ${fmtDuration(totals.blockedMin)} off`}
          </p>
        </div>
      )}
    </div>
  );
}

function countByCategory(rows: AgendaRow[]): { all: number; byId: Map<string, number> } {
  const byId = new Map<string, number>();
  let all = 0;
  for (const r of rows) {
    if (r.source === "block" || r.status === "canceled") continue;
    all++;
    if (r.categoryId) byId.set(r.categoryId, (byId.get(r.categoryId) ?? 0) + 1);
  }
  return { all, byId };
}

/**
 * The "All" denominator: the sum of every bucket's target - but ONLY when that
 * sum actually describes the whole day. It's withheld when any bucket has no
 * target, or when some booking sits outside every bucket, because in either
 * case the numerator counts things the denominator doesn't cover and "14/16"
 * would be a quietly wrong number. Returning null just falls back to a plain
 * count, which is honest.
 */
function sumTargets(
  categories: AgendaCategory[],
  counts: { all: number; byId: Map<string, number> },
): number | null {
  if (categories.length === 0) return null;
  let total = 0;
  let bucketed = 0;
  for (const c of categories) {
    if (c.target === null) return null;
    total += c.target;
    bucketed += counts.byId.get(c.id) ?? 0;
  }
  return bucketed === counts.all ? total : null;
}

/**
 * The headline "12 / 16" (or a plain count when the bucket has no target).
 * Hitting the target is the good outcome, so full reads GOLD, not red - and
 * going past it is allowed by design (nothing enforces a target), so an
 * over-target day reads 17/16 rather than clamping or alarming.
 */
function DayGauge({ count, target }: { count: number; target: number | null }) {
  if (target === null) {
    return (
      <span className="shrink-0 text-xs text-muted">
        {count} {count === 1 ? "appointment" : "appointments"}
      </span>
    );
  }
  const full = count >= target;
  return (
    <span
      className="shrink-0 text-xs text-muted"
      // One label for the pair - a screen reader hearing "12 16" learns nothing.
      aria-label={`${count} of ${target} slots booked`}
    >
      <span className={cn("text-sm font-semibold", full ? "text-gold" : "text-offwhite")}>
        {count}
      </span>
      <span aria-hidden="true"> / {target} slots</span>
    </span>
  );
}

/** One filter chip, carrying its own bucket's count so the row reads at a glance. */
function CategoryChip({
  label,
  count,
  target,
  active,
  onClick,
}: {
  label: string;
  count: number;
  target: number | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors",
        active
          ? "border-gold/50 bg-gold/15 text-gold"
          : "border-subtle text-muted hover:border-gold/40 hover:text-offwhite",
      )}
    >
      {label}{" "}
      <span className={cn("tabular-nums", !active && "text-offwhite")}>
        {count}
        {target !== null && `/${target}`}
      </span>
    </button>
  );
}

// How long a block runs comes from the shared formatter (lib/duration.ts), so
// an all-day block reads "1d" instead of "24h".

// Soft diagonal hatching for blocked-off time - the one texture in the app, so
// blocked bands read as "not sellable" at a glance without shouting. Must stay
// a literal for the Tailwind JIT to pick it up.
const BLOCK_STRIPES =
  "bg-[repeating-linear-gradient(-45deg,transparent,transparent_6px,rgba(255,255,255,0.04)_6px,rgba(255,255,255,0.04)_12px)]";

/**
 * "Walk-in" — one tap, type what they paid, done.
 *
 * Deliberately an INLINE STRIP, not a sheet: the whole feature exists because
 * booking a walk-in properly (invent a name, a phone, pick a service) cost more
 * than it was worth, so the shop just... didn't. A modal would spend the saving
 * it's meant to create. Collapsed it is one button; expanded it is one number
 * field and Save, with Enter submitting and Esc backing out.
 *
 * The barber picker only appears when the shop has more than one active barber
 * AND the API says it can't tell whose chair it was - a solo shop and a
 * signed-in barber both resolve server-side and never see it.
 */
function WalkInBar({
  staff,
  toast,
  onRecorded,
}: {
  staff: StaffRow[];
  toast: Toast;
  onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  // Set only once the server says it genuinely can't resolve the chair.
  const [needStaff, setNeedStaff] = useState(false);
  const [staffId, setStaffId] = useState("");
  const [pending, start] = useTransition();
  const active = staff.filter((s) => s.active);

  function reset() {
    setOpen(false);
    setAmount("");
    setNeedStaff(false);
    setStaffId("");
  }

  function submit() {
    const value = Number(amount);
    // Empty is not zero: "$0" is a real answer a barber may mean, but a blank
    // box is someone who hasn't typed yet.
    if (amount.trim() === "" || !Number.isFinite(value) || value < 0) {
      toast("Enter what they paid", "error");
      return;
    }
    if (needStaff && !staffId) {
      toast("Pick whose chair", "error");
      return;
    }
    start(async () => {
      const res = await recordWalkInAction({
        amount: value,
        ...(staffId ? { staffId } : {}),
      });
      if (res.ok) {
        toast("Walk-in recorded", "success");
        reset();
        onRecorded();
        return;
      }
      if (res.error === "staff_required") {
        // Ask once, keep the amount they already typed.
        setNeedStaff(true);
        toast("Whose chair was it?", "error");
        return;
      }
      toast("Couldn't record that walk-in", "error");
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(ROW_BTN, "border border-subtle text-muted hover:border-gold/50 hover:text-gold")}
      >
        Walk-in
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gold/40 bg-gold/5 px-2 py-1.5">
      <span className="text-xs font-medium text-gold">Walk-in</span>
      <label className="flex items-center gap-1 text-xs text-muted">
        <span aria-hidden="true">$</span>
        <span className="sr-only">Amount the walk-in paid</span>
        <input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              reset();
            }
          }}
          className="w-20 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite"
        />
      </label>
      {needStaff && (
        <select
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          aria-label="Whose chair"
          className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite"
        >
          <option value="">Whose chair…</option>
          {active.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="rounded-lg bg-gold/20 px-3 py-1 text-xs font-semibold text-gold transition-colors hover:bg-gold/30 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={reset}
        className="rounded px-1.5 py-1 text-xs text-muted transition-colors hover:text-offwhite"
      >
        Cancel
      </button>
    </div>
  );
}

/** A single day expanded into an every-hour planner. */
function DayPlanner({
  rows,
  categories,
  title,
  hourOf,
  minuteOf,
  timeFmt,
  toast,
  isNative,
  staff,
  onAddAt,
  onBlock,
  onChanged,
  waitingCount,
  onOpenWaitlist,
  standalone = false,
}: {
  rows: AgendaRow[];
  /** Gauge buckets (groups + ungrouped services) with their display-only targets. */
  categories: AgendaCategory[];
  title: string;
  hourOf: (iso: string) => number;
  /** Minutes into the shop-local day, for block-coverage math. */
  minuteOf: (iso: string) => number;
  timeFmt: Intl.DateTimeFormat;
  toast: Toast;
  isNative: boolean;
  /** Active barbers - the walk-in bar asks whose chair when there's a choice. */
  staff: StaffRow[];
  onAddAt: (hour: number) => void;
  onBlock: () => void;
  /** Refetch the agenda so a row mutation shows without waiting for the poll. */
  onChanged: () => void;
  /** How many people are WAITING right now - the shortcut's badge. */
  waitingCount: number;
  /** Switch to the Waitlist tab (its board already opens on Waiting). */
  onOpenWaitlist: () => void;
  /** DAY view: the planner owns the card, so it drops the repeated date
   *  heading and the divider that separated it from the month grid. */
  standalone?: boolean;
}) {
  // ---- Day gauge: how full is this day, and in what? ----
  // null = "All". Reset per day: `key={selectedDay}` on the wrapper remounts
  // this component when the barber taps a different day, so a filter never
  // silently carries over to a day where that category has nothing.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const counts = countByCategory(rows);
  // Only chip what's worth chipping: a bucket the barber set a target on (they
  // want to watch it) or one with bookings today (it's on the day). A shop with
  // no targets and one category gets no chip row at all - just the plain count.
  const chipCategories = categories.filter(
    (c) => c.target !== null || (counts.byId.get(c.id) ?? 0) > 0,
  );
  const showChips = chipCategories.length > 1;
  const selected = chipCategories.find((c) => c.id === categoryFilter) ?? null;
  // A filter the day can no longer satisfy (target cleared elsewhere) falls back
  // to All rather than showing an empty planner with no way back.
  const activeFilter = selected?.id ?? null;
  const shownRows = activeFilter
    ? rows.filter((r) => r.categoryId === activeFilter || r.source === "block")
    : rows;
  // Blocked time always shows (it's context for the day, not a booking), so the
  // headline count comes from the bucket, never from shownRows.
  const shownCount = selected ? (counts.byId.get(selected.id) ?? 0) : counts.all;
  const shownTarget = selected ? selected.target : sumTargets(chipCategories, counts);

  // Group appointments into their start hour, then render every hour in the
  // day's working window (default 8a-11p, widened to fit any early/late booking).
  const byHour = new Map<number, AgendaRow[]>();
  for (const r of shownRows) {
    const h = hourOf(r.start);
    byHour.set(h, [...(byHour.get(h) ?? []), r]);
  }
  const bookedHours = [...byHour.keys()];
  // We show each appointment on its START hour, and hours are 0-23, so the window
  // never needs to exceed 23 (an 11 PM cut just needs the 11 PM row to exist -
  // no +1, which would spill into a bogus hour 24 labelled "12 PM").
  const startHour = Math.min(DEFAULT_START_HOUR, ...bookedHours);
  const endHour = Math.min(23, Math.max(DEFAULT_END_HOUR, ...bookedHours));
  const hours: number[] = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);

  // Blocked intervals in shop-local minutes, so a 12-3 PM block can mark the
  // 1 PM and 2 PM rows as blocked instead of leaving them inviting "+ Add
  // appointment" inside time the barber explicitly took off. A block only
  // renders its card on its START hour; the covered hours get a slim
  // continuation strip via blockCovering().
  const blockIntervals = rows
    .filter((r) => r.source === "block" && r.end && r.end > r.start)
    .map((r) => ({ startMin: minuteOf(r.start), endMin: minuteOf(r.end!), endIso: r.end! }));
  const blockCovering = (h: number) =>
    blockIntervals.find((iv) => iv.startMin <= h * 60 && iv.endMin >= (h + 1) * 60) ?? null;

  // Collapse each RUN of covered, empty hours into one band. Printing the strip
  // per hour meant a day off rendered as fifteen identical "blocked until 11:00
  // PM" lines marching down the grid - the block card directly above them
  // already gives the range and the duration, so every repeat was noise you had
  // to scroll past to reach the next bookable hour. One band per run says the
  // same thing: this stretch is spoken for, here's when it lets up. Hours that
  // hold an appointment are never folded in - a booking made before the block
  // still has to be visible.
  type HourRow =
    | { kind: "hour"; hour: number }
    | { kind: "blocked"; hour: number; endIso: string };
  const hourRows: HourRow[] = [];
  for (const h of hours) {
    const covering = (byHour.get(h) ?? []).length === 0 ? blockCovering(h) : null;
    if (!covering) {
      hourRows.push({ kind: "hour", hour: h });
      continue;
    }
    // Same run only while it's the same block; back-to-back blocks with
    // different end times stay separate bands.
    const prev = hourRows[hourRows.length - 1];
    if (prev?.kind === "blocked" && prev.endIso === covering.endIso) continue;
    hourRows.push({ kind: "blocked", hour: h, endIso: covering.endIso });
  }

  // ---- Day summary (the totals footer) ----
  // Shared with the pinned header above the planner (see DayHeader): two copies
  // of this arithmetic would eventually disagree, and a calendar quoting two
  // different totals for one day is worse than either being wrong.
  const {
    revenue: dayRevenue,
    doneRevenue,
    toComeRevenue,
    pendingRevenue,
    unpricedCount,
    noShowCount,
    blockedMin,
  } = dayTotals(rows);
  // "N to fill" per bucket, from the same display-only targets the gauge uses.
  const fillables = categories
    .filter((c) => c.target !== null)
    .map((c) => ({
      id: c.id,
      name: c.name,
      left: Math.max(0, c.target! - (counts.byId.get(c.id) ?? 0)),
    }));
  const allFull = fillables.length > 0 && fillables.every((f) => f.left === 0);
  const showSummary = counts.all > 0 || fillables.length > 0 || blockedMin > 0;

  return (
    <div className={standalone ? "" : "mt-4 border-t border-subtle pt-4"}>
      {/* In DAY view the pager heading above already IS this date, and the
          planner owns the whole card - so no repeated title, and no divider
          separating it from a grid that isn't there. */}
      <div
        className={cn(
          "mb-3 flex items-baseline gap-3",
          standalone ? "justify-end" : "justify-between",
        )}
      >
        {!standalone && <h3 className="font-display text-base">{title}</h3>}
        <DayGauge count={shownCount} target={shownTarget} />
      </div>

      {/* Category filter: retunes the gauge AND the planner below, so "just
          retwists" shows him the retwist bookings, not only their count. */}
      {showChips && (
        <div
          // Opt this strip out of the day swipe: it scrolls horizontally
          // itself, so a sideways drag here already means something.
          data-noswipe
          className="mb-3 flex gap-1.5 overflow-x-auto pb-1"
          role="group"
          aria-label="Filter this day by service"
        >
          <CategoryChip
            label="All"
            count={counts.all}
            target={sumTargets(chipCategories, counts)}
            active={activeFilter === null}
            onClick={() => setCategoryFilter(null)}
          />
          {chipCategories.map((c) => (
            <CategoryChip
              key={c.id}
              label={c.name}
              count={counts.byId.get(c.id) ?? 0}
              target={c.target}
              active={activeFilter === c.id}
              onClick={() =>
                setCategoryFilter((cur) => (cur === c.id ? null : c.id))
              }
            />
          ))}
        </div>
      )}

      {/* Barber actions (native booking only). */}
      {isNative && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onAddAt(DEFAULT_START_HOUR)}
            className={cn(ROW_BTN, "bg-gold/15 text-gold hover:bg-gold/25")}
          >
            + New appointment
          </button>
          <WalkInBar staff={staff} toast={toast} onRecorded={onChanged} />
          <button
            type="button"
            onClick={onBlock}
            className={cn(
              ROW_BTN,
              "border border-subtle text-muted hover:text-offwhite",
            )}
          >
            Block off time
          </button>
          <WaitlistShortcut count={waitingCount} onOpen={onOpenWaitlist} />
        </div>
      )}

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex flex-col"
      >
        {hourRows.map((item) => {
          // An hour sitting fully inside a block is NOT open - don't invite a
          // booking into it. One slim band covers the whole covered run.
          if (item.kind === "blocked") {
            return (
              <motion.div
                key={`blocked-${item.hour}`}
                variants={fadeUp}
                className="flex gap-3 border-b border-subtle/60 py-2 last:border-b-0"
              >
                <div className="w-14 shrink-0 pt-0.5 text-right text-[11px] font-medium text-muted">
                  {formatHour(item.hour)}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "flex items-center gap-2 rounded-md border-l-2 border-charcoal-600 py-1 pl-2 text-[11px] text-muted/50",
                      BLOCK_STRIPES,
                    )}
                  >
                    blocked until {timeFmt.format(new Date(item.endIso))}
                  </div>
                </div>
              </motion.div>
            );
          }
          const h = item.hour;
          const slot = (byHour.get(h) ?? []).sort((a, b) => a.start.localeCompare(b.start));
          return (
            <motion.div
              key={h}
              variants={fadeUp}
              className="flex gap-3 border-b border-subtle/60 py-2 last:border-b-0"
            >
              <div className="w-14 shrink-0 pt-0.5 text-right text-[11px] font-medium text-muted">
                {formatHour(h)}
              </div>
              <div className="min-w-0 flex-1">
                {slot.length === 0 ? (
                  isNative ? (
                    // A "+" bubble to add an appointment at this open hour.
                    <button
                      type="button"
                      onClick={() => onAddAt(h)}
                      className="group flex w-full items-center gap-2 py-1 text-xs text-muted/40 transition-colors hover:text-gold"
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-subtle text-muted transition-colors group-hover:border-gold/50 group-hover:text-gold">
                        +
                      </span>
                      <span className="opacity-0 transition-opacity group-hover:opacity-100">
                        Add appointment
                      </span>
                    </button>
                  ) : (
                    <div className="py-1 text-xs text-muted/40">— open —</div>
                  )
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {slot.map((r) => (
                      <AppointmentBlock
                        key={r.id}
                        row={r}
                        // Show the time RANGE so the barber sees how long each
                        // cut runs. Guard the cases that specifically hit synced/
                        // manual visits: no end, or a zero-length end (== start) -
                        // both fall back to just the start time (no bogus "2–2").
                        timeLabel={
                          r.end && r.end !== r.start
                            ? `${timeFmt.format(new Date(r.start))}–${timeFmt.format(new Date(r.end))}`
                            : timeFmt.format(new Date(r.start))
                        }
                        toast={toast}
                        onChanged={onChanged}
                      />
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </motion.div>

      {/* ---- Day totals: what the day is worth, and what's left to fill ---- */}
      {showSummary && (
        <div className="mt-4 overflow-hidden rounded-xl border border-gold/25 bg-gradient-to-br from-gold/10 via-charcoal-800/60 to-charcoal-800/30">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-4 pb-2 pt-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted">
                On the books
              </p>
              <p className="font-display text-2xl tabular-nums text-gold">
                ${Math.round(dayRevenue).toLocaleString()}
              </p>
              <p className="mt-0.5 text-[11px] tabular-nums text-muted">
                {doneRevenue > 0 || toComeRevenue > 0 ? (
                  <>
                    <span className="text-emerald-soft">
                      ${Math.round(doneRevenue).toLocaleString()} done
                    </span>
                    {" · "}${Math.round(toComeRevenue).toLocaleString()} to come
                  </>
                ) : (
                  "nothing booked yet"
                )}
                {unpricedCount > 0 &&
                  ` · ${unpricedCount} unpriced`}
                {pendingRevenue > 0 &&
                  ` · +$${Math.round(pendingRevenue).toLocaleString()} awaiting approval`}
              </p>
            </div>
            <div className="text-right text-[11px] text-muted">
              <p className="text-sm text-offwhite">
                <span className="font-semibold tabular-nums">{counts.all}</span>{" "}
                {counts.all === 1 ? "appointment" : "appointments"}
              </p>
              {noShowCount > 0 && (
                <p className="text-danger-soft">
                  {noShowCount} no-show{noShowCount === 1 ? "" : "s"} — earned $0
                </p>
              )}
              {blockedMin > 0 && <p>{fmtDuration(blockedMin)} blocked off</p>}
            </div>
          </div>
          {fillables.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-gold/15 px-4 py-2.5">
              <span className="mr-1 text-[10px] uppercase tracking-wide text-muted">
                To fill
              </span>
              {allFull ? (
                <span className="rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-soft">
                  Every target hit — the day is full ✦
                </span>
              ) : (
                fillables.map((f) =>
                  f.left === 0 ? (
                    <span
                      key={f.id}
                      className="rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-2.5 py-0.5 text-[11px] tabular-nums text-emerald-soft"
                    >
                      {f.name} full ✓
                    </span>
                  ) : (
                    <span
                      key={f.id}
                      className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-[11px] tabular-nums text-gold"
                    >
                      {f.name} · {f.left} to fill
                    </span>
                  ),
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Preset "come early" nudge messages (the pilot barber's own words). Custom
// text is capped at 140 chars to match the server's zod limit.
const NUDGE_PRESETS = [
  "I'm running 15 min ahead — come early if you can",
  "Running about 20 min behind, no rush",
  "Chair's open, pull up whenever",
];
const NUDGE_MAX_LEN = 140;

/** Pencil. Inherits currentColor so it matches whatever button hosts it. */
/**
 * Shared sizing for the barber action row.
 *
 * 44px on phones is the touch-target floor the rest of the app already keeps;
 * these four controls sit in one row and read as one group, so they take it
 * together - a lone 44px control beside three 28px ones looks like a mistake.
 * The floor holds through TABLET too - 768px is a touch device, so relaxing at
 * `sm` would drop the target exactly where fingers still use it. Only real
 * pointer widths (`lg` and up) step down to the dashboard's usual 36px.
 */
const ROW_BTN =
  "inline-flex h-11 items-center justify-center rounded-lg px-3 text-xs " +
  "font-medium transition-colors lg:h-9";

/**
 * WAITLIST SHORTCUT.
 *
 * A barber looking at a thin day wants the waitlist NOW - it was two taps away
 * behind a tab, and the panel that advertised it is hidden entirely when the
 * list is empty. This puts it in the action row where the day is being worked.
 *
 * The badge counts WAITING only. CONTACTED people have already been reached,
 * and BOOKED/REMOVED/EXPIRED are done - counting any of them would send the
 * barber to a board with fewer people on it than the badge promised.
 */
function WaitlistShortcut({ count, onOpen }: { count: number; onOpen: () => void }) {
  // Past 99 the exact number stops being actionable and starts breaking the
  // row's width at 320px, so it caps.
  const shown = count > 99 ? "99+" : String(count);
  // Em dash, like every other user-facing string in the app (code comments
  // keep ASCII). Reads as one sentence to a screen reader.
  const label =
    count === 0
      ? "Open waitlist — nobody waiting."
      : `Open waitlist — ${count} waiting.`;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className={cn(
        ROW_BTN,
        "group relative w-11 shrink-0 gap-1.5 border px-0 lg:w-auto lg:px-3",
        count > 0
          ? "border-gold/40 bg-gold/10 text-gold hover:bg-gold/20"
          : "border-subtle text-muted hover:border-gold/50 hover:text-gold",
      )}
    >
      <ClockIcon />
      {/* Phones show the count as a corner badge over a square icon button;
          from `sm` up the row has room to spell it out inline. */}
      {count > 0 && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 min-w-[1.15rem] rounded-full bg-gold px-1 text-[10px] font-bold leading-[1.15rem] text-charcoal-900 lg:hidden"
        >
          {shown}
        </span>
      )}
      <span aria-hidden className="hidden lg:inline">
        Waitlist{count > 0 ? ` · ${shown}` : ""}
      </span>
    </button>
  );
}

/** Clock face - "people waiting on time to open up". */
function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor"
         strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

// Shared card language (name wrapping + initials) - see appointmentCardStyles.
// The card is PRESENTATION-only work: statuses, permissions and every action
// handler below are exactly as they were.
function AppointmentBlock({
  row,
  timeLabel,
  toast,
  onChanged,
}: {
  row: AgendaRow;
  timeLabel: string;
  toast: Toast;
  onChanged: () => void;
}) {
  const [pending, start] = useTransition();
  const [seriesMenu, setSeriesMenu] = useState(false);
  const [nudgeMenu, setNudgeMenu] = useState(false);
  // ONE sheet for this row. The value is which view it opens on; null = closed.
  const [sheet, setSheet] = useState<SheetView | null>(null);
  /**
   * COLLAPSED BY DEFAULT. A day with eight cuts used to be eight full cards of
   * service lines and button rows, which is a lot of scrolling to answer "who
   * is in at 2". Collapsed, a row is the three things that make a schedule
   * readable — when, who, and what state it is in — and everything else is one
   * tap away. A REQUEST is the exception: it is asking the barber for
   * something, so it opens already expanded with Approve/Decline in reach.
   */
  const [expanded, setExpanded] = useState(row.status === "pending");
  const [customNudge, setCustomNudge] = useState("");
  // Skip = dismiss for THIS render only; the reward stays ready and the prompt
  // returns on reload (deliberate - skipping never consumes anything).
  const [rewardSkipped, setRewardSkipped] = useState(false);
  // Non-null = this row was cancelled in THIS session and the way back is still
  // on offer. A timestamp rather than a boolean so a re-render can't extend it.
  const [undoUntil, setUndoUntil] = useState<number | null>(null);
  const undoLive = useUndoWindow(undoUntil);
  // One shared table (appointmentCardStyles) so this card and the appointment
  // sheet can never describe the same booking two different ways.
  const pill = appointmentStatusPill({
    status: row.status,
    checkInStatus: row.checkInStatus,
    etaMinutes: row.etaMinutes,
    runningLate: row.runningLate,
  });
  const canAct = row.source === "appointment" && row.status === "upcoming";
  // A PENDING request (request-before-booking) gets Approve / Decline instead.
  const canApprove = row.source === "appointment" && row.status === "pending";
  const isRecurring = Boolean(row.seriesId);

  // Blocked-off time: a calm hatched band (no client/service/actions). The
  // reason rides in clientName; a synced Acuity block says where it came from.
  // The covered hours below this card get continuation strips (DayPlanner), so
  // the card itself just needs to read clearly: when, how long, why.
  if (row.source === "block") {
    const durMin =
      row.end && row.end > row.start
        ? Math.round((Date.parse(row.end) - Date.parse(row.start)) / 60_000)
        : null;
    // The Acuity badge already says where a synced block came from; a custom
    // reason ("Lunch + bank run") gets its own line so a narrow screen never
    // truncates it into nothing.
    const reason = row.clientName === "Blocked in Acuity" ? "" : row.clientName || "";
    // Duration rides INSIDE the identity pill rather than beside it. Three
    // separate chips (11h / Blocked / Unblock) crowded the right edge of every
    // band, and "how long" is a property of the block, not a second fact.
    const durSuffix = durMin !== null ? ` · ${fmtDuration(durMin)}` : "";
    const dupeCount = row.duplicateCount ?? 1;
    return (
      <div
        className={cn(
          "flex flex-col gap-0.5 rounded-lg border border-subtle/80 border-l-2 border-l-charcoal-600 bg-charcoal-800/30 px-3 py-2 text-xs",
          BLOCK_STRIPES,
        )}
      >
        <div className="flex items-center gap-2.5">
          <span className="min-w-0 truncate tabular-nums text-muted">{timeLabel}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* The external calendar holds several identical blocks for this
                span. One band with a count, rather than N bands nobody can tell
                apart - and it has to be VISIBLE, not silent, because the count
                is the only sign there is more than one thing to delete over
                there. */}
            {dupeCount > 1 && (
              <span
                title={`${dupeCount} identical blocks in the connected calendar`}
                className="rounded-full bg-charcoal-700 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted"
              >
                ×{dupeCount}
              </span>
            )}
            {row.syncedExternal ? (
              <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] font-medium tabular-nums text-sky-300">
                Acuity{durSuffix}
              </span>
            ) : (
              <span className="rounded-full bg-charcoal-700 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted">
                Blocked{durSuffix}
              </span>
            )}
            {/* Unblock, right on the band. Blocking time was always one tap and
                un-blocking it was impossible anywhere in the app — the endpoint
                existed but nothing called it, so a barber who blocked a day off
                could never give it back. Deliberately a plain visible button,
                not a menu: this is the one action a block has. Single tap
                matches Cancel on an appointment, which is far more destructive
                and also asks nothing. */}
            {!row.syncedExternal && (
              <button
                type="button"
                onClick={() => act(removeBlockAction, "Time unblocked")}
                disabled={pending}
                aria-label={`Unblock ${timeLabel}`}
                className="rounded-md border border-emerald-soft/40 px-2.5 py-1 text-[11px] font-medium text-emerald-soft transition-colors hover:bg-emerald-soft/10 disabled:opacity-50"
              >
                {pending ? "…" : "Unblock"}
              </button>
            )}
          </span>
        </div>
        {reason && reason !== "Blocked" && (
          <p className="truncate font-medium text-offwhite/75">{reason}</p>
        )}
        {/* Say WHY there's no button here, instead of leaving a dead band that
            looks identical to a removable one. */}
        {row.syncedExternal && (
          <p className="text-[10px] text-muted">
            {dupeCount > 1
              ? // Say it plainly: the band is one row now, but deleting one
                // block over there still leaves the others behind.
                `${dupeCount} identical blocks in Acuity — removing one leaves the rest.`
              : "Remove this in Acuity — it syncs back."}
          </p>
        )}
      </div>
    );
  }

  function act(fn: (id: string) => Promise<{ ok: boolean }>, label: string) {
    start(async () => {
      const res = await fn(row.id);
      toast(res.ok ? label : "Couldn't update", res.ok ? "success" : "error");
      if (res.ok) onChanged();
    });
  }

  /**
   * Cancel, with a way back.
   *
   * The undo is offered on the ROW rather than in a toast: a toast is gone in
   * three seconds and takes the only way back with it, while the cancelled card
   * is still sitting right there being the thing the barber is looking at. It's
   * deliberately scoped to a cancel THEY just did in this session - an old
   * cancelled row gets Remove, not Undo, because "undo" on something you did
   * last Tuesday isn't an undo.
   */
  function cancelWithUndo() {
    start(async () => {
      const res = await cancelAppointmentAction(row.id);
      if (!res.ok) {
        toast("Couldn't cancel", "error");
        return;
      }
      toast("Canceled", "success");
      setUndoUntil(Date.now() + UNDO_WINDOW_MS);
      onChanged();
    });
  }

  function undoCancel() {
    start(async () => {
      const res = await restoreAppointmentAction(row.id);
      if (res.ok) {
        setUndoUntil(null);
        toast("Booking restored", "success");
        onChanged();
        return;
      }
      // Say WHICH no. "Couldn't undo" tells a barber whose slot was just
      // claimed nothing about what to do next.
      toast(UNDO_FAILURES[res.error ?? ""] ?? "Couldn't undo that", "error");
      // The slot is gone or the row moved on: stop offering a button that
      // cannot work, and re-read so the calendar shows whatever is true now.
      setUndoUntil(null);
      onChanged();
    });
  }

  function sendNudge(body: string) {
    const trimmed = body.trim().slice(0, NUDGE_MAX_LEN);
    if (!trimmed) return;
    setNudgeMenu(false);
    setCustomNudge("");
    start(async () => {
      const res = await nudgeAppointmentAction(row.id, trimmed);
      if (!res.ok) {
        toast(
          res.error === "nudge_limit"
            ? "Nudge limit reached for this appointment"
            : "Couldn't send the nudge",
          "error",
        );
        return;
      }
      toast(
        res.delivered ? "Nudge sent" : "Logged — their notifications are off",
        res.delivered ? "success" : "error",
      );
      onChanged();
    });
  }

  function cancelScope(scope: "this" | "future" | "all") {
    if (!row.seriesId) return;
    start(async () => {
      const res = await cancelSeriesAction(
        row.seriesId!,
        scope,
        scope === "all" ? undefined : row.id,
      );
      setSeriesMenu(false);
      toast(res.ok ? "Canceled" : "Couldn't cancel", res.ok ? "success" : "error");
      if (res.ok) onChanged();
    });
  }

  // Service color-coding: a slim left accent line (and a dot by the service
  // name). Falls back to the default subtle border when the service has no color.
  const colorHex = serviceColorHex(row.serviceColor);
  const durMin =
    row.end && row.end > row.start
      ? Math.round((Date.parse(row.end) - Date.parse(row.start)) / 60_000)
      : null;
  return (
    <div
      className={cn(
        "rounded-xl border border-subtle bg-charcoal-800/60 px-3.5 py-3 shadow-[0_2px_10px_-6px_rgba(0,0,0,0.6)]",
        colorHex && "border-l-[3px]",
        row.status === "canceled" && "opacity-60",
      )}
      style={colorHex ? { borderLeftColor: colorHex } : undefined}
    >
      {/* When + status. Wraps rather than overflows: at 320px a time RANGE
          plus a status pill does not fit one line, and a clipped "Upcomi" is
          worse than a second row. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="whitespace-nowrap text-xs tabular-nums text-muted">
          {timeLabel}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold",
            pill.cls,
          )}
        >
          {pill.label}
        </span>
      </div>

      {/* WHO, and the toggle. The one fact this card exists to show: full
          width, wraps naturally, never truncates - "Ab…" is how double-books
          happen. Tapping it opens the rest of the card in place; the sheet
          (contact, payment, history) is one more tap from inside. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} appointment for ${row.clientName || "this client"}`}
        className="mt-2 flex w-full items-start gap-2.5 rounded-lg py-0.5 text-left transition-colors duration-150 ease-out hover:bg-charcoal-700/40"
      >
        <span
          aria-hidden
          className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-charcoal-700 text-[11px] font-semibold text-offwhite/80 ring-1 ring-white/10"
        >
          {initialsOf(row.clientName || "Client")}
        </span>
        <span className={cn(NAME_WRAP_CLS, "flex-1 text-[17px]")}>
          {row.clientName || "Client"}
        </span>
        <span
          aria-hidden
          className={cn(
            "mt-1 shrink-0 text-muted transition-transform duration-150 ease-out",
            expanded && "rotate-180",
          )}
        >
          <ChevronDownIcon />
        </span>
      </button>

      {/* Collapsed, the row stops here. What a barber scanning the day needs is
          when, who and what state — the service, the price and six buttons are
          what made eight cuts an unscrollable wall. */}
      {expanded && (
      <>

      {/* The service line: what, how long, how much - plus the origin chips,
          which used to crowd the name row. */}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[38px] text-xs text-muted">
        {colorHex && (
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: colorHex }}
          />
        )}
        <span className="[overflow-wrap:anywhere]">
          {row.serviceName ?? "Appointment"}
          {durMin !== null && ` · ${fmtDuration(durMin)}`}
          {row.price != null && ` · $${row.price.toFixed(0)}`}
        </span>
        {isRecurring && (
          <span
            title="Repeats weekly"
            className="shrink-0 rounded-full bg-gold/15 px-1.5 py-0.5 text-[10px] font-medium text-gold"
          >
            ↻ Weekly
          </span>
        )}
        {/* Booked in Acuity/Square, mirrored here. Says both "this time is
            taken for online booking" and "manage it where it was made". */}
        {row.syncedExternal && (
          <span
            title="Booked on your other platform (Acuity/Square). It blocks this time for online booking — change or cancel it there."
            data-testid="source-badge"
            className="shrink-0 rounded-full bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
          >
            Synced
          </span>
        )}
      </p>

      {/* SOURCE, not status. A synced booking is just as booked as a native
          one; what differs is who OWNS it. ChairBack has no outbound
          appointment API, so editing it here would desynchronize the two
          systems - the barber is sent to the system that actually owns it. */}
      {row.syncedExternal && (
        <div className="mt-3 rounded-lg border border-sky-400/30 bg-sky-400/5 px-3 py-2">
          <p className="text-[11px] text-sky-300">
            Booked in Acuity. Change or cancel it there — this card mirrors it so the
            time stays blocked here.
          </p>
          <a
            href="https://secure.acuityscheduling.com/appointments.php"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              BTN_BASE,
              "mt-2 border border-sky-400/40 text-sky-300 hover:bg-sky-400/10",
            )}
          >
            Edit in Acuity
          </a>
        </div>
      )}

      {canApprove && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => act(approveAppointmentAction, "Approved")}
            disabled={pending}
            className={cn(BTN_BASE, "border border-emerald-soft/45 bg-emerald-soft/10 font-semibold text-emerald-soft hover:bg-emerald-soft/15")}
          >
            Approve
          </button>
          <button
            onClick={() => act(declineAppointmentAction, "Declined")}
            disabled={pending}
            className={cn(BTN_BASE, "border border-danger-soft/40 text-danger-soft hover:bg-danger-soft/10")}
          >
            Decline
          </button>
        </div>
      )}

      {/* Reward ready - the manual-mode prompt. Apply redeems via the existing
          endpoint; Skip just hides it here (the reward stays available). */}
      {canAct && row.rewardReady && row.clientId && !rewardSkipped && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-gold/30 bg-gold/10 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Wraps rather than truncating: at 320px "Reward ready - apply Fre…"
              hid the reward's NAME, which is the one fact the prompt exists to
              convey. */}
          <span className="min-w-0 [overflow-wrap:anywhere] text-[11px] leading-snug text-gold">
            Reward ready — apply {row.rewardReady.rewardName} to this visit?
          </span>
          <span className="flex shrink-0 gap-1.5">
            <button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await applyRewardAction(
                    row.clientId!,
                    row.rewardReady!.rewardId,
                  );
                  toast(
                    res.ok ? `${row.rewardReady!.rewardName} applied` : "Couldn't apply",
                    res.ok ? "success" : "error",
                  );
                  if (res.ok) onChanged();
                })
              }
              className="rounded bg-gold px-2 py-0.5 text-[11px] font-semibold text-charcoal-900 disabled:opacity-50"
            >
              Apply
            </button>
            <button
              disabled={pending}
              onClick={() => setRewardSkipped(true)}
              className="rounded border border-subtle px-2 py-0.5 text-[11px] text-muted disabled:opacity-50"
            >
              Skip
            </button>
          </span>
        </div>
      )}

      {/* A cancelled row: the way back, and the way out. Native only - a synced
          Acuity/Square row is managed where it was made. */}
      {row.source === "appointment" && row.status === "canceled" && (
        <div data-qa="canceled-actions" className="mt-3 flex items-center gap-2">
          {undoLive && (
            <button
              type="button"
              onClick={undoCancel}
              disabled={pending}
              className={cn(
                BTN_BASE,
                "flex-1 border border-gold/40 bg-gold/10 text-gold hover:bg-gold/20 disabled:opacity-50",
              )}
            >
              {pending ? "…" : "Undo"}
            </button>
          )}
          <button
            type="button"
            onClick={() => act(dismissAppointmentAction, "Removed from the day")}
            disabled={pending}
            // "Remove" reads like a delete, so say what it actually does. The
            // booking stays in the client's history and in reporting either way.
            title="Hide this from the day. The booking stays in the client's history."
            className={cn(
              BTN_BASE,
              "flex-1 border border-subtle text-muted hover:text-offwhite disabled:opacity-50",
            )}
          >
            {pending ? "…" : "Remove"}
          </button>
        </div>
      )}

      {canAct && (
        <div data-qa="appt-actions" className="mt-3 grid grid-cols-2 gap-2">
          {row.hasPush === false ? (
            <span
              title="This client hasn't allowed notifications, so a nudge won't reach them."
              className={cn(
                BTN_BASE,
                "col-span-2 cursor-default border border-subtle text-muted/60",
              )}
            >
              Notifications off
            </span>
          ) : (row.nudgesSent ?? 0) < (row.nudgeLimit ?? 2) ? (
            <div className="relative col-span-2">
              <button
                onClick={() => setNudgeMenu((v) => !v)}
                disabled={pending}
                className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite")}
              >
                Nudge{(row.nudgesSent ?? 0) > 0 ? " (1 left)" : ""}
              </button>
              {nudgeMenu && (
                <div className="absolute left-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-subtle bg-charcoal-900 p-1 shadow-lg">
                  {NUDGE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      onClick={() => sendNudge(preset)}
                      className="block w-full rounded-md px-3 py-2 text-left text-[11px] text-offwhite hover:bg-charcoal-700"
                    >
                      {preset}
                    </button>
                  ))}
                  <div className="mt-1 flex gap-1 border-t border-subtle/60 p-1.5">
                    <input
                      value={customNudge}
                      onChange={(e) => setCustomNudge(e.target.value.slice(0, NUDGE_MAX_LEN))}
                      placeholder="Custom message…"
                      maxLength={NUDGE_MAX_LEN}
                      // text-xs on phones so the global 16px floor in globals.css can catch it:
                      // an ARBITRARY value like text-[11px] cannot be enumerated by a
                      // shared rule, and at 11px iOS zooms the whole agenda on focus.
                      // sm: restores the original 11px from the sm breakpoint up, so the
                      // desktop popover is pixel-identical.
                      className="min-w-0 flex-1 rounded-md border border-subtle bg-charcoal-800 px-2 py-1 text-xs text-offwhite placeholder:text-muted/50 sm:text-[11px]"
                    />
                    <button
                      onClick={() => sendNudge(customNudge)}
                      disabled={!customNudge.trim() || pending}
                      className="rounded-md bg-gold/20 px-2 py-1 text-[11px] font-medium text-gold disabled:opacity-40"
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <span
              className={cn(
                BTN_BASE,
                "col-span-2 cursor-default border border-subtle text-muted/60",
              )}
            >
              Nudged ×2
            </span>
          )}
          {row.checkInStatus !== "arrived" && (
            <button
              onClick={() => act(markArrivedAction, "Marked arrived")}
              disabled={pending}
              className={cn(BTN_BASE, "border border-gold/45 text-gold hover:bg-gold/10")}
            >
              Arrived
            </button>
          )}
          {/* Checkout: the money moment - THE primary action on the card, so
              it's the one solid-gold button. Sits BEFORE Done because checking
              out already completes the cut — a barber who taps this never needs
              Done, and one who works for free still has Done next to it. */}
          <button
            onClick={() => setSheet("charges")}
            disabled={pending}
            className={cn(
              BTN_BASE,
              row.paid != null
                ? "border border-gold/40 bg-gold/10 font-semibold text-gold"
                : "bg-gold font-semibold text-charcoal-900 hover:bg-gold/90",
            )}
          >
            {row.paid != null ? "Paid ✓" : "Checkout"}
          </button>
          <button
            onClick={() => act(completeAppointmentAction, "Marked done")}
            disabled={pending}
            className={cn(BTN_BASE, "border border-emerald-soft/45 text-emerald-soft hover:bg-emerald-soft/10")}
          >
            Done
          </button>
          <button
            onClick={() => act(noShowAppointmentAction, "Marked no-show")}
            disabled={pending}
            className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite")}
          >
            No-show
          </button>
          {isRecurring ? (
            <div className="relative">
              <button
                onClick={() => setSeriesMenu((v) => !v)}
                disabled={pending}
                className={cn(BTN_BASE, "border border-danger-soft/40 text-danger-soft hover:bg-danger-soft/10")}
              >
                Cancel ▾
              </button>
              {seriesMenu && (
                <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-subtle bg-charcoal-900 shadow-lg">
                  <button
                    onClick={() => cancelScope("this")}
                    className="block w-full px-3 py-2 text-left text-[11px] text-offwhite hover:bg-charcoal-700"
                  >
                    Just this one
                  </button>
                  <button
                    onClick={() => cancelScope("future")}
                    className="block w-full px-3 py-2 text-left text-[11px] text-offwhite hover:bg-charcoal-700"
                  >
                    This &amp; all future
                  </button>
                  <button
                    onClick={() => cancelScope("all")}
                    className="block w-full px-3 py-2 text-left text-[11px] text-danger-soft hover:bg-charcoal-700"
                  >
                    The whole series
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={cancelWithUndo}
              disabled={pending}
              className={cn(BTN_BASE, "border border-danger-soft/40 text-danger-soft hover:bg-danger-soft/10")}
            >
              Cancel
            </button>
          )}
          {/* EDIT fills the slot beside Cancel. Neutral outline, not gold:
              Checkout is the card's one primary action and a second bright
              button would compete with the money moment. */}
          <button
            onClick={() => setSheet("edit")}
            disabled={pending}
            aria-label={`Edit appointment for ${row.clientName}`}
            className={cn(BTN_BASE, "gap-1.5 border border-subtle text-muted hover:text-offwhite")}
          >
            <PencilIcon />
            Edit
          </button>
        </div>
      )}

      {/* The way through to everything the card does not carry: contact,
          the payment story, the client's other visits. Quiet, because the
          card's own actions are the common case and this is the deep one. */}
      <button
        type="button"
        onClick={() => setSheet("detail")}
        aria-label={`Open appointment details for ${row.clientName || "this client"}`}
        className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-subtle text-xs font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite sm:h-9"
      >
        Full details
      </button>
      </>
      )}

      {/* The appointment sheet: contact, payment truth, editing and the
          chair-side checkout, all behind one dialog. Mounted from the row so it
          always carries THAT booking's live figures; onChanged refreshes the
          agenda, which is what flips the button to "Paid ✓". */}
      {sheet && (
        <AppointmentSheet
          row={row}
          toast={toast}
          initialView={sheet}
          onClose={() => setSheet(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

//  helpers

type Cell = { key: string; dayNum: number; inMonth: boolean } | null;

/** Build a month as weeks of 7 cells (Sun-first), incl. leading/trailing days. */
function buildMonthGrid(year: number, month1to12: number): Cell[][] {
  const first = new Date(year, month1to12 - 1, 1);
  const startWeekday = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month1to12, 0).getDate();
  const daysInPrev = new Date(year, month1to12 - 1, 0).getDate();

  const cells: Cell[] = [];
  // Leading days from the previous month.
  for (let i = 0; i < startWeekday; i++) {
    const d = daysInPrev - startWeekday + 1 + i;
    const pm = month1to12 === 1 ? 12 : month1to12 - 1;
    const py = month1to12 === 1 ? year - 1 : year;
    cells.push({ key: keyOf(py, pm, d), dayNum: d, inMonth: false });
  }
  // This month.
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ key: keyOf(year, month1to12, d), dayNum: d, inMonth: true });
  }
  // Trailing days to complete the last week.
  while (cells.length % 7 !== 0) {
    const idx = cells.length - (startWeekday + daysInMonth) + 1;
    const nm = month1to12 === 12 ? 1 : month1to12 + 1;
    const ny = month1to12 === 12 ? year + 1 : year;
    cells.push({ key: keyOf(ny, nm, idx), dayNum: idx, inMonth: false });
  }

  const weeks: Cell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function keyOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Move a YYYY-MM-DD key by N calendar days, rolling months and years.
 *
 * Pure calendar arithmetic on a LOCAL noon Date: the key is a wall-clock day in
 * the shop's zone, and we only ever read y/m/d back out, so no zone conversion
 * happens in either direction. Noon (not midnight) so a DST jump can't land the
 * result on the previous day.
 */
/** 0-6 (Sun-Sat) for a YYYY-MM-DD key. Local noon, same reasoning as shiftDayKey. */
function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12).getDay();
}

function shiftDayKey(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const shifted = new Date(y!, m! - 1, d! + delta, 12);
  return keyOf(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate());
}

/** Label a YYYY-MM-DD key for an EMPTY day (no real instant to format). Builds a
 *  local noon Date from the parts so the weekday/month are correct. */
function labelFromKey(key: string, fmt: Intl.DateTimeFormat): string {
  const [y, m, d] = key.split("-").map(Number);
  return fmt.format(new Date(y!, m! - 1, d!, 12));
}

/** "8 AM", "12 PM", "5 PM" from a 0-23 hour. */
function formatHour(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}
