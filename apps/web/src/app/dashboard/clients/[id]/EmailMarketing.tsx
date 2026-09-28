"use client";

import { useEffect, useId, useState } from "react";
import { Card } from "@/components/ui/Card";
import { recordEmailYesAction, removeEmailYesAction } from "../../actions";

export interface ClientEmailMarketing {
  state: "opted_in" | "needs_consent" | "opted_out";
  /** When they said yes (ISO), or null. */
  at: string | null;
  /** Where the yes came from: "booking_page", "customer_settings" or "staff:<how>". */
  source: string | null;
}

/** How a client can tell the shop yes. Same keys the API accepts. */
export const YES_METHODS = [
  { key: "in_person", label: "In person" },
  { key: "by_text", label: "By text" },
  { key: "by_email", label: "By email" },
  { key: "paper_form", label: "Paper form" },
] as const;
export type YesMethod = (typeof YES_METHODS)[number]["key"];

const HOW: Record<string, string> = {
  booking_page: "on your booking page",
  customer_settings: "on their rewards page",
  "staff:in_person": "in person, recorded by your shop",
  "staff:by_text": "by text, recorded by your shop",
  "staff:by_email": "by email, recorded by your shop",
  "staff:paper_form": "on a paper form, recorded by your shop",
};

/**
 * Whether this client may get the shop's marketing email: said yes (when and
 * how), not yet, or unsubscribed.
 *
 * The shop can record ONE client's yes here, saying how they gave it, and take
 * back a yes it recorded. It cannot record a yes for someone with no email,
 * cannot undo an unsubscribe (only the customer can, from the link in one of
 * the shop's emails),
 * and cannot remove a yes the customer gave themselves. The API enforces all
 * of it; this only decides what to offer, and writes the answer inline - a
 * toast can hide under a dialog on a phone.
 */
export function EmailMarketing({
  clientId,
  hasEmail,
  initial,
  timezone,
}: {
  clientId: string;
  hasEmail: boolean;
  initial: ClientEmailMarketing | undefined;
  /** The shop's timezone, so the date reads the same on the server and in the browser. */
  timezone: string;
}) {
  const [shown, setShown] = useState(initial);
  // A server refresh (this change's revalidate, or any other edit) is the truth.
  useEffect(() => setShown(initial), [initial]);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const listId = useId();

  // An API from before this existed sends nothing: show nothing.
  if (!shown) return null;

  async function run(
    act: () => Promise<{ ok: boolean; message?: string; emailMarketing?: ClientEmailMarketing }>,
    done: string,
  ) {
    if (pending) return;
    setOutcome(null);
    setPending(true);
    try {
      const r = await act();
      if (r.ok && r.emailMarketing) {
        setShown(r.emailMarketing);
        setOpen(false);
        setOutcome({ ok: true, text: done });
        return;
      }
      setOutcome({ ok: false, text: r.message ?? "Could not save that. Try again." });
    } catch {
      setOutcome({ ok: false, text: "Could not save that. Try again." });
    } finally {
      setPending(false);
    }
  }

  const date = shown.at
    ? new Date(shown.at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: timezone,
      })
    : null;
  const how = shown.source ? HOW[shown.source] : undefined;
  const byShop = shown.source?.startsWith("staff:") === true;
  const small = "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50";

  return (
    <Card className="px-5 py-4">
      <h2 className="text-[10px] uppercase tracking-wide text-muted">Marketing email</h2>

      {shown.state === "opted_in" && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-offwhite" data-qa="email-marketing-state">
            Said yes{date ? ` on ${date}` : ""}
            {how ? `, ${how}` : ""}.
          </p>
          {byShop && (
            <button
              type="button"
              disabled={pending}
              onClick={() => void run(() => removeEmailYesAction(clientId), "Removed.")}
              className={`${small} border border-subtle text-muted hover:text-offwhite`}
            >
              Remove
            </button>
          )}
        </div>
      )}

      {shown.state === "opted_out" && (
        <p className="mt-1 text-sm text-offwhite" data-qa="email-marketing-state">
          Unsubscribed. Only they can turn your emails back on, from the Unsubscribe link at the bottom of one of your emails.
        </p>
      )}

      {shown.state === "needs_consent" && (
        <>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-offwhite" data-qa="email-marketing-state">
              {hasEmail ? "Not yet." : "Not yet. Add their email address to record a yes."}
            </p>
            {hasEmail && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen((o) => !o)}
                className={`${small} border border-subtle text-offwhite hover:bg-charcoal-700`}
              >
                Record their yes
              </button>
            )}
          </div>
          {hasEmail && open && (
            <div
              id={listId}
              role="group"
              aria-label="How did they say yes?"
              className="mt-2 flex flex-col gap-2 rounded-xl border border-subtle bg-charcoal-800 p-3"
            >
              <p className="text-xs text-muted">How did they say yes?</p>
              <div className="flex flex-wrap gap-2">
                {YES_METHODS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    disabled={pending}
                    onClick={() => void run(() => recordEmailYesAction(clientId, m.key), "Saved.")}
                    className={`${small} bg-charcoal-700 text-offwhite hover:bg-charcoal-600`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted">
                Only record a yes this person gave you. Appointment emails go out either way.
              </p>
            </div>
          )}
        </>
      )}

      {(pending || outcome) && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-1 text-xs ${pending ? "text-muted" : outcome?.ok ? "text-emerald-soft" : "text-danger-soft"}`}
        >
          {pending ? "Saving…" : outcome?.text}
        </p>
      )}
    </Card>
  );
}
