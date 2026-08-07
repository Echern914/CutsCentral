"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { HELP_STARTERS, type HelpAnswer } from "@chairback/config/help";
import { findHelp, helpAnswerById, type HelpResponse } from "@chairback/config/helpMatch";
import { useIsNativeApp } from "@/lib/useIsNativeApp";

/**
 * The help bubble: a corner launcher that answers product questions instantly.
 *
 * Answers come from the curated corpus in @chairback/config/help, matched
 * locally — no network call, no API cost, and nothing that can invent a price
 * or a policy we don't ship. `findHelp` guarantees a useful reply for ANY
 * input, so this component has no "I didn't understand" state to render.
 *
 * DELIBERATELY NO TYPING INDICATOR. Matching takes about a millisecond, and
 * faking a pause to seem more human would be spending the one advantage this
 * approach has. The answer is simply there.
 *
 * It is scoped to the OWNER's surfaces (marketing + dashboard). The public
 * client pages are excluded — see HIDDEN_PREFIXES.
 */

const SUPPORT_EMAIL = "support@getchairback.com";

/**
 * Client-facing routes. A barber's shop page belongs to the SHOP, and a
 * ChairBack support bubble sitting on it would answer a haircut client's
 * questions with dashboard instructions. /demo and the tour surfaces are
 * excluded because they run their own full-screen overlay.
 */
const HIDDEN_PREFIXES = ["/s/", "/r/", "/book", "/demo", "/welcome", "/team/join"];

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "bot"; text?: string; response?: HelpResponse };

