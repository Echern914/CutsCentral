"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSignalNativeReady } from "@/lib/nativeReady";
import { useVisiblePoll } from "@/lib/useVisiblePoll";
import {
  lineExchangeAction,
  lineLeaveAction,
  lineStatusAction,
  type LineStatus,
} from "./actions";

/**
 * The customer's live view of their own spot - and ONLY their own spot.
 *
 * Bootstrap: the SMS credential arrives in the fragment, is exchanged once
 * for a bounded session, and the fragment is stripped from history. The
 * session lives in sessionStorage (this tab only) so a refresh doesn't dead-
 * end the page; the raw token is never persisted anywhere.
 *
 * The page POLLS - estimates are recomputed server-side every time and
 * clearly labeled estimates. A failed poll keeps the LAST known state on
 * screen with honest "trying to reconnect" wording; it never invents a
 * status change, and Leave-the-line only ever reflects what the server
 * confirmed.
 */

const POLL_MS = 15_000;
const SESSION_KEY = "cb_line_session";

const BTN =
  "flex min-h-12 w-full items-center justify-center rounded-xl px-5 text-base font-semibold transition-colors disabled:opacity-40";

type Phase = "boot" | "dead" | "live";

const STATUS_COPY: Record<string, { title: string; body: string }> = {
  WAITING: {
    title: "You're in line",
    body: "Stay close - we'll move you up as chairs free up.",
  },
  ASSIGNED: {
    title: "You've got a chair coming",
    body: "A barber has picked you up. Hang tight nearby.",
  },
  READY: {
    title: "Your barber is ready! 💈",
    body: "Head to the front - you're up right now.",
  },
  IN_SERVICE: {
    title: "You're in the chair",
    body: "Enjoy the cut.",
  },
  COMPLETED: {
    title: "All done - thanks for coming in!",
    body: "This link has done its job.",
  },
  LEFT: {
    title: "You left the line",
    body: "Changed your mind? Check in again at the shop's kiosk.",
  },
  NO_SHOW: {
    title: "We couldn't find you",
    body: "Your spot was released. Check in again at the kiosk any time.",
  },
  CANCELED: {
    title: "Your spot was removed",
    body: "Ask at the front desk if that's a surprise.",
  },
  EXPIRED: {
    title: "This visit has ended for today",
    body: "Check in again next time you're in.",
  },
};

