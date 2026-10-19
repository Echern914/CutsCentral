"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { MinutesField, MoneyField } from "@/components/ui/UnitField";
import { cap, useVocab } from "@/components/VocabProvider";
import { cn } from "@/lib/cn";
import { parsePrice } from "@/lib/serviceFields";
import { OPENING_CONFLICT_WORDS } from "@chairback/config/specialDay";
import {
  getSpecialDayViewAction,
  removeSpecialDaysAction,
  saveSpecialDayViewAction,
  type DayView,
  type DayViewChair,
  type SaveDayInput,
} from "./actions";
import {
  addOpening,
  changeCount,
  clock,
  draftFromView,
  fillChair,
  hhmm,
  minutesOf,
  rebaseDraft,
  type Draft,
  type DraftOpening,
} from "./liveDay";
import type { ServiceRow, StaffRow } from "./page";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * OPEN LIVE VIEW - one date drawn as a timeline per lane, where the barber
 * shapes the day himself (Drick: "This should show the 'open live view' so I
 * can select specific prices and TIMES available for that day ... make all
 * cuts (20 min long) only on that day and charge $65 all day").
 *
 *   - What is already there is drawn first: bookings, Acuity time, blocked
 *     time, and the normal hours clients would otherwise get.
 *   - "Fill the day" lays openings down in one step (every 20 min from 9 to 5
 *     at $65) - the Special day generator, through the same shared rule the
 *     server saves with (config/specialDay.ts), so nothing is offered over a
 *     booking or a block.
 *   - Tap an opening to change ITS price or take it off; tap empty time to add
 *     one there.
 *   - Nothing is live until Save. The save is one server transaction under the
 *     calendar locks, against the exact day drawn here (a stale view gets the
 *     fresh day back and saves nothing), and a booked opening never moves,
 *     re-prices or disappears.
 *
 * Phone first: it opens as the app's bottom sheet, one lane at a time, every
 * tap target at least 44px, no sideways scrolling.
 */

/** Pixels per minute on the timeline: a 20-minute opening is 48px tall. */
const PX = 2.4;
/** Tap-to-add snaps to this many minutes. */
const SNAP = 5;

const field = "h-11 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite";

function prettyDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `lv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** The minutes the timeline shows: the lane's day with an hour either side. */
function timelineRange(lane: DayViewChair, openings: DraftOpening[], extra: { earlier: number; later: number }) {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const i of [...lane.hours, ...lane.bookings, ...lane.external]) {
    starts.push(i.startMin);
    ends.push(i.endMin);
  }
  for (const o of openings) {
    starts.push(o.startMin);
    ends.push(o.startMin + o.durationMin);
  }
  const lo = starts.length ? Math.min(...starts) : 9 * 60;
  const hi = ends.length ? Math.max(...ends) : 17 * 60;
  return {
    lo: Math.max(0, Math.floor((lo - 60) / 60) * 60 - extra.earlier),
    hi: Math.min(1440, Math.ceil((hi + 60) / 60) * 60 + extra.later),
  };
}

export function LiveDayView({
  open,
  dates,
  defaultName,
  defaultPrice,
  services,
  staff,
  toast,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The date(s) to open - a holiday stretch steps day by day. */
  dates: string[];
  /** The holiday's name, for a day that is not a special day yet. */
  defaultName?: string;
  /** The holiday's price, the starting "price each" for a new day. */
  defaultPrice?: number | null;
  services: ServiceRow[];
  staff: StaffRow[];
  toast: Toast;
  onClose: () => void;
  /** A save or removal landed (lists elsewhere re-read). */
  onSaved?: () => void;
}) {
  const vocab = useVocab();
  const activeServices = useMemo(() => services.filter((s) => s.active), [services]);
  const nameOf = (id: string) => staff.find((s) => s.id === id)?.name ?? cap(vocab.providerNoun);

  const [dateIdx, setDateIdx] = useState(0);
  const date = dates[dateIdx] ?? dates[0] ?? "";
  const [view, setView] = useState<DayView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [laneId, setLaneId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [counts, setCounts] = useState<Set<string>>(new Set());
  // Fill the day.
  const [fillOpen, setFillOpen] = useState(false);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [cut, setCut] = useState("20");
  const [price, setPrice] = useState("");
  const [fillChairs, setFillChairs] = useState<Set<string>>(new Set());
  // Tap-to-edit and tap-to-add.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selPrice, setSelPrice] = useState("");
  const [addAt, setAddAt] = useState("");
  const [extra, setExtra] = useState({ earlier: 0, later: 0 });
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  // One id per save attempt: a double tap or a retried request replays.
  const requestId = useRef(newRequestId());

  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  /** Take a freshly loaded/saved day as the new starting point. */
  function adopt(v: DayView, opts: { keepForm?: boolean } = {}) {
    setView(v);
    setDraft(draftFromView(v));
    setSelectedKey(null);
    requestId.current = newRequestId();
    setLaneId((cur) => (cur && v.chairs.some((c) => c.staffId === cur) ? cur : v.chairs[0]?.staffId ?? null));
    if (opts.keepForm) return;
    setName(v.name ?? defaultName ?? "");
    setCounts(new Set(v.serviceIds));
    const first = v.chairs[0];
    const live = v.chairs.some((c) => c.openings.length > 0);
    const hours = first?.hours ?? [];
    setFrom(hhmm(hours.length ? Math.min(...hours.map((h) => h.startMin)) : 9 * 60));
    setTo(hhmm(hours.length ? Math.max(...hours.map((h) => h.endMin)) : 17 * 60));
    const savedPrice = v.chairs.flatMap((c) => c.openings)[0]?.price;
    setPrice(
      savedPrice !== undefined ? String(savedPrice) : defaultPrice !== null && defaultPrice !== undefined ? String(defaultPrice) : "",
    );
    const savedCut = v.chairs.flatMap((c) => c.openings)[0]?.durationMin;
    setCut(String(savedCut ?? 20));
    setFillChairs(new Set(first ? [first.staffId] : []));
    // A day with nothing on it yet opens on the one-step fill.
    setFillOpen(!live);
    setExtra({ earlier: 0, later: 0 });
  }

  function load(d: string) {
    setView(null);
    setLoadError(null);
    setProblem(null);
    setNotice(null);
    void getSpecialDayViewAction(d)
      .then((r) => {
        if (r.ok) adopt(r.view);
        else setLoadError(r.message ?? "Couldn't open this day. Check your connection and try again.");
      })
      .catch(() => setLoadError("Couldn't open this day. Check your connection and try again."));
  }

  useEffect(() => {
    if (open && date) load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, date]);

  // A new set of dates (another holiday) starts on its first day.
  const datesKey = dates.join(",");
  useEffect(() => {
    if (open) setDateIdx(0);
  }, [open, datesKey]);

  const lane = view?.chairs.find((c) => c.staffId === laneId) ?? view?.chairs[0] ?? null;
  const mine = lane ? draft[lane.staffId] ?? [] : [];
  const changes = view ? changeCount(view, draft) : 0;
  const totalOpenings = Object.values(draft).reduce((n, list) => n + list.length, 0);
  const wasLive = !!view && view.chairs.some((c) => c.openings.length > 0);
  const selected = mine.find((o) => o.key === selectedKey) ?? null;

  function setLaneDraft(staffId: string, list: DraftOpening[]) {
    setDraft((cur) => ({ ...cur, [staffId]: list }));
  }

  /** The fill form's price and length, or why they aren't usable yet. */
  function readDefaults(): { price: number; cutMin: number } | string {
    const cutMin = Number(cut);
    if (!Number.isInteger(cutMin) || cutMin < 5 || cutMin > 240) return "Length is 5 to 240 minutes";
    const p = parsePrice(price);
    if (!p.ok) return p.error;
    if (p.value === null) return "Set the price for each opening first";
    return { price: p.value, cutMin };
  }

  function fill() {
    if (!view) return;
    const d = readDefaults();
    if (typeof d === "string") {
      setProblem(d);
      return;
    }
    const startMin = minutesOf(from);
    const endMin = minutesOf(to);
    if (startMin === null || endMin === null || endMin <= startMin) {
      setProblem("The end time must be after the start time");
      return;
    }
    const targets = view.chairs.filter((c) => fillChairs.has(c.staffId));
    if (targets.length === 0) {
      setProblem(`Pick at least one ${vocab.providerNoun}`);
      return;
    }
    const lines: string[] = [];
    const next = { ...draft };
    for (const c of targets) {
      const r = fillChair(view, c, draft[c.staffId] ?? [], { startMin, endMin, cutMin: d.cutMin, price: d.price });
      next[c.staffId] = r.openings;
      const made = r.openings.filter((o) => !o.booked).length;
      let line = `${nameOf(c.staffId)}: ${made} opening${made === 1 ? "" : "s"}`;
      if (r.skipped.length > 0) {
        line += `. Left out ${r.skipped.map((s) => `${clock(s.startMin)} (${OPENING_CONFLICT_WORDS[s.reason]})`).join(", ")}`;
      }
      lines.push(line);
    }
    setDraft(next);
    setSelectedKey(null);
    setProblem(null);
    setNotice(`${lines.join(" · ")}. Not saved yet - check the day, then save.`);
    setFillOpen(false);
  }

  function addAtMinute(startMin: number) {
    if (!view || !lane) return;
    const d = readDefaults();
    if (typeof d === "string") {
      setProblem(`${d} - it's the price a tapped-in opening gets (Fill the day).`);
      setFillOpen(true);
      return;
    }
    const r = addOpening(view, lane, mine, { startMin, durationMin: d.cutMin, price: d.price });
    if (!r.ok) {
      setProblem(`Can't add an opening at ${clock(startMin)}: ${OPENING_CONFLICT_WORDS[r.reason]}.`);
      return;
    }
    setLaneDraft(lane.staffId, r.openings);
    setProblem(null);
    setNotice(null);
    select(r.openings.find((o) => o.key === r.key) ?? null);
  }

  function select(o: DraftOpening | null) {
    setSelectedKey(o?.key ?? null);
    setSelPrice(o ? String(o.price) : "");
  }

  function changeSelectedPrice(value: string) {
    setSelPrice(value);
    if (!lane || !selected || selected.booked) return;
    const p = parsePrice(value);
    if (!p.ok || p.value === null) return;
    const v = p.value;
    setLaneDraft(
      lane.staffId,
      mine.map((o) => (o.key === selected.key ? { ...o, price: v } : o)),
    );
  }

  function removeSelected() {
    if (!lane || !selected || selected.booked) return;
    setLaneDraft(
      lane.staffId,
      mine.filter((o) => o.key !== selected.key),
    );
    select(null);
  }

  function onTimelineTap(e: React.MouseEvent<HTMLDivElement>, lo: number) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minute = lo + Math.floor(y / PX / SNAP) * SNAP;
    addAtMinute(minute);
  }

  function save() {
    if (!view || pending) return;
    if (totalOpenings > 0 && counts.size === 0) {
      setProblem("Choose which services these openings can be booked as");
      return;
    }
    const input: SaveDayInput = {
      date: view.date,
      name: name.trim(),
      serviceIds: [...counts],
      basis: view.basis,
      requestId: requestId.current,
      chairs: view.chairs.map((c) => ({
        staffId: c.staffId,
        openings: (draft[c.staffId] ?? []).map((o) => ({
          ...(o.id ? { id: o.id } : {}),
          startMin: o.startMin,
          durationMin: o.durationMin,
          price: o.price,
        })),
      })),
    };
    void run(async () => {
      const r = await saveSpecialDayViewAction(input);
      if (r.ok) {
        adopt(r.view, { keepForm: true });
        const live = r.view.chairs.reduce((n, c) => n + c.openings.length, 0);
        toast(
          live > 0
            ? `${name.trim() || "Special day"} saved: clients can book ${live} opening${live === 1 ? "" : "s"} on ${prettyDate(view.date)}`
            : `Saved: ${prettyDate(view.date)} is back to your normal schedule`,
          "success",
        );
        setNotice(null);
        setProblem(null);
        onSaved?.();
        return;
      }
      if (r.error === "changed" && r.view) {
        const { draft: rebased, dropped } = rebaseDraft(r.view, draft);
        setView(r.view);
        setDraft(rebased);
        setSelectedKey(null);
        requestId.current = newRequestId();
        setProblem(
          (r.message ?? "Something on this day changed since you opened it. Nothing was saved.") +
            (dropped.length > 0
              ? ` Taken out of your changes because they no longer fit: ${dropped.map((d) => clock(d.startMin)).join(", ")}.`
              : ""),
        );
        return;
      }
      requestId.current = newRequestId();
      setProblem(r.message ?? "Couldn't save - nothing was changed. Try again.");
    });
  }

  function removeDay() {
    if (!view) return;
    const ruleIds = view.chairs.flatMap((c) => c.ruleIds);
    if (ruleIds.length === 0) return;
    const booked = view.chairs.reduce((n, c) => n + c.openings.filter((o) => o.booked).length, 0);
    const q =
      `Remove the special day on ${prettyDate(view.date)}? Its open times are deleted and the normal schedule comes back.` +
      (booked > 0 ? ` ${booked} booked visit${booked === 1 ? "" : "s"} stay booked.` : "");
    if (!window.confirm(q)) return;
    void run(async () => {
      const r = await removeSpecialDaysAction(ruleIds);
      if (r.ok) {
        toast(
          `Special day removed` +
            (r.bookedKept > 0 ? ` - ${r.bookedKept} booked visit${r.bookedKept === 1 ? "" : "s"} kept` : ""),
          "success",
        );
        onSaved?.();
        load(view.date);
      } else setProblem("Couldn't remove it - nothing was changed.");
    });
  }

  function close() {
    if (changes > 0 && !window.confirm(`Close without saving? ${changes} change${changes === 1 ? "" : "s"} will be lost.`)) {
      return;
    }
    onClose();
  }

  function goToDate(idx: number) {
    if (changes > 0 && !window.confirm(`Leave this day without saving? ${changes} change${changes === 1 ? "" : "s"} will be lost.`)) {
      return;
    }
    setDateIdx(idx);
  }

  function toggle(set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    set((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const title = `${name.trim() || defaultName || "Special day"} · ${date ? prettyDate(date) : ""}`;
  const range = lane ? timelineRange(lane, mine, extra) : { lo: 540, hi: 1020 };
  const hourMarks: number[] = [];
  for (let h = Math.ceil(range.lo / 60) * 60; h <= range.hi; h += 60) hourMarks.push(h);
  const clip = (s: number, e: number) => ({ s: Math.max(s, range.lo), e: Math.min(e, range.hi) });

  const footer = view ? (
    <div className="flex w-full flex-col gap-2">
      {selected && lane && (
        <div
          className="rounded-xl border border-gold/40 bg-gold/5 p-2"
          role="group"
          aria-label={`Opening at ${clock(selected.startMin)}`}
        >
          <p className="text-xs font-medium text-offwhite">
            {clock(selected.startMin)} – {clock(selected.startMin + selected.durationMin)}
            {selected.booked ? " · Booked" : selected.id ? "" : " · new"}
          </p>
          {selected.booked ? (
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="text-xs text-muted">Booked by a client at {money(selected.price)}. It stays exactly as booked.</p>
              <button type="button" onClick={() => select(null)} className="h-11 rounded-xl px-3 text-sm text-muted">
                Done
              </button>
            </div>
          ) : (
            <div className="mt-1 flex flex-wrap items-end gap-2">
              <MoneyField
                label="Price for this opening"
                value={selPrice}
                onChange={changeSelectedPrice}
                className="w-36"
                inputClassName="h-11"
              />
              <button
                type="button"
                onClick={removeSelected}
                className="h-11 rounded-xl border border-subtle px-3 text-sm text-danger-soft"
              >
                Remove opening
              </button>
              <button type="button" onClick={() => select(null)} className="h-11 rounded-xl px-3 text-sm text-muted">
                Done
              </button>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted" aria-live="polite">
        {changes > 0
          ? `${changes} unsaved change${changes === 1 ? "" : "s"} - clients still see the day as it was until you save.`
          : wasLive
            ? `Live: clients can book only these ${totalOpenings} opening${totalOpenings === 1 ? "" : "s"} that day, each at the price shown.`
            : "Not a special day yet - clients book your normal hours."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || changes === 0 || (!wasLive && totalOpenings === 0)}
          className="h-11 flex-1 rounded-xl bg-gold/20 px-4 text-sm font-semibold text-gold transition-colors hover:bg-gold/30 disabled:opacity-50 sm:flex-none"
        >
          {pending
            ? "Saving…"
            : wasLive
              ? "Save changes"
              : `Publish ${totalOpenings} opening${totalOpenings === 1 ? "" : "s"}`}
        </button>
        {wasLive && changes === 0 && (
          <button
            type="button"
            onClick={removeDay}
            disabled={pending}
            className="h-11 rounded-xl px-3 text-sm text-muted transition-colors hover:text-danger-soft disabled:opacity-50"
          >
            Remove special day
          </button>
        )}
      </div>
    </div>
  ) : undefined;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      subtitle="Live view - see the day, fill it, and tap to change one opening."
      footer={footer}
      className="sm:max-w-xl"
      scrollResetKey={date}
    >
      {dates.length > 1 && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => goToDate(dateIdx - 1)}
            disabled={dateIdx === 0 || pending}
            className="h-11 rounded-xl border border-subtle px-3 text-sm text-muted disabled:opacity-40"
            aria-label="Previous day"
          >
            ‹ Prev
          </button>
          <span className="text-xs text-muted">
            Day {dateIdx + 1} of {dates.length}
          </span>
          <button
            type="button"
            onClick={() => goToDate(dateIdx + 1)}
            disabled={dateIdx >= dates.length - 1 || pending}
            className="h-11 rounded-xl border border-subtle px-3 text-sm text-muted disabled:opacity-40"
            aria-label="Next day"
          >
            Next ›
          </button>
        </div>
      )}

      {loadError ? (
        <div className="text-sm text-muted">
          <p role="alert">{loadError}</p>
          <button type="button" onClick={() => load(date)} className="mt-2 h-11 text-gold underline">
            Try again
          </button>
        </div>
      ) : !view || !lane ? (
        <p className="text-sm text-muted">Loading the day…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Name
            <input
              type="text"
              value={name}
              maxLength={40}
              placeholder="Thanksgiving"
              onChange={(e) => setName(e.target.value)}
              className={cn(field, "w-full")}
            />
          </label>

          <div>
            <p className="text-xs text-muted">Openings can be booked as</p>
            <div role="group" aria-label="Services the openings count as" className="mt-1 flex flex-wrap gap-1.5">
              {activeServices.map((s) => {
                const on = counts.has(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(setCounts, s.id)}
                    className={cn(
                      "min-h-[44px] rounded-full border px-3 text-xs transition-colors",
                      on ? "border-gold/60 bg-gold/15 text-gold" : "border-subtle text-muted hover:text-offwhite",
                    )}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>

          {view.chairs.length > 1 && (
            <div role="tablist" aria-label={cap(vocab.providerNounPlural)} className="flex flex-wrap gap-1.5">
              {view.chairs.map((c) => {
                const on = c.staffId === lane.staffId;
                const n = (draft[c.staffId] ?? []).length;
                return (
                  <button
                    key={c.staffId}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => {
                      setLaneId(c.staffId);
                      select(null);
                    }}
                    className={cn(
                      "min-h-[44px] rounded-xl border px-3 text-sm transition-colors",
                      on ? "border-gold/60 bg-gold/15 text-gold" : "border-subtle text-muted hover:text-offwhite",
                    )}
                  >
                    {nameOf(c.staffId)}
                    <span className="ml-1 text-xs opacity-70">{n}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="rounded-xl border border-subtle">
            <button
              type="button"
              aria-expanded={fillOpen}
              onClick={() => setFillOpen((v) => !v)}
              className="flex h-11 w-full items-center justify-between px-3 text-sm font-medium text-offwhite"
            >
              Fill the day in one step
              <span className="text-muted" aria-hidden>
                {fillOpen ? "▴" : "▾"}
              </span>
            </button>
            {fillOpen && (
              <div className="border-t border-subtle p-3">
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    From
                    <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    To
                    <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
                  </label>
                  <MinutesField label="Length" value={cut} onChange={setCut} min={5} placeholder="20" inputClassName="h-11" />
                  <MoneyField label="Price each" value={price} onChange={setPrice} placeholder="65" inputClassName="h-11" />
                </div>
                {view.chairs.length > 1 && (
                  <div role="group" aria-label={`Fill for these ${vocab.providerNounPlural}`} className="mt-2 flex flex-wrap gap-1.5">
                    {view.chairs.map((c) => {
                      const on = fillChairs.has(c.staffId);
                      return (
                        <button
                          key={c.staffId}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggle(setFillChairs, c.staffId)}
                          className={cn(
                            "min-h-[44px] rounded-full border px-3 text-xs transition-colors",
                            on ? "border-gold/60 bg-gold/15 text-gold" : "border-subtle text-muted hover:text-offwhite",
                          )}
                        >
                          {nameOf(c.staffId)}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="mt-2 text-xs text-muted">
                  Replaces the open (unbooked) openings{view.chairs.length > 1 ? " for the people picked" : ""}. Booked ones
                  stay. Nothing is placed over a booking or blocked time
                  {view.bufferMin > 0 ? `, and openings are spaced by your ${view.bufferMin}-min turnover` : ""}.
                </p>
                <button
                  type="button"
                  onClick={fill}
                  className="mt-2 h-11 w-full rounded-xl bg-gold/20 px-4 text-sm font-semibold text-gold transition-colors hover:bg-gold/30"
                >
                  Fill the day
                </button>
              </div>
            )}
          </div>

          {notice && <p className="text-xs text-offwhite">{notice}</p>}
          {problem && (
            <p role="alert" className="text-xs text-danger-soft">
              {problem}
            </p>
          )}

          <div className="rounded-xl bg-offwhite/5 px-3 py-2 text-xs text-muted">
            {mine.length > 0 ? (
              <>
                On {prettyDate(view.date)}, clients can book <span className="text-gold">only the gold openings</span>,
                each at the price on it. {nameOf(lane.staffId)}&apos;s normal hours
                {lane.hours.length > 0
                  ? ` (${lane.hours.map((h) => `${clock(h.startMin)}–${clock(h.endMin)}`).join(", ")})`
                  : ""}{" "}
                are closed that day.
              </>
            ) : (
              <>
                No openings for {nameOf(lane.staffId)}
                {lane.hours.length > 0
                  ? ` - clients book the normal hours (${lane.hours.map((h) => `${clock(h.startMin)}–${clock(h.endMin)}`).join(", ")})`
                  : ""}
                . Fill the day, or tap empty time below to add an opening.
              </>
            )}
          </div>

          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
              Add one opening at
              <input type="time" value={addAt} onChange={(e) => setAddAt(e.target.value)} className={cn(field, "w-full")} />
            </label>
            <button
              type="button"
              onClick={() => {
                const m = minutesOf(addAt);
                if (m === null) setProblem("Pick a time to add");
                else addAtMinute(m);
              }}
              className="h-11 rounded-xl border border-subtle px-4 text-sm text-gold"
            >
              Add
            </button>
          </div>

          {range.lo > 0 && (
            <button
              type="button"
              onClick={() => setExtra((x) => ({ ...x, earlier: x.earlier + 120 }))}
              className="h-11 text-xs text-muted underline"
            >
              Show earlier
            </button>
          )}
          <div className="flex">
            <div className="relative w-14 flex-none" style={{ height: (range.hi - range.lo) * PX }} aria-hidden>
              {hourMarks.map((m) => (
                <span
                  key={m}
                  className="absolute right-2 -translate-y-1/2 text-[11px] text-muted"
                  style={{ top: (m - range.lo) * PX }}
                >
                  {clock(m).replace(":00", "")}
                </span>
              ))}
            </div>
            <div
              data-testid="live-timeline"
              className="relative min-w-0 flex-1 cursor-pointer overflow-hidden rounded-xl border border-subtle"
              style={{ height: (range.hi - range.lo) * PX }}
              onClick={(e) => onTimelineTap(e, range.lo)}
              title="Tap empty time to add an opening"
            >
              {hourMarks.map((m) => (
                <div
                  key={m}
                  className="pointer-events-none absolute inset-x-0 border-t border-subtle"
                  style={{ top: (m - range.lo) * PX }}
                />
              ))}
              {lane.hours.map((h, i) => {
                const { s, e } = clip(h.startMin, h.endMin);
                if (e <= s) return null;
                return (
                  <div
                    key={`h${i}`}
                    className={cn("pointer-events-none absolute inset-x-0", mine.length > 0 ? "bg-offwhite/[0.03]" : "bg-offwhite/[0.06]")}
                    style={{ top: (s - range.lo) * PX, height: (e - s) * PX }}
                  />
                );
              })}
              {lane.blocks.map((b, i) => {
                const { s, e } = clip(b.startMin, b.endMin);
                if (e <= s) return null;
                return (
                  <div
                    key={`b${i}`}
                    className="pointer-events-none absolute inset-x-1 overflow-hidden rounded-lg border border-dashed border-subtle-strong bg-charcoal-700/70 px-2 py-0.5 text-[11px] text-muted"
                    style={{ top: (s - range.lo) * PX, height: Math.max((e - s) * PX - 2, 14) }}
                  >
                    {b.label} · {clock(b.startMin)}–{clock(b.endMin)}
                  </div>
                );
              })}
              {[...lane.bookings, ...lane.external].map((b, i) => {
                const { s, e } = clip(b.startMin, b.endMin);
                if (e <= s) return null;
                return (
                  <div
                    key={`a${i}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setProblem(`${b.label} at ${clock(b.startMin)} stays as it is.`);
                    }}
                    className="absolute inset-x-1 overflow-hidden rounded-lg border border-subtle bg-charcoal-700 px-2 py-0.5 text-[11px] text-offwhite"
                    style={{ top: (s - range.lo) * PX, height: Math.max((e - s) * PX - 2, 14) }}
                  >
                    {clock(b.startMin)} · {b.label}
                  </div>
                );
              })}
              {mine.map((o) => {
                const { s, e } = clip(o.startMin, o.startMin + o.durationMin);
                if (e <= s) return null;
                const on = o.key === selectedKey;
                return (
                  <button
                    key={o.key}
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      select(on ? null : o);
                    }}
                    aria-pressed={on}
                    aria-label={`Opening ${clock(o.startMin)}, ${money(o.price)}${o.booked ? ", booked" : ""}`}
                    className={cn(
                      "absolute inset-x-1 flex items-center justify-between gap-2 overflow-hidden rounded-lg border px-2 text-left text-xs",
                      o.booked
                        ? "border-subtle-strong bg-charcoal-700 text-offwhite"
                        : "border-gold/60 bg-gold/15 text-gold",
                      on && "ring-2 ring-gold",
                    )}
                    style={{ top: (s - range.lo) * PX + 1, height: Math.max((e - s) * PX - 2, 28) }}
                  >
                    <span className="font-medium">{clock(o.startMin)}</span>
                    <span>
                      {money(o.price)}
                      {o.booked ? " · Booked" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {range.hi < 1440 && (
            <button
              type="button"
              onClick={() => setExtra((x) => ({ ...x, later: x.later + 120 }))}
              className="h-11 text-xs text-muted underline"
            >
              Show later
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}
