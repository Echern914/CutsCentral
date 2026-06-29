"use client";

import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { fadeUp } from "@/components/motion/variants";
import { winbackPreviewAction, type WinbackPreview } from "../actions";

/**
 * Win-back ("Growth Agent") preview. A barber clicks to see WHO the agent would
 * re-engage today (deeply lapsed clients), without sending anything. There's no
 * "send now" here on purpose: win-back goes out automatically on the daily cron -
 * this is the see-it-working surface, not a manual blast.
 */
export function WinbackPreview() {
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<WinbackPreview | null>(null);
  const [errored, setErrored] = useState(false);

  function doPreview() {
    startTransition(async () => {
      const p = await winbackPreviewAction();
      // null = the request failed (network/timeout/non-2xx) - distinct from a
      // successful-but-empty result, so we don't show "nobody to win back" when
      // the preview actually errored.
      setErrored(p === null);
      setPreview(p);
    });
  }

  const count = preview?.clients.length ?? 0;

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-lg">Win-back · Growth Agent</h2>
            <p className="text-xs text-muted">
              Deeply lapsed clients ChairBack will automatically text back to the
              chair. Preview who&apos;s up next — no texts are sent here.
            </p>
          </div>
          <button
            onClick={doPreview}
            disabled={pending}
            className="shrink-0 rounded-full border border-gold/50 px-5 py-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
          >
            {pending ? "Checking…" : preview || errored ? "Refresh preview" : "Preview win-back"}
          </button>
        </div>

        {errored ? (
          <div className="border-t border-subtle pt-4">
            <p className="text-sm text-coral-soft">
              Couldn&apos;t run the preview — please try again.
            </p>
          </div>
        ) : preview ? (
          <div className="border-t border-subtle pt-4">
            {count === 0 ? (
              <p className="text-sm text-muted">
                No deeply lapsed clients to win back right now.
              </p>
            ) : (
              <>
                <p className="text-sm text-offwhite">
                  {count} {count === 1 ? "client" : "clients"} would be re-engaged:
                </p>
                <ul className="mt-3 flex flex-col gap-2">
                  {preview.clients.map((c, i) => (
                    <li
                      key={`${c.name}-${i}`}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-offwhite">{c.name}</span>
                      <span className="text-xs text-muted">
                        {c.daysLapsed !== null
                          ? `${c.daysLapsed} days since last visit`
                          : "no visit on record"}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : null}
      </Card>
    </motion.div>
  );
}
