"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useSignalNativeReady } from "@/lib/nativeReady";
import type { ManageData } from "./page";
import { cancelBookingAction, checkInAction } from "./actions";

/**
 * Customer self-service for a single booking (auth = the manage token in the
 * URL). Shows the appointment and lets the customer cancel. Reschedule is a
 * cancel-and-rebook link to the shop's booking page - the booking funnel there
 * is the single source of truth for picking a new open slot.
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

  const [canceled, setCanceled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
  const when = whenFmt.format(new Date(data.startsAt));

  function cancel() {
    setError(null);
    startTransition(async () => {
      const res = await cancelBookingAction(token);
      if (!res.ok) {
        setError("Couldn't cancel. Please try again or call the shop.");
        return;
      }
      setCanceled(true);
    });
  }

  const isCanceled = canceled || data.status === "CANCELED";
  const isDone = data.status === "COMPLETED" || data.status === "NO_SHOW";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
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

        {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

        {isCanceled ? (
          <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-muted">
            This appointment is canceled.
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
          <div className="mt-6 flex flex-col gap-2">
            <CheckInCard token={token} checkin={data.checkin} />
            {data.canReschedule && data.shop.slug && (
              <Link
                href={`/book/${data.shop.slug}`}
                className="rounded-xl border border-white/20 py-3 text-center text-sm font-semibold"
              >
                Reschedule (pick a new time)
              </Link>
            )}
            {data.canCancel && (
              <button
                type="button"
                onClick={cancel}
                disabled={pending}
                className="rounded-xl border border-red-500/40 py-3 text-center text-sm font-semibold text-red-400 disabled:opacity-50"
              >
                {pending ? "Canceling…" : "Cancel appointment"}
              </button>
            )}
            {data.canReschedule && (
              <p className="text-center text-[11px] text-muted">
                To reschedule, book a new time and cancel this one.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
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
}: {
  token: string;
  checkin: ManageData["checkin"];
}) {
  const [status, setStatus] = useState(checkin.status);
  const [eta, setEta] = useState<number | null>(checkin.etaMinutes);
  const [late, setLate] = useState(checkin.runningLate);
  const [error, setError] = useState(false);
  const [pending, start] = useTransition();

  if (!checkin.open && status === null) return null;

  if (status === "arrived") {
    return (
      <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 py-3 text-center text-sm font-semibold text-emerald-300">
        You&apos;re checked in ✓
      </div>
    );
  }

  function tap(opts?: { etaMinutes?: 5 | 10 | 15; runningLate?: boolean }) {
    setError(false);
    start(async () => {
      const res = await checkInAction(token, opts);
      if (!res.ok) {
        setError(true);
        return;
      }
      setStatus("en_route");
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
          <p className="mt-2 text-center text-xs text-red-400">
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
      <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 py-3 text-center text-sm font-semibold text-emerald-300">
        You&apos;re marked on the way ✓
      </div>
      <div className="mt-2 flex gap-1.5">
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => tap(c.opts)}
            disabled={pending}
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
        <p className="mt-2 text-center text-xs text-red-400">
          Couldn&apos;t send that - try again.
        </p>
      )}
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
