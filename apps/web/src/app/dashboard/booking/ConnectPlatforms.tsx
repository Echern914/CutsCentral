"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { disconnectAcuityAction, disconnectSquareAction } from "./actions";
import type { BookingShop, ConnectStatus } from "./page";

/**
 * The branded "How customers book" picker — a grid of platform cards (ChairBack
 * native, Acuity, Square, Link-out). Each shows a logo mark, a one-liner, a
 * Connect button or a "Connected ✓" badge, and the selected one is highlighted.
 * Selecting a card sets the shop's bookingMode (saved by the parent); connecting
 * Acuity/Square kicks off their OAuth.
 */

type Mode = BookingShop["bookingMode"];

interface PlatformCard {
  key: Mode;
  name: string;
  desc: string;
  Logo: () => JSX.Element;
  /** OAuth start URL (Acuity/Square); undefined = no connect step (native/link). */
  connectPath?: string;
}

export function ConnectPlatforms({
  mode,
  onPick,
  connect,
  apiBase,
}: {
  mode: Mode;
  onPick: (mode: Mode) => void;
  connect: ConnectStatus;
  apiBase: string;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const isConnected: Record<Mode, boolean> = {
    native: true, // always "ready" — it's us
    link: true,
    acuity: connect.acuityConnected,
    square: connect.squareConnected,
  };
  const isAvailable: Record<Mode, boolean> = {
    native: true,
    link: true,
    acuity: connect.acuityAvailable,
    square: connect.squareAvailable,
  };

  const cards: PlatformCard[] = [
    {
      key: "native",
      name: "ChairBack Booking",
      desc: "Take real bookings right here. No third party, no fees.",
      Logo: ChairBackMark,
    },
    {
      key: "acuity",
      name: "Acuity",
      desc: "Sync appointments from your Acuity Scheduling account.",
      Logo: AcuityMark,
      connectPath: "/api/acuity/oauth/start",
    },
    {
      key: "square",
      name: "Square Appointments",
      desc: "Sync your Square Appointments — loyalty earns automatically.",
      Logo: SquareMark,
      connectPath: "/api/square/oauth/start",
    },
    {
      key: "link",
      name: "Your own link",
      desc: "Send customers to any booking link (Booksy, Vagaro, your site…).",
      Logo: LinkMark,
    },
  ];

  function connectOAuth(path: string) {
    start(() => {
      // Full-page nav to the API OAuth start (it 302s to the provider). Not a
      // fetch — CSP + the redirect chain need a real navigation.
      window.location.href = `${apiBase}${path}`;
    });
  }

  function disconnect(mode: Mode, name: string) {
    if (
      !window.confirm(
        `Disconnect ${name}? New bookings will stop syncing. Your existing clients and visit history are kept, and you can reconnect anytime.`,
      )
    ) {
      return;
    }
    start(async () => {
      const action = mode === "acuity" ? disconnectAcuityAction : disconnectSquareAction;
      const r = await action();
      if (r.ok) {
        toast(`${name} disconnected.`, "success");
        router.refresh();
      } else {
        toast(r.error ?? `Couldn't disconnect ${name}.`, "error");
      }
    });
  }

  return (
    <Card className="p-5">
      <CardHeader
        title="How customers book"
        subtitle="Pick where your bookings come from. You can switch anytime."
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {cards.map((c) => {
          const selected = mode === c.key;
          const connected = isConnected[c.key];
          const available = isAvailable[c.key];
          const needsConnect = Boolean(c.connectPath) && !connected;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => available && onPick(c.key)}
              disabled={!available}
              className={cn(
                "group relative flex flex-col gap-3 rounded-2xl border p-4 text-left transition-all duration-200 ease-out",
                selected
                  ? "border-gold/60 bg-gold/10 ring-1 ring-gold/30"
                  : "border-subtle hover:border-subtle/80 hover:bg-charcoal-700",
                !available && "cursor-not-allowed opacity-50",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-charcoal-800 ring-1 ring-white/5">
                  <c.Logo />
                </div>
                {connected && c.connectPath ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
                    <Check /> Connected
                  </span>
                ) : selected ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-gold/20 px-2.5 py-1 text-xs font-medium text-gold">
                    <Check /> Active
                  </span>
                ) : null}
              </div>

              <div>
                <span className="block text-sm font-semibold text-offwhite">{c.name}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">
                  {!available
                    ? c.key === "square"
                      ? "Coming soon — Square isn't enabled on this platform yet."
                      : "Not available."
                    : c.desc}
                </span>
              </div>

              {needsConnect && available && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    connectOAuth(c.connectPath!);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      connectOAuth(c.connectPath!);
                    }
                  }}
                  className="mt-auto inline-flex w-fit items-center gap-1.5 rounded-full bg-gold px-3.5 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
                >
                  {pending ? "Opening…" : `Connect ${c.name.split(" ")[0]}`}
                </span>
              )}

              {/* Connected provider (Acuity/Square): offer reconnect + disconnect. */}
              {c.connectPath && connected && (
                <div className="mt-auto flex flex-wrap items-center gap-2">
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      connectOAuth(c.connectPath!);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        connectOAuth(c.connectPath!);
                      }
                    }}
                    className="inline-flex w-fit items-center rounded-full border border-subtle px-3 py-1.5 text-xs font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
                  >
                    Reconnect
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      disconnect(c.key, c.name.split(" ")[0]);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        disconnect(c.key, c.name.split(" ")[0]);
                      }
                    }}
                    className="inline-flex w-fit items-center rounded-full border border-rose-400/30 px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors duration-150 ease-out hover:bg-rose-500/10"
                  >
                    {pending ? "Working…" : "Disconnect"}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/* — Brand marks (inline SVG, theme-tinted; no external logo assets needed) — */

function ChairBackMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 3v8a3 3 0 003 3h6a3 3 0 003-3V3M6 21v-4m12 4v-4M4 17h16"
        stroke="#D4AF37"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AcuityMark() {
  // Acuity's brand is a teal/navy; use a neutral calendar-check tinted teal.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="17" rx="2" stroke="#1FB6C1" strokeWidth="2" />
      <path d="M3 9h18M8 2v4M16 2v4" stroke="#1FB6C1" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 14l2 2 4-4" stroke="#1FB6C1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SquareMark() {
  // Square's mark: a rounded square outline with an inner square.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="4" stroke="#E5E5E5" strokeWidth="2" />
      <rect x="9" y="9" width="6" height="6" rx="1.5" fill="#E5E5E5" />
    </svg>
  );
}

function LinkMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10 14a3.5 3.5 0 005 0l3-3a3.5 3.5 0 00-5-5l-1 1M14 10a3.5 3.5 0 00-5 0l-3 3a3.5 3.5 0 005 5l1-1"
        stroke="#A1A1AA"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
