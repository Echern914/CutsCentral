"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui/FormError";
import { cn } from "@/lib/cn";
import { bookOnChairBackAction, keepOwnLinkAction } from "../stepActions";

const option =
  "flex w-full flex-col items-start gap-1 rounded-2xl border border-subtle bg-charcoal-800/40 p-4 text-left transition-colors hover:border-gold/50 disabled:opacity-50";
const primary =
  "inline-flex h-11 items-center justify-center rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";

/**
 * Setup: how clients book. ChairBack's own booking first (what a shop leaving
 * Booksy or TheCut needs - its menu, hours and clients come across in the next
 * steps), then the calendars ChairBack connects to, then "keep my own link".
 */
export function BookingChoice({
  acuityHref,
  squareHref,
  connected,
  nextIfNative,
  nextIfLink,
  continueHref,
}: {
  acuityHref: string;
  /** Null when Square isn't offered. */
  squareHref: string | null;
  /** Already connected (came back after connecting): just continue. */
  connected: "Acuity" | "Square" | null;
  nextIfNative: string;
  nextIfLink: string;
  continueHref: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");

  async function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, next: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await fn();
      if (res.ok) router.push(next);
      else setError(res.error);
    } catch {
      setError("No answer from ChairBack. Check your connection and try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (connected) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-subtle p-6 text-center">
        <p className="text-sm text-emerald-soft">{connected} is connected.</p>
        <a href={continueHref} className={primary}>
          Continue
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="booking-choice">
      <button
        type="button"
        onClick={() => void run(bookOnChairBackAction, nextIfNative)}
        disabled={pending}
        className={cn(option, "border-gold/40")}
      >
        <span className="text-sm font-semibold text-offwhite">Clients book me on ChairBack</span>
        <span className="text-xs text-muted">
          Recommended. Your own booking page, reminders and rewards. Coming from Booksy or TheCut? Your menu, hours
          and clients come across in the next steps.
        </span>
      </button>

      <a href={acuityHref} className={option}>
        <span className="text-sm font-semibold text-offwhite">I use Acuity</span>
        <span className="text-xs text-muted">Keep booking there. ChairBack follows every visit for rewards and rebooking.</span>
      </a>

      {squareHref && (
        <a href={squareHref} className={option}>
          <span className="text-sm font-semibold text-offwhite">I use Square</span>
          <span className="text-xs text-muted">Keep booking there. ChairBack follows every visit for rewards and rebooking.</span>
        </a>
      )}

      {!linkOpen ? (
        <button type="button" onClick={() => setLinkOpen(true)} disabled={pending} className={option}>
          <span className="text-sm font-semibold text-offwhite">Keep my own booking link</span>
          <span className="text-xs text-muted">Vagaro, Fresha, a website… your page&apos;s Book button opens it.</span>
        </button>
      ) : (
        <form
          className="flex flex-col gap-2 rounded-2xl border border-gold/40 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => keepOwnLinkAction(url), nextIfLink);
          }}
        >
          <label className="text-sm font-semibold text-offwhite" htmlFor="own-link">
            Your booking link
          </label>
          <input
            id="own-link"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            className="h-11 w-full rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50"
          />
          <button type="submit" disabled={pending || !url.trim()} className={primary}>
            {pending ? "Saving…" : "Use this link"}
          </button>
        </form>
      )}

      <FormError className="text-sm">{error}</FormError>
    </div>
  );
}
