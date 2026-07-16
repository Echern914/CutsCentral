"use client";

import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { fadeUp } from "@/components/motion/variants";
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import {
  runSweepAction,
  sweepPreviewAction,
  type SweepSummary,
} from "../actions";

/**
 * Bulk rebooking action. Step 1: preview (dry-run) shows how many clients would
 * be texted today. Step 2: send for real, gated behind an explicit confirm so a
 * barber never blasts SMS by accident.
 */
export function SweepControl({ atRiskCount }: { atRiskCount: number }) {
  // No "upgrade" steering inside the iOS app (Guideline 3.1.1).
  const inApp = useIsNativeApp();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<SweepSummary | null>(null);
  const [result, setResult] = useState<SweepSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function doPreview() {
    setResult(null);
    setError(null);
    startTransition(async () => {
      const s = await sweepPreviewAction();
      setPreview(s);
      setConfirming(false);
    });
  }

  function doSend() {
    startTransition(async () => {
      const r = await runSweepAction();
      setResult(r.summary);
      setError(
        r.summary
          ? null
          : r.error === "subscription_required"
            ? inApp
              ? "Texting is a Premium feature."
              : "Texting is a Premium feature - upgrade from the Billing page to send nudges."
            : "Couldn't send right now. Try again in a minute.",
      );
      setPreview(null);
      setConfirming(false);
    });
  }

  const wouldSend = preview ? preview.skipped : 0; // dry-run marks eligibles as "skipped"

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg">Rebooking nudges</h2>
          <p className="text-xs text-muted">
            {atRiskCount > 0
              ? `${atRiskCount} ${atRiskCount === 1 ? "client is" : "clients are"} overdue and textable.`
              : "No clients are overdue right now."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {error ? (
            <>
              <span className="text-sm text-gold">{error}</span>
              <button
                onClick={() => setError(null)}
                className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                Dismiss
              </button>
            </>
          ) : result ? (
            <>
              <span className="text-sm text-emerald-soft">
                Sent {result.sent} {result.sent === 1 ? "nudge" : "nudges"}
                {result.failed > 0 ? ` (${result.failed} failed)` : ""}.
              </span>
              <button
                onClick={() => setResult(null)}
                className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                Done
              </button>
            </>
          ) : confirming && preview ? (
            <>
              <span className="text-sm text-offwhite">
                Send {wouldSend} {wouldSend === 1 ? "text" : "texts"} now?
              </span>
              <button
                onClick={doSend}
                disabled={pending}
                className="rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
              >
                {pending ? "Sending…" : "Confirm send"}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                Cancel
              </button>
            </>
          ) : preview ? (
            <>
              <span className="text-sm text-offwhite">
                {wouldSend} {wouldSend === 1 ? "client" : "clients"} would be texted.
              </span>
              <button
                onClick={() => setConfirming(true)}
                disabled={pending || wouldSend === 0}
                className="rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
              >
                Send now
              </button>
              <button
                onClick={doPreview}
                disabled={pending}
                className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                Refresh
              </button>
            </>
          ) : (
            <button
              onClick={doPreview}
              disabled={pending}
              className="rounded-full border border-gold/50 px-5 py-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
            >
              {pending ? "Checking…" : "Preview today's nudges"}
            </button>
          )}
        </div>
      </Card>
    </motion.div>
  );
}