export function HelpBubble() {
  const pathname = usePathname() ?? "/";
  const inApp = useIsNativeApp();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  // Portals need a DOM; SSR has none. Same mounted gate FeatureSearch uses.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const nextId = useRef(0);

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // The dashboard's floating tab pill owns the bottom-right corner on phones,
  // so the launcher has to clear it (pill is ~3.6rem tall, floating 0.625rem
  // above the safe-area inset). From `sm` up the pill is hidden and the
  // launcher drops back down. See DashboardNav.tsx.
  const onDashboard = pathname.startsWith("/dashboard");

  const hidden = HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // `inApp === null` means "not yet known" (pre-hydration). Treat it as the
      // browser, matching useIsNativeApp's documented contract — by the time
      // anyone has typed, the effect has long since resolved.
      const response = findHelp(trimmed, { inApp: inApp === true });
      setMessages((prev) => [
        ...prev,
        { id: nextId.current++, role: "user", text: trimmed },
        { id: nextId.current++, role: "bot", response },
      ]);
      setQuery("");
    },
    [inApp],
  );

  /** A suggestion chip: show the canonical question, then answer it exactly. */
  const openAnswer = useCallback((answer: HelpAnswer) => {
    setMessages((prev) => [
      ...prev,
      { id: nextId.current++, role: "user", text: answer.q },
      {
        id: nextId.current++,
        role: "bot",
        response: { kind: "answer", answer, suggestions: [] },
      },
    ]);
  }, []);

  // Greet on first open so the panel is never an empty box with a cursor.
  useEffect(() => {
    if (!open || messages.length > 0) return;
    setMessages([
      {
        id: nextId.current++,
        role: "bot",
        text: "Hey! Ask me anything about ChairBack — setup, pricing, bookings, texts, whatever you're stuck on. You'll get an answer straight away.",
      },
    ]);
  }, [open, messages.length]);

  // Esc closes from anywhere while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const t = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(t);
    }
    // Restore focus to the launcher on close (WCAG 2.4.3), but only after a
    // real open/close cycle rather than on mount.
    if (wasOpen.current) {
      wasOpen.current = false;
      launcherRef.current?.focus();
    }
  }, [open]);

  // Scroll the newest QUESTION to the top, not the transcript to its bottom.
  // Jumping to the bottom of a long answer lands the barber halfway through it,
  // past the very paragraph they asked for; anchoring on the question shows
  // "what I asked" followed by the answer beginning, which is what you want to
  // read. Falls back to the top for the greeting, which has no question above it.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const asks = el.querySelectorAll<HTMLElement>("[data-ask]");
    const last = asks[asks.length - 1];
    el.scrollTop = last ? Math.max(0, last.offsetTop - 8) : 0;
  }, [messages]);

  // Modal focus trap: Tab cycles inside the panel (aria-modal contract).
  function trapTab(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const root = panelRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const starters = useMemo(() => {
    // Starter chips must obey the same 3.1.1 filter as the corpus, or the very
    // first thing the app shows is a tap straight into plan pricing.
    return HELP_STARTERS.map((q) => findHelp(q, { inApp: inApp === true }))
      .map((r) => r.answer)
      .filter((a): a is HelpAnswer => a !== null)
      .slice(0, 5);
  }, [inApp]);

  if (hidden) return null;

  const launcherOffset = onDashboard
    ? "bottom-[calc(4.9rem+env(safe-area-inset-bottom))] sm:bottom-[calc(1.25rem+env(safe-area-inset-bottom))]"
    : "bottom-[calc(1.25rem+env(safe-area-inset-bottom))]";

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close help" : "Open help"}
        aria-expanded={open}
        title="Help"
        className={`fixed right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-gold text-charcoal shadow-ambient-lg transition-transform duration-150 ease-out hover:scale-105 focus-visible:ring-2 focus-visible:ring-offwhite focus-visible:ring-offset-2 focus-visible:ring-offset-charcoal ${launcherOffset}`}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>

      {/* Portaled for the same reason FeatureSearch is: any ancestor with a
          filter/backdrop-filter (the dashboard's `glass` nav) becomes the
          containing block for position:fixed descendants, and the panel would
          resolve against that instead of the viewport. */}
      {open && mounted &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Help"
            onKeyDown={trapTab}
            /* Phones: a near-fullscreen sheet. From `sm` up: a corner panel
               parked ABOVE the launcher (3.5rem tall + gap) rather than on top
               of it, so the toggle stays visible and clickable the whole time. */
            className="glass fixed inset-x-3 bottom-[calc(1rem+env(safe-area-inset-bottom))] top-16 z-40 flex flex-col overflow-hidden rounded-2xl shadow-2xl sm:inset-x-auto sm:right-4 sm:top-auto sm:bottom-[calc(5.5rem+env(safe-area-inset-bottom))] sm:h-[min(32rem,calc(100vh-11rem))] sm:w-[24rem]"
          >
            <header className="flex items-start justify-between gap-3 border-b border-subtle px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-offwhite">Help</p>
                <p className="text-xs text-muted">Instant answers — no waiting</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close help"
                className="shrink-0 rounded-full border border-subtle p-1.5 text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </header>

            <div
              ref={transcriptRef}
              // `relative` makes this the offsetParent, so the scroll effect can
              // read a message's offsetTop directly against the scroll box.
              className="relative flex-1 space-y-3 overflow-y-auto px-4 py-4"
              // Answers are injected without moving focus, so screen readers
              // need them announced (WCAG 4.1.3).
              aria-live="polite"
              aria-atomic="false"
            >
              {messages.map((m) =>
                m.role === "user" ? (
                  <UserBubble key={m.id} text={m.text} />
                ) : (
                  <BotBubble
                    key={m.id}
                    text={m.text}
                    response={m.response}
                    onPick={openAnswer}
                    onNavigate={(href) => {
                      setOpen(false);
                      router.push(href);
                    }}
                  />
                ),
              )}

              {messages.length <= 1 && starters.length > 0 && (
                <div className="pt-1">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Common questions
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {starters.map((s) => (
                      <Chip key={s.id} label={s.q} onClick={() => openAnswer(s)} />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(query);
              }}
              className="flex items-center gap-2 border-t border-subtle px-3 py-2.5"
            >
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask a question…"
                aria-label="Ask a question"
                className="w-full rounded-lg bg-transparent px-1 py-1.5 text-sm text-offwhite placeholder:text-muted focus-visible:outline-none"
              />
              <button
                type="submit"
                disabled={query.trim().length === 0}
                aria-label="Send question"
                className="shrink-0 rounded-full bg-gold p-2 text-charcoal transition-opacity duration-150 ease-out disabled:opacity-40"
              >
                <SendIcon />
              </button>
            </form>
          </div>,
          document.body,
        )}
    </>
  );
}

/* ================================ pieces ================================= */

function UserBubble({ text }: { text: string }) {
  return (
    // data-ask is the scroll anchor — see the transcript effect.
    <div data-ask className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-gold/15 px-3 py-2 text-sm text-offwhite">
        {text}
      </p>
    </div>
  );
}

function BotBubble({
  text,
  response,
  onPick,
  onNavigate,
}: {
  text?: string;
  response?: HelpResponse;
  onPick: (a: HelpAnswer) => void;
  onNavigate: (href: string) => void;
}) {
  const answer = response?.answer ?? null;
  const suggestions = response?.suggestions ?? [];
  const body = answer?.a ?? text ?? "";

  return (
    <div className="flex flex-col items-start gap-2">
      {body && (
        <div className="max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm bg-charcoal-700/70 px-3 py-2">
          {body.split("\n\n").map((para, i) => (
            <p key={i} className="whitespace-pre-line text-sm leading-relaxed text-offwhite">
              {para}
            </p>
          ))}
        </div>
      )}

      {answer?.action && (
        <button
          type="button"
          onClick={() => onNavigate(answer.action!.href)}
          className="rounded-full border border-gold/40 px-3 py-1 text-xs font-semibold text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
        >
          {answer.action.label} →
        </button>
      )}

      {/* The no-dead-end branch: we weren't confident, so say so plainly and
          hand over the closest topics plus a real person. Never a shrug. */}
      {response && response.kind === "suggestions" && (
        <div className="max-w-[92%] space-y-2">
          <p className="text-sm leading-relaxed text-offwhite">
            I don&apos;t have that one written up exactly. Here&apos;s the closest — or email a
            human and we&apos;ll answer it properly.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <Chip key={s.id} label={s.q} onClick={() => onPick(s)} />
            ))}
          </div>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="inline-block text-xs font-semibold text-gold underline underline-offset-2"
          >
            Email {SUPPORT_EMAIL}
          </a>
        </div>
      )}

      {/* Confident answer, but there were near-misses worth offering. */}
      {response?.kind === "answer" && suggestions.length > 0 && (
        <div className="max-w-[92%]">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Related
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <Chip key={s.id} label={s.q} onClick={() => onPick(s)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-subtle px-2.5 py-1 text-left text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
    >
      {label}
    </button>
  );
}

/* ================================= icons ================================= */

function ChatIcon() {
  return (
    <svg
      className="h-6 w-6"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
  );
}

function CloseIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m22 2-7 20-4-9-9-4Z" />
    </svg>
  );
}
