"use client";

import { useRef, useState } from "react";
import { AWARD_LIMITS } from "@chairback/config/providerAward";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { applyForAwardAction, type AwardMe } from "./actions";

const input =
  "w-full rounded-xl border border-subtle bg-charcoal-800 px-3 py-2.5 text-base text-offwhite placeholder:text-muted sm:text-sm";

/**
 * The application: which of their own stats to put forward (read from their
 * data by the server - never typed in), a pitch, and credentials. It can be
 * changed until ChairBack decides.
 */
export function ApplyForAward({ me }: { me: AwardMe }) {
  const [app, setApp] = useState(me.application);
  const decided = app !== null && app.status !== "SUBMITTED";
  const [pitch, setPitch] = useState(app?.pitch ?? "");
  const [credentials, setCredentials] = useState(app?.credentials ?? "");
  const [keys, setKeys] = useState<string[]>(
    app ? app.stats.map((s) => s.key) : me.stats.map((s) => s.key),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const res = await applyForAwardAction({ pitch, credentials, statKeys: keys });
      if (res.ok) {
        setApp(res.application);
        setSaved(true);
      } else {
        setError(
          res.error === "already_decided"
            ? "This month has been decided, so your application can't change now."
            : res.error === "no_answer"
              ? "No answer from ChairBack. Check your connection, then reload to see whether it was sent."
              : res.error === "invalid"
                ? "Add a few words about why you, then send it."
                : "Couldn't send that. Try again.",
        );
      }
    } catch {
      setError("No answer from ChairBack. Check your connection, then reload to see whether it was sent.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (decided) {
    return (
      <Card className="p-5">
        <p className="text-sm text-offwhite">
          {app!.status === "WON"
            ? `You won ${me.monthLabel}. It's on your page now.`
            : `${me.monthLabel} has been decided. Apply again next month.`}
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={`Apply for ${me.monthLabel}`}
        subtitle={app ? "Sent. You can change it until we decide." : "Pick what to show, and tell us about you."}
      />
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
        <fieldset>
          <legend className="text-sm font-medium text-offwhite">Your numbers</legend>
          <p className="mt-0.5 text-xs text-muted">From your own bookings, the last 30 days. Choose which to show.</p>
          {me.stats.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No numbers yet this month. Your pitch can still win it.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {me.stats.map((s) => (
                <li key={s.key}>
                  <label className="flex min-h-11 items-center gap-3 rounded-xl border border-subtle px-3 py-2">
                    <input
                      type="checkbox"
                      checked={keys.includes(s.key)}
                      onChange={(e) => setKeys((k) => (e.target.checked ? [...k, s.key] : k.filter((x) => x !== s.key)))}
                    />
                    <span className="min-w-0 flex-1 text-sm text-muted">{s.label}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-offwhite">{s.value}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <label className="text-sm font-medium text-offwhite">
          Why you
          <textarea
            className={`${input} mt-1.5 min-h-[120px]`}
            value={pitch}
            maxLength={AWARD_LIMITS.pitch}
            onChange={(e) => setPitch(e.target.value)}
            placeholder="What made this month: the clients you brought back, the skills you've built, what you're proud of."
            required
          />
        </label>

        <label className="text-sm font-medium text-offwhite">
          Credentials <span className="font-normal text-muted">(optional)</span>
          <input
            className={`${input} mt-1.5`}
            value={credentials}
            maxLength={AWARD_LIMITS.credentials}
            onChange={(e) => setCredentials(e.target.value)}
            placeholder="Licensed 8 years, award-winning, known for my detail work"
          />
        </label>

        <FormError className="text-sm">{error}</FormError>
        {saved && (
          <p className="text-sm text-emerald-soft" role="status">
            Sent. We&apos;ll pick a winner this month.
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center justify-center rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50 sm:w-auto"
        >
          {pending ? "Sending…" : app ? "Update my application" : "Send my application"}
        </button>
      </form>
    </Card>
  );
}
