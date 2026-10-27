"use client";

import { useRef, useState } from "react";
import {
  FILL_CANCELLATIONS_SUMMARY,
  FILL_CANCELLATIONS_TITLE,
  autoFillBlockerText,
} from "@chairback/config/fillCancellations";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { saveAutoFillAction } from "./actions";

/**
 * FILL CANCELLATIONS AUTOMATICALLY - the barber's switch for Auto-fill
 * (apps/api engines/autoFill.ts): when someone cancels, Gold members get a
 * head start, then everyone with the shop's app is told the time is open.
 *
 * 🔴 NEVER A SWITCH THAT SILENTLY DOES NOTHING. The API answers why it could
 * not run right now (`blockers`, codes); this card says each one in words
 * (config/fillCancellations.ts) and will not turn on while any stands. A shop
 * that already has it on and then trips a gate still sees why, and can still
 * turn it off.
 *
 * The outcome is shown in the card, not a toast (a toast can land where the
 * barber is not looking).
 */
export function FillCancellationsCard({
  initialEnabled,
  blockers,
}: {
  initialEnabled: boolean;
  /** Codes from the API; empty = nothing in the way. */
  blockers: string[];
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<"on" | "off" | "failed" | null>(null);
  const [saving, setSaving] = useState(false);
  // A ref, not just state: a second tap in the same frame must see the first.
  const busy = useRef(false);

  const blocked = blockers.length > 0;
  const canTurnOn = !blocked;

  async function toggle() {
    if (busy.current) return;
    const next = !enabled;
    if (next && !canTurnOn) return;
    busy.current = true;
    setSaving(true);
    setStatus(null);
    const r = await saveAutoFillAction(next).catch(() => ({ ok: false }));
    busy.current = false;
    setSaving(false);
    if (!r.ok) {
      setStatus("failed");
      return;
    }
    setEnabled(next);
    setStatus(next ? "on" : "off");
  }

  const state = enabled
    ? blocked
      ? "On, but it can't run right now."
      : "On. The next cancellation is offered around automatically."
    : "Off. Only you are told when a time opens.";

  return (
    <Card id="fill-cancellations" className="p-5">
      <CardHeader title={FILL_CANCELLATIONS_TITLE} subtitle={FILL_CANCELLATIONS_SUMMARY} />
      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="min-w-0 text-sm text-muted" data-testid="fill-cancellations-state">
          {state}
        </p>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={saving || (!enabled && !canTurnOn)}
          aria-pressed={enabled}
          aria-label={FILL_CANCELLATIONS_TITLE}
          className={cn(
            "min-h-11 shrink-0 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50",
            enabled
              ? "bg-emerald-soft/15 text-emerald-soft"
              : "border border-subtle text-muted hover:bg-charcoal-700",
          )}
        >
          {saving ? "Saving…" : enabled ? "On" : "Off"}
        </button>
      </div>

      {blocked && (
        <div
          data-testid="fill-cancellations-blockers"
          className="mt-4 min-w-0 rounded-xl border border-subtle bg-charcoal-900/60 p-3"
        >
          <p className="text-sm font-medium text-offwhite">
            {enabled ? "It's not running because:" : "It can't be turned on yet:"}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            {blockers.map((code) => (
              <li key={code} className="[overflow-wrap:anywhere]">
                {autoFillBlockerText(code)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {status && (
        <p
          role="status"
          className={cn("mt-4 text-sm", status === "failed" ? "text-danger-soft" : "text-emerald-soft")}
        >
          {status === "on"
            ? "Saved. Your next cancellation goes out on its own."
            : status === "off"
              ? "Saved. It's off. Cancellations are no longer offered around."
              : "Couldn't save. Check your connection and try again."}
        </p>
      )}
    </Card>
  );
}
