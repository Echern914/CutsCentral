"use client";

import { useRef, useState } from "react";
import type { PublicAward } from "@chairback/config/providerAward";
import { AwardCardBody } from "@/components/AwardSpotlight";
import { FormError } from "@/components/ui/FormError";
import { decideAwardAction } from "./actions";

/**
 * "You've been chosen" - the winner sees EXACTLY the card their page will
 * show (title, what they do, how and why, their stats) and says yes or no.
 * Nothing is posted until they approve (Eric, 2026-10-17).
 */
export function ApproveAward({ award }: { award: PublicAward & { id: string } }) {
  const [done, setDone] = useState<"APPROVED" | "DECLINED" | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  async function decide(decision: "approve" | "decline") {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await decideAwardAction(award.id, decision);
      if (res.ok) setDone(res.status);
      else
        setError(
          res.error === "already_decided"
            ? "This was already decided. Reload to see where it stands."
            : res.error === "no_answer"
              ? "No answer from ChairBack. Check your connection, then reload to see whether it went through."
              : "Couldn't save that. Try again.",
        );
    } catch {
      setError("No answer from ChairBack. Check your connection, then reload to see whether it went through.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="mb-6 rounded-2xl border border-gold/40 bg-gold/5 p-5" role="status">
        <p className="text-sm text-offwhite">
          {done === "APPROVED"
            ? "It's on your page now. Every client who opens it will see it."
            : "Declined. Nothing was posted."}
        </p>
      </div>
    );
  }

  return (
    <section className="mb-6" data-qa="award-approve">
      <h2 className="font-display text-xl tracking-tight">You&apos;ve been chosen 🏆</h2>
      <p className="mt-1 text-sm text-muted">
        This is exactly what your page will show. Nothing is posted until you approve it.
      </p>
      <div className="relative mx-auto mt-4 max-w-sm overflow-hidden rounded-3xl border border-gold/40 bg-charcoal-900 px-6 pb-6 pt-4 text-center text-offwhite">
        <AwardCardBody award={award} />
      </div>
      <FormError className="mt-3 text-sm">{error}</FormError>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void decide("approve")}
          disabled={pending}
          className="inline-flex h-11 items-center justify-center rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
        >
          {pending ? "Saving…" : "Approve and post it"}
        </button>
        {confirmDecline ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Decline it? Nothing will be posted.</span>
            <button
              type="button"
              onClick={() => void decide("decline")}
              disabled={pending}
              className="inline-flex h-11 items-center justify-center rounded-full border border-subtle px-4 text-sm text-offwhite disabled:opacity-50"
            >
              Yes, decline
            </button>
            <button
              type="button"
              onClick={() => setConfirmDecline(false)}
              className="inline-flex h-11 items-center justify-center rounded-full px-3 text-sm text-muted"
            >
              Keep it
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDecline(true)}
            disabled={pending}
            className="inline-flex h-11 items-center justify-center rounded-full border border-subtle px-5 text-sm text-muted transition-colors hover:text-offwhite disabled:opacity-50"
          >
            Decline
          </button>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        Something to change? Let ChairBack know: we&apos;ll fix it and send it back for your OK.
      </p>
    </section>
  );
}
