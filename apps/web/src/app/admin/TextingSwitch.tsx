"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";
import { useToast } from "@/components/ui/Toast";
import { setTextingAction } from "./actions";

export interface TextingState {
  enabled: boolean;
  /** "default" = nobody has used this switch yet; the server's SMS_ENABLED applies. */
  source: "admin" | "default";
  updatedAt: string | null;
  updatedByEmail: string | null;
}

/**
 * TEXTING (SMS) FOR THE WHOLE PLATFORM.
 *
 * Every text costs money; email and app notifications do not. Off stops every
 * SMS - reminders, alerts, sign-in codes, the AI text receptionist - and sends
 * what has an email or app version that way instead. It takes effect without a
 * deploy: at once on the server that takes the click, within seconds on any
 * other.
 *
 * Two presses, never one: the switch asks first, and says what the flip means
 * in that direction - on starts a bill, off silences the receptionist.
 */
export function TextingSwitch({ initial }: { initial: TextingState }) {
  const { toast } = useToast();
  const [state, setState] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  // A plain flag, not useTransition: one awaited call, and the buttons stay
  // disabled for exactly as long as it is in flight.
  const [pending, setPending] = useState(false);
  const next = !state.enabled;

  async function apply() {
    if (pending) return;
    setPending(true);
    try {
      const r = await setTextingAction(next);
      if (r.ok && typeof r.enabled === "boolean") {
        setState({
          enabled: r.enabled,
          source: "admin",
          updatedAt: r.updatedAt ?? new Date().toISOString(),
          updatedByEmail: null,
        });
        setConfirming(false);
        toast(r.enabled ? "Texting is on" : "Texting is off", "success");
      } else {
        toast("Couldn't change texting. Nothing changed.", "error");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="texting-heading">
      <h2 id="texting-heading" className="mb-3 mt-10 font-display text-lg">
        Texting
      </h2>
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium" data-qa="texting-status">
              {state.enabled ? "Texting is ON" : "Texting is OFF"}
            </p>
            <p className="mt-1 text-sm text-muted">
              {state.enabled
                ? "Reminders, alerts, sign-in codes and the AI text receptionist go out by text, and every text is billed."
                : "No texts go out. Email and app notifications carry on, and alerts people asked to get by text arrive by email."}
            </p>
            <p className="mt-2 text-xs text-muted">
              {state.source === "default" || !state.updatedAt ? (
                "Not set here yet - the server default applies."
              ) : (
                <>
                  Last changed <LocalDate iso={state.updatedAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                  {state.updatedByEmail ? ` by ${state.updatedByEmail}` : ""}
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={state.enabled}
            aria-label="Texting for every shop"
            data-qa="texting-switch"
            disabled={pending}
            onClick={() => setConfirming(true)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 disabled:opacity-60 ${
              state.enabled ? "bg-gold" : "border border-subtle bg-charcoal-700"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full shadow-sm transition-[transform,background-color] duration-200 ease-out ${
                state.enabled ? "translate-x-6 bg-charcoal" : "translate-x-1 bg-muted"
              }`}
            />
          </button>
        </div>

        {confirming && (
          <div
            data-qa="texting-confirm"
            className="mt-4 flex flex-col gap-3 rounded-xl border border-subtle bg-charcoal-800/60 p-3"
          >
            <p className="text-sm">
              {next
                ? "Turn texting ON for every shop? Texts start going out, and being billed, within seconds."
                : "Turn texting OFF for every shop? No texts go out, and the AI text receptionist stops answering."}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                data-qa="texting-apply"
                disabled={pending}
                onClick={() => void apply()}
                className="h-10 flex-1 rounded-xl bg-gold px-4 text-xs font-semibold text-charcoal-900 transition-opacity duration-150 disabled:opacity-60"
              >
                {pending ? "Saving…" : next ? "Turn texting on" : "Turn texting off"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirming(false)}
                className="h-10 flex-1 rounded-xl border border-subtle px-4 text-xs text-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
