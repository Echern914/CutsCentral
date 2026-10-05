"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { formatTipCents, tipDollarsToCents } from "@chairback/config/tips";
import { PaymentStep } from "../../[slug]/PaymentStep";
import { startTipAction, tipStatusAction } from "./actions";
import type { TipView } from "./page";

/**
 * LEAVE A TIP, after the visit, from the client's own appointment page.
 *
 * Pick 15/20/25% of the visit's price or type an amount, then pay with the
 * same card step the booking page uses (card, Link, and Apple Pay in a
 * browser). The SERVER decides everything that matters: whether the visit
 * may be tipped, which amounts are allowed, and the payment itself - this
 * component only asks and renders. Nothing is charged until the client
 * confirms in the card form, so every failure before that is honestly
 * "nothing was charged".
 *
 * Outcomes are inline (role=status / role=alert), never a toast.
 */

/** ChairBack gold - this page has no shop accent to borrow. */
const ACCENT = "#D4AF37";

type Open = Extract<TipView, { state: "open" }>;

function startError(error: string | undefined): string {
  switch (error) {
    case "tip_closed":
      return "Tipping has closed for this visit.";
    case "already_tipped":
      return "A tip for this visit has already been paid. Thank you!";
    case "tip_in_progress":
      return "Your tip is still being confirmed. Try again in a moment.";
    case "invalid_amount":
    case "invalid_input":
      return "Enter an amount from $1 to $200.";
    // Before the card form, no charge can have happened, whatever went wrong.
    default:
      return "Couldn't get your payment ready. Nothing was charged - try again.";
  }
}

export function TipCard({
  token,
  tip,
  shopName,
  focus,
}: {
  token: string;
  tip: TipView;
  shopName: string;
  /** Arrived from the "Leave a tip" link (?tip=1): bring the card into view. */
  focus: boolean;
}) {
  const [view, setView] = useState<TipView>(tip);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus && headingRef.current) {
      headingRef.current.scrollIntoView({ block: "center" });
      headingRef.current.focus();
    }
  }, [focus]);

  if (view.state === "paid") {
    return (
      <section className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-center" data-qa="tip-card">
        <p role="status" className="text-sm text-offwhite">
          Thank you! Your {formatTipCents(view.amountCents)} tip went to {shopName}.
        </p>
      </section>
    );
  }
  if (view.state === "refunded") {
    return (
      <section className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-center" data-qa="tip-card">
        <p className="text-sm text-muted">
          Your {formatTipCents(view.amountCents)} tip was refunded to you.
        </p>
      </section>
    );
  }
  if (view.state === "processing") {
    return (
      <section className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-center" data-qa="tip-card">
        <p role="status" className="text-sm text-muted">
          Your {formatTipCents(view.amountCents)} tip is processing. This page will show it once it clears.
        </p>
      </section>
    );
  }
  return (
    <OpenTip token={token} open={view} shopName={shopName} headingRef={headingRef} onSettled={setView} />
  );
}