export function LineClient() {
  useSignalNativeReady();

  const [phase, setPhase] = useState<Phase>("boot");
  const [session, setSession] = useState<string | null>(null);
  const [status, setStatus] = useState<LineStatus | null>(null);
  const [staleSince, setStaleSince] = useState<Date | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = session;

  // Bootstrap: fragment -> one-time exchange -> session; strip the fragment
  // from the URL AND history so the raw credential doesn't linger there.
  useEffect(() => {
    const boot = async () => {
      const m = /[#&]t=([^&]+)/.exec(window.location.hash);
      if (m) {
        window.history.replaceState(null, "", window.location.pathname);
        const res = await lineExchangeAction(m[1]!);
        if (res.ok && res.data) {
          sessionStorage.setItem(SESSION_KEY, res.data.session);
          setSession(res.data.session);
          setPhase("live");
          return;
        }
        // fall through: maybe an older exchange in this tab still works
      }
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        setSession(stored);
        setPhase("live");
        return;
      }
      setPhase("dead");
    };
    void boot();
  }, []);

  const refresh = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    const res = await lineStatusAction(s);
    if (res.ok && res.data) {
      setStatus(res.data);
      setStaleSince(null);
      return;
    }
    if (res.status === 404) {
      // Rotated, expired, or cleaned up - the link is genuinely done.
      sessionStorage.removeItem(SESSION_KEY);
      setPhase("dead");
      return;
    }
    // Network trouble: keep what we know, say so, keep trying.
    setStaleSince((prev) => prev ?? new Date());
  }, []);

  useEffect(() => {
    if (phase === "live") void refresh();
  }, [phase, refresh]);
  useVisiblePoll(refresh, POLL_MS, phase === "live");

  const leave = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || leaving) return;
    setLeaving(true);
    const res = await lineLeaveAction(s);
    setLeaving(false);
    setConfirmLeave(false);
    if (res.ok && res.data) {
      // Reflect ONLY what the server confirmed.
      setStatus((prev) => (prev ? { ...prev, status: res.data!.status } : prev));
      void refresh();
    } else if (res.status === 404) {
      sessionStorage.removeItem(SESSION_KEY);
      setPhase("dead");
    } else {
      setStaleSince((prev) => prev ?? new Date());
    }
  }, [leaving, refresh]);

  if (phase === "boot") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
        <p className="text-center text-muted">One moment…</p>
      </main>
    );
  }
  if (phase === "dead") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-5 py-10 text-offwhite">
        <h1 className="text-center text-2xl font-bold">This link isn't active</h1>
        <p className="text-center text-muted">
          It may have expired or been replaced by a newer text. Check your
          latest message, or check in again at the shop.
        </p>
      </main>
    );
  }

  const copy = status ? (STATUS_COPY[status.status] ?? STATUS_COPY.WAITING!) : null;
  const active =
    status &&
    ["WAITING", "ASSIGNED", "READY", "IN_SERVICE"].includes(status.status);
  const isNext = status?.ahead === 0 && status.status === "WAITING";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-5 overflow-x-hidden px-5 py-10 text-offwhite">
      {status ? (
        <>
          <p className="text-center text-sm uppercase tracking-wide text-muted">
            {status.shopName}
          </p>
          <h1 className="text-center text-3xl font-bold">
            {isNext ? "You're next!" : copy!.title}
          </h1>
          <p className="text-center text-muted">{copy!.body}</p>

          {active ? (
            <div className="rounded-2xl border border-subtle bg-charcoal-800/40 p-5 text-center">
              {status.ahead !== null && status.status === "WAITING" ? (
                <p className="text-lg">
                  <strong>{status.ahead}</strong>{" "}
                  {status.ahead === 1 ? "person" : "people"} ahead of you
                </p>
              ) : null}
              <p className="mt-1 text-lg">
                {status.waitMin !== null ? (
                  <>
                    Estimated wait about <strong>{status.waitMin} min</strong>
                  </>
                ) : status.status === "IN_SERVICE" ? (
                  "In progress"
                ) : (
                  "Estimate unavailable right now - you're still in line"
                )}
              </p>
              <p className="mt-2 text-sm text-muted">
                {status.services.map((s) => s.name).join(" + ")}
                {status.barberName
                  ? ` · ${status.barberIsAssigned ? "with" : "waiting for"} ${status.barberName}`
                  : ""}
              </p>
              <p className="mt-2 text-xs text-muted">
                Estimates change as the day moves. Updated{" "}
                {new Date(status.updatedAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
                .
              </p>
            </div>
          ) : null}

          {staleSince ? (
            <p role="status" className="text-center text-sm text-danger-soft">
              Having trouble reaching the shop - showing your last update and
              retrying. You have NOT lost your spot.
            </p>
          ) : null}

          {active && status.status !== "IN_SERVICE" ? (
            confirmLeave ? (
              <div className="flex flex-col gap-2">
                <p className="text-center text-sm text-muted">
                  Leave the line? Your spot goes to the next person.
                </p>
                <button
                  type="button"
                  className={`${BTN} bg-danger text-offwhite`}
                  disabled={leaving}
                  onClick={() => void leave()}
                >
                  {leaving ? "Leaving…" : "Yes, leave the line"}
                </button>
                <button
                  type="button"
                  className={`${BTN} border border-subtle bg-charcoal-800/60`}
                  onClick={() => setConfirmLeave(false)}
                >
                  Stay in line
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`${BTN} border border-subtle bg-charcoal-800/60 text-muted`}
                onClick={() => setConfirmLeave(true)}
              >
                Leave the line
              </button>
            )
          ) : null}
        </>
      ) : (
        <p className="text-center text-muted">
          {staleSince
            ? "Having trouble reaching the shop - retrying…"
            : "Loading your spot…"}
        </p>
      )}
    </main>
  );
}
