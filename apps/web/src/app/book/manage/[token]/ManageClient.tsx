"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { DEMO } from "@chairback/config/demo";
import { useSignalNativeReady } from "@/lib/nativeReady";
import { CustomerBack } from "@/components/CustomerBack";
import { DemoTour } from "@/components/tour/DemoTour";
import { useDemoTour } from "@/components/tour/state";
import type { ManageData } from "./page";
import {
  cancelBookingAction,
  checkInAction,
  nudgeReplyAction,
  rescheduleBookingAction,
  rescheduleOptionsAction,
} from "./actions";

/**
 * Customer self-service for a single booking (auth = the manage token in the
 * URL). Shows the appointment and lets the customer cancel or reschedule in
 * place: ReschedulePicker below lists the barber's own open times and moves the
 * booking in a single call, so the appointment keeps its identity, its manage
 * link, and its slot in the calendar rather than being cancelled and recreated.
 */
export function ManageClient({
  token,
  data,
}: {
  token: string;
  data: ManageData;
}) {
  // Clear the native app's WebView spinner (reachable from a booking
  // confirmation link opened inside the app).
  useSignalNativeReady();

  // What the customer canceled: just this visit, or this and every later one.
  const [canceledScope, setCanceledScope] = useState<"this" | "future" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Set once a reschedule succeeds, so the page shows the NEW time immediately
  // instead of the stale one it was server-rendered with.
  const [movedTo, setMovedTo] = useState<string | null>(null);
  // Check-in state is shared between the nudge banner and the check-in card so
  // answering "On my way" in one place updates both.
  const [checkinStatus, setCheckinStatus] = useState(data.checkin.status);

  // ---- Guided demo-tour mode (the seeded showcase appointment only). The
  // check-in card is forced open (the real window is 60 min before start; the
  // demo appointment is always "tomorrow") and every tap settles locally — no
  // server writes. A sample barber nudge is injected so the banner shows, and
  // cancel/reschedule are inert so the seeded appointment survives the tour.
  const { stepId: tourStepId } = useDemoTour();
  const demoTour = tourStepId !== null && token === DEMO.MANAGE_TOKEN;
  const checkin = demoTour ? { ...data.checkin, open: true } : data.checkin;
  const nudges: typeof data.nudges =
    demoTour && data.nudges.length === 0
      ? [{ body: "Chair's open early if you can make it — come through!", sentAt: new Date().toISOString() }]
      : data.nudges;

  const whenFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: data.shop.timezone,
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    [data.shop.timezone],
  );
  const when = whenFmt.format(new Date(movedTo ?? data.startsAt));

  function cancel(scope: "this" | "future") {
    setError(null);
    startTransition(async () => {
      const res = await cancelBookingAction(token, scope);
      if (!res.ok) {
        setError("Couldn't cancel. Please try again or call the shop.");
        return;
      }
      setCanceledScope(scope);
    });
  }

  const isCanceled = canceledScope !== null || data.status === "CANCELED";
  // Later visits of a standing appointment that are still on the books. Zero
  // (or not a series) hides the second cancel button entirely.
  const laterVisits = data.series?.remaining ?? 0;
  const isDone = data.status === "COMPLETED" || data.status === "NO_SHOW";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
      {/* Guided client-experience tour — the seeded demo appointment only.
          data-tour anchors: keep in sync with packages/config/src/demoTour.ts */}
      {token === DEMO.MANAGE_TOKEN && <DemoTour route="manage" />}
      {/* "← {shop}" — in the app WebView this page has no browser chrome, so
          it was a dead end. Pops history when there is any; a direct visit
          (texted confirmation link) falls back to the shop's public page. */}
      <CustomerBack
        label={`← ${data.shop.name}`}
        fallbackHref={data.shop.slug ? `/s/${data.shop.slug}` : undefined}
        className="mb-4 self-start rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-muted transition-colors hover:text-offwhite"
      />
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <p className="text-xs uppercase tracking-wide text-muted">Your appointment</p>
        <h1 className="mt-1 font-display text-2xl">{data.shop.name}</h1>

        <dl className="mt-4 space-y-2 text-sm">
          <Row label="Service" value={data.service.name} />
          <Row label="With" value={data.staff.name} />
          <Row label="When" value={when} />
          <Row
            label="Status"
            value={
              isCanceled
                ? "Canceled"
                : isDone
                  ? "Completed"
                  : "Confirmed"
            }
          />
        </dl>

        {error && (
          <p role="alert" className="mt-4 text-xs text-red-400">
            {error}
          </p>
        )}

        {isCanceled ? (
          <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-muted">
            {canceledScope === "future"
              ? `This appointment and your ${laterVisits} later ${laterVisits === 1 ? "visit" : "visits"} are canceled.`
              : "This appointment is canceled."}
            {data.shop.slug && (
              <Link
                href={`/book/${data.shop.slug}`}
                className="mt-2 block font-semibold text-offwhite underline"
              >
                Book a new time
              </Link>
            )}
          </div>
        ) : isDone ? (
          <p className="mt-6 text-center text-sm text-muted">
            Thanks for visiting {data.shop.name}!
          </p>
        ) : (
          <div className="mt-6 flex flex-col gap-2" data-tour="checkin">
            {nudges.length > 0 && (
              <NudgeBanner
                token={token}
                nudge={nudges[0]!}
                replied={data.nudgeReplied}
                checkedIn={checkinStatus !== null}
                onCheckedIn={() => setCheckinStatus("en_route")}
                demoMode={demoTour}
              />
            )}
            <CheckInCard
              token={token}
              checkin={checkin}
              status={checkinStatus}
              onStatus={setCheckinStatus}
              demoMode={demoTour}
            />
            {data.canReschedule && !demoTour && (
              <ReschedulePicker
                token={token}
                timezone={data.shop.timezone}
                currentStartsAt={data.startsAt}
                onMoved={(iso) => {
                  setMovedTo(iso);
                  setError(null);
                }}
              />
            )}
            {data.canCancel && !demoTour && (
              <button
                type="button"
                onClick={() => cancel("this")}
                disabled={pending}
                className="rounded-xl border border-red-500/40 py-3 text-center text-sm font-semibold text-red-400 disabled:opacity-50"
              >
                {pending ? "Canceling…" : laterVisits > 0 ? "Cancel just this visit" : "Cancel appointment"}
              </button>
            )}
            {data.canCancel && !demoTour && laterVisits > 0 && (
              <button
                type="button"
                onClick={() => cancel("future")}
                disabled={pending}
                className="rounded-xl border border-red-500/40 py-3 text-center text-sm font-semibold text-red-400 disabled:opacity-50"
              >
                {pending
                  ? "Canceling…"
                  : `Cancel this and the ${laterVisits} later ${laterVisits === 1 ? "visit" : "visits"}`}
              </button>
            )}
            {demoTour && (
              <p className="text-center text-[11px] text-muted">
                Cancel and reschedule live here too — parked during the demo.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * The barber's latest "come early" nudge, with one-tap answers. "On my way"
 * reuses the check-in flow (a nudge opens the check-in window early, server-
 * side); "Can't make it early" pushes the decline back to the barber. Both
 * settle into a quiet confirmation - no re-tap spam.
 */
function NudgeBanner({
  token,
  nudge,
  replied,
  checkedIn,
  onCheckedIn,
  demoMode = false,
}: {
  token: string;
  nudge: { body: string | null; sentAt: string };
  replied: boolean;
  checkedIn: boolean;
  onCheckedIn: () => void;
  /** Demo tour: answers settle locally, nothing is sent to the barber. */
  demoMode?: boolean;
}) {
  const [answer, setAnswer] = useState<"on_my_way" | "declined" | null>(
    checkedIn ? "on_my_way" : replied ? "declined" : null,
  );
  const [error, setError] = useState(false);
  const [pending, start] = useTransition();

  function onMyWay() {
    setError(false);
    if (demoMode) {
      setAnswer("on_my_way");
      onCheckedIn();
      return;
    }
    start(async () => {
      const res = await checkInAction(token);
      if (!res.ok) {
        setError(true);
        return;
      }
      setAnswer("on_my_way");
      onCheckedIn();
    });
  }
  function cantMakeIt() {
    setError(false);
    if (demoMode) {
      setAnswer("declined");
      return;
    }
    start(async () => {
      const res = await nudgeReplyAction(token);
      if (!res.ok) {
        setError(true);
        return;
      }
      setAnswer("declined");
    });
  }

  return (
    <div className="rounded-xl border border-gold/30 bg-gold/10 p-3">
      {/* Public page, outside any vocabulary provider - "your shop" is true for
          every vertical without plumbing a payload field in for two words. */}
      <p className="text-xs uppercase tracking-wide text-gold/80">
        From your shop
      </p>
      <p className="mt-1 text-sm text-offwhite">{nudge.body ?? "Come early if you can"}</p>
      {answer === "on_my_way" ? (
        <p role="status" className="mt-2 text-xs font-semibold text-emerald-300">
          You&apos;re marked on the way ✓
        </p>
      ) : answer === "declined" ? (
        <p role="status" className="mt-2 text-xs font-semibold text-muted">
          Got it - they&apos;ll expect you at the original time.
        </p>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onMyWay}
            disabled={pending}
            className="flex-1 rounded-lg bg-emerald-500 py-2 text-xs font-semibold text-black disabled:opacity-50"
          >
            On my way
          </button>
          <button
            type="button"
            onClick={cantMakeIt}
            disabled={pending}
            className="flex-1 rounded-lg border border-white/20 py-2 text-xs font-semibold text-offwhite disabled:opacity-50"
          >
            Can&apos;t make it early
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          Couldn&apos;t send that - try again.
        </p>
      )}
    </div>
  );
}

/**
 * "On my way" check-in. Renders only inside the tap window (open computed
 * server-side: 60 min before start through 15 min after) or once already
 * checked in. One-way: after the tap the button becomes a confirmation and the
 * optional ETA chips appear - no toggle-off, no spam (the API collapses repeat
 * pushes under one notification tag).
 */
function CheckInCard({
  token,
  checkin,
  status,
  onStatus,
  demoMode = false,
}: {
  token: string;
  checkin: ManageData["checkin"];
  status: ManageData["checkin"]["status"];
  onStatus: (s: "en_route") => void;
  /** Demo tour: taps flip the UI locally, nothing is sent to the barber. */
  demoMode?: boolean;
}) {
  const [eta, setEta] = useState<number | null>(checkin.etaMinutes);
  const [late, setLate] = useState(checkin.runningLate);
  const [error, setError] = useState(false);
  const [pending, start] = useTransition();

  if (!checkin.open && status === null) return null;

  if (status === "arrived") {
    return (
      <div
        role="status"
        className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 py-3 text-center text-sm font-semibold text-emerald-300"
      >
        You&apos;re checked in ✓
      </div>
    );
  }

  function tap(opts?: { etaMinutes?: 5 | 10 | 15; runningLate?: boolean }) {
    setError(false);
    if (demoMode) {
      onStatus("en_route");
      setEta(opts?.etaMinutes ?? null);
      setLate(opts?.runningLate ?? false);
      return;
    }
    start(async () => {
      const res = await checkInAction(token, opts);
      if (!res.ok) {
        setError(true);
        return;
      }
      onStatus("en_route");
      setEta(opts?.etaMinutes ?? null);
      setLate(opts?.runningLate ?? false);
    });
  }

  if (status === null) {
    return (
      <div>
        <button
          type="button"
          onClick={() => tap()}
          disabled={pending}
          className="w-full rounded-xl bg-emerald-500 py-3 text-center text-sm font-semibold text-black disabled:opacity-50"
        >
          {pending ? "One sec…" : "On my way"}
        </button>
        {error && (
          <p role="alert" className="mt-2 text-center text-xs text-red-400">
            Couldn&apos;t send that - try again.
          </p>
        )}
      </div>
    );
  }

  // en_route: locked confirmation + optional ETA precision chips.
  const chips: { label: string; opts: { etaMinutes?: 5 | 10 | 15; runningLate?: boolean }; active: boolean }[] = [
    { label: "5 min", opts: { etaMinutes: 5 }, active: eta === 5 && !late },
    { label: "10 min", opts: { etaMinutes: 10 }, active: eta === 10 && !late },
    { label: "15 min", opts: { etaMinutes: 15 }, active: eta === 15 && !late },
    { label: "Running late", opts: { runningLate: true }, active: late },
  ];
  return (
    <div>
      <div
        role="status"
        className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 py-3 text-center text-sm font-semibold text-emerald-300"
      >
        You&apos;re marked on the way ✓
      </div>
      <div className="mt-2 flex gap-1.5">
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => tap(c.opts)}
            disabled={pending}
            aria-pressed={c.active}
            className={
              c.active
                ? "flex-1 rounded-lg border border-emerald-400/60 bg-emerald-400/20 px-1 py-1.5 text-[11px] font-semibold text-emerald-200"
                : "flex-1 rounded-lg border border-white/15 px-1 py-1.5 text-[11px] text-muted disabled:opacity-50"
            }
          >
            {c.label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-center text-xs text-red-400">
          Couldn&apos;t send that - try again.
        </p>
      )}
    </div>
  );
}

/**
 * One-tap reschedule: open the panel, pick a new time, done. The times come
 * from the manage token itself (same barber, same service), so this is a real
 * move — the appointment keeps its identity, its manage link, and its place in
 * the barber's calendar.
 *
 * It replaces an instruction to "book a new time and cancel this one", which
 * asked the customer to perform two operations in the correct order and
 * punished both mistakes: rebook-then-forget-to-cancel left a phantom booking
 * holding a slot the barber couldn't sell, and cancel-first surrendered the
 * original time with no guarantee the new one was still there.
 *
 * Slots are loaded lazily on open — most visitors come to check details or
 * tap "on my way", and a full availability sweep on every page view would be
 * wasted work.
 */
function ReschedulePicker({
  token,
  timezone,
  currentStartsAt,
  onMoved,
}: {
  token: string;
  timezone: string;
  currentStartsAt: string;
  onMoved: (startsAt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [timezone],
  );
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
      }),
    [timezone],
  );

  // Group by shop-local day so the list reads as a calendar rather than a wall
  // of timestamps. Insertion order is preserved (slots arrive sorted), so the
  // days come out chronological without a second sort.
  const byDay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const iso of slots ?? []) {
      if (iso === currentStartsAt) continue; // their current time isn't a move
      const key = dayFmt.format(new Date(iso));
      map.set(key, [...(map.get(key) ?? []), iso]);
    }
    return [...map.entries()];
  }, [slots, currentStartsAt, dayFmt]);

  function load() {
    setOpen(true);
    if (slots !== null || loading) return;
    setLoading(true);
    setErr(null);
    startTransition(async () => {
      const res = await rescheduleOptionsAction(token);
      setLoading(false);
      if (!res) {
        setErr("Couldn't load available times. Please try again.");
        return;
      }
      setSlots(res.slots);
    });
  }

  function move(iso: string) {
    setErr(null);
    setSelected(iso);
    startTransition(async () => {
      const res = await rescheduleBookingAction(token, iso);
      if (!res.ok) {
        setSelected(null);
        // slot_taken is the one error worth its own words: somebody booked it
        // in the seconds since the list rendered, and the fix is "pick another",
        // not "try again".
        setErr(
          res.error === "slot_taken"
            ? "That time was just taken. Please pick another."
            : "Couldn't move your appointment. Please try again or call the shop.",
        );
        // Re-pull availability so the taken slot disappears from the list.
        const fresh = await rescheduleOptionsAction(token);
        if (fresh) setSlots(fresh.slots);
        return;
      }
      setDone(iso);
      setOpen(false);
      onMoved(iso);
    });
  }

  if (done) {
    return (
      <p
        role="status"
        className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 py-3 text-center text-sm font-semibold text-emerald-300"
      >
        Moved — see you {timeFmt.format(new Date(done))} on{" "}
        {dayFmt.format(new Date(done))}.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={load}
        className="rounded-xl border border-white/20 py-3 text-center text-sm font-semibold transition-colors hover:bg-white/5"
      >
        Reschedule
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-white/15 bg-white/5 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Pick a new time</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border border-white/15 px-3 py-1 text-xs text-muted transition-colors hover:text-offwhite"
        >
          Close
        </button>
      </div>

      {err && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {err}
        </p>
      )}

      {loading && <p className="mt-3 text-xs text-muted">Loading times…</p>}

      {!loading && slots !== null && byDay.length === 0 && (
        <p className="mt-3 text-xs text-muted">
          No other openings right now. Call the shop and they&apos;ll sort you out.
        </p>
      )}

      <div className="mt-3 max-h-72 space-y-4 overflow-y-auto">
        {byDay.map(([day, times]) => (
          <div key={day}>
            <p className="text-[11px] uppercase tracking-wide text-muted">{day}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {times.map((iso) => (
                <button
                  key={iso}
                  type="button"
                  disabled={pending}
                  onClick={() => move(iso)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                    selected === iso
                      ? "border-gold bg-gold text-charcoal"
                      : "border-white/20 hover:bg-white/10"
                  }`}
                >
                  {selected === iso && pending ? "Moving…" : timeFmt.format(new Date(iso))}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