function OpenTip({
  token,
  open,
  shopName,
  headingRef,
  onSettled,
}: {
  token: string;
  open: Open;
  shopName: string;
  headingRef: RefObject<HTMLHeadingElement>;
  onSettled: (view: TipView) => void;
}) {
  // A preset's cents, or null when the client is typing their own amount.
  // Nothing is chosen for them: a tip is optional, so it starts unpicked.
  const [preset, setPreset] = useState<number | null>(null);
  const [custom, setCustom] = useState(open.presets.length === 0);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pay, setPay] = useState<{ clientSecret: string; amountCents: number } | null>(null);
  const [confirming, setConfirming] = useState<"checking" | "slow" | null>(null);

  const typedCents = custom ? tipDollarsToCents(typed) : null;
  const amountCents = custom ? typedCents : preset;
  const inRange = amountCents !== null && amountCents >= open.minCents && amountCents <= open.maxCents;

  async function start() {
    if (pending) return;
    setError(null);
    if (!inRange || amountCents === null) {
      setError("Enter an amount from $1 to $200.");
      return;
    }
    setPending(true);
    try {
      let res: Awaited<ReturnType<typeof startTipAction>>;
      try {
        res = await startTipAction(token, amountCents);
      } catch {
        setError(startError(undefined));
        return;
      }
      if (res.ok && res.clientSecret) {
        setPay({ clientSecret: res.clientSecret, amountCents: res.amountCents ?? amountCents });
        return;
      }
      if (res.error === "already_tipped") {
        const status = await tipStatusAction(token).catch(() => null);
        if (status?.ok && status.tip && status.tip.state !== "open") {
          onSettled(status.tip);
          return;
        }
      }
      setError(startError(res.error));
    } finally {
      setPending(false);
    }
  }

  // The money is away: ask the SERVER (which asks Stripe) until it says so.
  async function confirm() {
    setConfirming("checking");
    const deadline = Date.now() + 25_000;
    for (;;) {
      const res = await tipStatusAction(token).catch(() => null);
      if (res?.ok && res.tip && res.tip.state !== "open") {
        onSettled(res.tip);
        return;
      }
      if (Date.now() >= deadline) {
        setConfirming("slow");
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  if (confirming === "checking") {
    return (
      <p role="status" className="mt-6 text-center text-sm text-muted" data-qa="tip-card">
        Received. Confirming your tip&hellip;
      </p>
    );
  }
  if (confirming === "slow") {
    return (
      <p role="status" className="mt-6 rounded-xl border border-subtle p-4 text-sm text-muted" data-qa="tip-card">
        <span className="font-medium text-offwhite">That went through.</span> We&rsquo;re still confirming it -
        refresh this page in a minute to see your tip.
      </p>
    );
  }

  return (
    <section className="mt-6 rounded-xl border border-gold/40 bg-gold/10 p-4" data-qa="tip-card">
      <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-offwhite">
        Leave a tip for {shopName}
      </h2>
      <p className="mt-1 text-sm text-muted">Optional. Your tip goes to {shopName}.</p>

      {pay ? (
        <div className="mt-4">
          <p className="mb-2 text-sm text-offwhite">
            Tip: <span className="font-semibold">{formatTipCents(pay.amountCents)}</span>{" "}
            <button
              type="button"
              onClick={() => setPay(null)}
              className="ml-1 text-xs font-medium text-muted underline"
            >
              Change amount
            </button>
          </p>
          <PaymentStep
            clientSecret={pay.clientSecret}
            amountLabel={formatTipCents(pay.amountCents)}
            intent="payment"
            accent={ACCENT}
            returnUrl={typeof window !== "undefined" ? window.location.href : ""}
            onPaid={() => void confirm()}
          />
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Tip amount">
            {open.presets.map((p) => (
              <button
                key={p.percent}
                type="button"
                aria-pressed={!custom && preset === p.cents}
                onClick={() => {
                  setCustom(false);
                  setPreset(p.cents);
                  setError(null);
                }}
                className={
                  !custom && preset === p.cents
                    ? "rounded-xl border border-gold/60 bg-gold/15 px-4 py-2 text-sm font-semibold text-offwhite"
                    : "rounded-xl border border-white/15 px-4 py-2 text-sm text-muted hover:text-offwhite"
                }
              >
                {p.percent}% · {formatTipCents(p.cents)}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={custom}
              onClick={() => {
                setCustom(true);
                setError(null);
              }}
              className={
                custom
                  ? "rounded-xl border border-gold/60 bg-gold/15 px-4 py-2 text-sm font-semibold text-offwhite"
                  : "rounded-xl border border-white/15 px-4 py-2 text-sm text-muted hover:text-offwhite"
              }
            >
              Other amount
            </button>
          </div>
          {custom && (
            <label className="mt-3 flex flex-col gap-1 text-sm text-muted">
              Tip amount ($1 to $200)
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="$"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError(null);
                }}
                className="h-11 rounded-xl border border-white/15 bg-black/20 px-3 text-base text-offwhite"
              />
            </label>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={pending || (!custom && preset === null)}
            onClick={() => void start()}
            className="mt-4 flex h-11 w-full items-center justify-center rounded-xl bg-gold px-5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
          >
            {pending
              ? "Getting your payment ready…"
              : inRange && amountCents !== null
                ? `Continue · ${formatTipCents(amountCents)}`
                : "Continue"}
          </button>
        </>
      )}
    </section>
  );
}
