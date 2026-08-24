"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { claimOfferAction } from "./actions";

export interface OfferView {
  shopName: string;
  timezone: string;
  serviceName: string | null;
  staffName: string | null;
  startsAt: string;
  expiresAt: string;
  firstName: string;
  email: string | null;
  /** Approval-mode shop: the tap submits a REQUEST the shop still confirms. */
  approvalRequired: boolean;
}

/**
 * The claim screen: shows the held time, counts the hold down, and books on a
 * single deliberate tap. Renders exactly one generic card for every dead link
 * (unknown, expired, released, already used) - the page must never leak
 * whether a token WAS valid once, or whose it was.
 */
export function ClaimOffer({
  token,
  offer,
}: {
  token: string;
  offer: OfferView | null;
}) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "done"; startsAt: string; pending: boolean }
    | { phase: "expired" }
    | { phase: "gone" }
    | { phase: "deposit" }
    | { phase: "error" }
  >({ phase: "idle" });
  const [email, setEmail] = useState(offer?.email ?? "");
  const [pending, start] = useTransition();
  const [msLeft, setMsLeft] = useState(() =>
    offer ? new Date(offer.expiresAt).getTime() - Date.now() : 0,
  );

  // The countdown is UX, not enforcement (the server refuses a lapsed token
  // regardless) - but flipping the card at zero saves a doomed tap.
  useEffect(() => {
    if (!offer) return;
    const t = setInterval(
      () => setMsLeft(new Date(offer.expiresAt).getTime() - Date.now()),
      1000,
    );
    return () => clearInterval(t);
  }, [offer]);

  const when = useMemo(() => {
    if (!offer) return "";
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: offer.timezone,
    }).format(new Date(offer.startsAt));
  }, [offer]);

  if (!offer || state.phase === "expired" || (state.phase === "idle" && msLeft <= 0)) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <h1 className="font-display text-2xl">This hold has ended</h1>
        <p className="mt-2 text-sm text-muted">
          Held spots are only saved for 30 minutes, so this link is no longer
          active — the time may have been offered to the next person in line.
          You&rsquo;re welcome to book normally or rejoin the waitlist.
        </p>
      </div>
    );
  }

  if (state.phase === "done") {
    // Approval-mode shops confirm requests themselves - never tell the
    // customer they're booked when the shop still has to say yes.
    return state.pending ? (
      <div role="status" className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <h1 className="font-display text-2xl">Request sent &#10003;</h1>
        <p className="mt-2 text-sm text-muted">
          Your appointment request for {when} was submitted &mdash;{" "}
          {offer.shopName} confirms requests before they&rsquo;re final, and
          you&rsquo;ll hear back once they do.
        </p>
      </div>
    ) : (
      <div role="status" className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <h1 className="font-display text-2xl">You&rsquo;re booked &#10003;</h1>
        <p className="mt-2 text-sm text-muted">
          {when} at {offer.shopName} is yours. A confirmation email with a
          manage link is on its way{email.trim() ? ` to ${email.trim()}` : ""}.
        </p>
      </div>
    );
  }

  if (state.phase === "deposit") {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <h1 className="font-display text-2xl">This one needs a deposit</h1>
        <p className="mt-2 text-sm text-muted">
          {offer.shopName} now takes a deposit for this service, so this hold
          link can&rsquo;t finish the booking. You&rsquo;re still on the
          waitlist &mdash; book through their page to pay the deposit and lock
          a time in.
        </p>
      </div>
    );
  }

  if (state.phase === "gone") {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <h1 className="font-display text-2xl">That time just got taken</h1>
        <p className="mt-2 text-sm text-muted">
          The shop&rsquo;s calendar changed before you could book. Nothing was
          charged and you&rsquo;re still on the waitlist for the next opening.
        </p>
      </div>
    );
  }

  const mins = Math.max(0, Math.floor(msLeft / 60000));
  const secs = Math.max(0, Math.floor((msLeft % 60000) / 1000));

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
      <h1 className="font-display text-2xl">
        {offer.firstName ? `${offer.firstName}, this` : "This"} spot is yours
      </h1>
      <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
        <p className="text-sm font-semibold text-offwhite">{when}</p>
        <p className="mt-1 text-xs text-muted">
          {offer.serviceName ?? "Appointment"}
          {offer.staffName ? ` with ${offer.staffName}` : ""} at {offer.shopName}
        </p>
      </div>
      <p className="mt-3 text-xs text-muted" role="timer" aria-live="off">
        Held for you for another {mins}:{String(secs).padStart(2, "0")} — after
        that it goes to the next person in line.
      </p>
      {offer.approvalRequired && (
        <p className="mt-2 text-xs text-muted">
          {offer.shopName} confirms appointment requests before they&rsquo;re
          final — this sends yours in with the time reserved.
        </p>
      )}
      <label className="mt-4 block text-xs text-muted">
        Email for your confirmation
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-offwhite placeholder:text-muted focus:border-white/40"
        />
      </label>
      {state.phase === "error" && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          Something went wrong — please try again.
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        aria-busy={pending}
        onClick={() =>
          start(async () => {
            const res = await claimOfferAction(token, { email });
            if (res.ok)
              setState({ phase: "done", startsAt: res.startsAt, pending: res.pending });
            else if (res.reason === "expired") setState({ phase: "expired" });
            else if (res.reason === "gone") setState({ phase: "gone" });
            else if (res.reason === "deposit") setState({ phase: "deposit" });
            else setState({ phase: "error" });
          })
        }
        className="mt-5 w-full rounded-xl border border-white/15 bg-white/10 py-3 text-sm font-semibold text-offwhite transition-colors hover:bg-white/15 disabled:opacity-50"
      >
        {pending
          ? offer.approvalRequired
            ? "Sending request…"
            : "Booking…"
          : offer.approvalRequired
            ? "Request this time"
            : "Book this time"}
      </button>
    </div>
  );
}
