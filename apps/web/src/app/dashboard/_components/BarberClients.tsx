"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import {
  getBarberClientsAction,
  sendBarberRewardsLinkAction,
  type BarberClientsData,
} from "./barberClientActions";

/**
 * "Your clients" on the barber home screen: the people this chair has served
 * (or has on the books), searchable, each with one action - text them their
 * rewards link. The list is derived and scoped SERVER-side from the seat's
 * chair; phones arrive masked. Renders nothing until the seat actually has
 * clients - a new barber's home screen stays quiet.
 */

const COLLAPSED_COUNT = 6;

/** Barber-facing copy per refusal code - short, actionable, no internals. */
const SEND_ERROR_COPY: Record<string, string> = {
  too_soon: "Just sent - wait a few minutes.",
  too_many_today: "Hit today's text limit.",
  opted_out: "Opted out of texts.",
  no_consent: "No text opt-in yet.",
  no_phone: "No mobile number on file.",
  send_failed: "Couldn't send. Try again.",
};

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; copy: string };

export function BarberClients() {
  const [data, setData] = useState<BarberClientsData | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [sends, setSends] = useState<Record<string, SendState>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (q: string) => {
    const res = await getBarberClientsAction(q || undefined);
    if (res.ok && res.data) setData(res.data);
    // Network trouble: keep the last list silently.
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const onQuery = useCallback(
    (q: string) => {
      setQuery(q);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void load(q), 300);
    },
    [load],
  );

  const send = useCallback((clientId: string) => {
    setSends((s) => ({ ...s, [clientId]: { kind: "sending" } }));
    void (async () => {
      const res = await sendBarberRewardsLinkAction(clientId);
      setSends((s) => ({
        ...s,
        [clientId]: res.ok
          ? { kind: "sent" }
          : {
              kind: "error",
              copy: SEND_ERROR_COPY[res.error ?? ""] ?? SEND_ERROR_COPY.send_failed!,
            },
      }));
    })();
  }, []);

  // No chair, nothing loaded yet, or an empty clientele with no search under
  // way: stay off the screen entirely.
  if (!data || data.reason === "no_chair_linked") return null;
  if (data.clients.length === 0 && query === "") return null;

  const visible =
    expanded || query !== "" ? data.clients : data.clients.slice(0, COLLAPSED_COUNT);
  const hiddenCount = data.clients.length - visible.length;

  const lastSeenFmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  });

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="border-b border-subtle px-5 py-4">
        <h2 className="font-display text-lg">Your clients</h2>
        <p className="text-xs text-muted">
          People your chair has served. Lost rewards link? Text it in one tap.
        </p>
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search your clients"
          aria-label="Search your clients"
          className="mt-3 h-11 w-full rounded-full border border-subtle bg-charcoal-800 px-4 text-base text-offwhite placeholder:text-muted focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/40"
        />
      </div>

      {visible.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-muted">
          No one matches that search.
        </p>
      ) : (
        <ul
          className={`divide-y divide-[rgba(245,245,244,0.08)] ${
            expanded || query !== "" ? "max-h-96 overflow-y-auto" : ""
          }`}
        >
          {visible.map((c) => {
            const state = sends[c.id] ?? { kind: "idle" };
            return (
              <li key={c.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-offwhite">{c.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {[
                      c.maskedPhone,
                      c.lastSeen
                        ? `last seen ${lastSeenFmt.format(new Date(c.lastSeen))}`
                        : null,
                      `${c.visits} visit${c.visits === 1 ? "" : "s"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {state.kind === "error" && (
                    <p className="mt-0.5 text-xs text-danger-soft">{state.copy}</p>
                  )}
                  {!c.textable && (
                    <p className="mt-0.5 text-xs text-muted">
                      {SEND_ERROR_COPY[c.reason ?? ""] ?? ""}
                    </p>
                  )}
                </div>
                {c.textable && (
                  <button
                    type="button"
                    disabled={state.kind === "sending" || state.kind === "sent"}
                    onClick={() => send(c.id)}
                    className="flex h-11 shrink-0 items-center justify-center rounded-full border border-gold/40 px-4 text-xs font-semibold text-gold transition-colors hover:bg-gold/10 disabled:opacity-50"
                  >
                    {state.kind === "sending"
                      ? "Sending…"
                      : state.kind === "sent"
                        ? "Sent ✓"
                        : "Text link"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full border-t border-subtle px-5 py-3 text-center text-xs font-semibold text-gold hover:bg-gold/5"
        >
          Show all ({data.clients.length})
        </button>
      )}
    </Card>
  );
}
