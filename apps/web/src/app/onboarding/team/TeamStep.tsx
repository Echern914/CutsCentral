"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui/FormError";
import { addTeamAction } from "../stepActions";

const field =
  "h-11 w-full min-w-0 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";
const primary =
  "inline-flex h-11 w-full items-center justify-center rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";

/**
 * Setup: who takes appointments. Their own name is already filled in from
 * signup (most owners cut too - clear it if they don't); anyone else is a
 * first name. A name already on a chair is never added twice.
 */
export function TeamStep({
  existing,
  myName,
  next,
}: {
  existing: { id: string; name: string }[];
  myName: string;
  next: string;
}) {
  const router = useRouter();
  const [names, setNames] = useState<string[]>(existing.length > 0 ? [""] : [myName]);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const typed = names.map((n) => n.trim()).filter(Boolean);

  async function save() {
    if (busy.current) return;
    if (typed.length === 0 && existing.length === 0) {
      setError("Add at least one name - yours, if you take appointments.");
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (typed.length > 0) {
        const res = await addTeamAction(typed);
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      router.push(next);
    } catch {
      setError("No answer from ChairBack. Try again - anyone already added won't be added twice.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {existing.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Already added">
          {existing.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-xl border border-subtle px-3 py-2 text-sm text-offwhite">
              <span aria-hidden="true" className="text-emerald-soft">
                ✓
              </span>
              {s.name}
            </li>
          ))}
        </ul>
      )}
      {names.map((n, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={n}
            onChange={(e) => setNames((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder={i === 0 && existing.length === 0 ? "Your name" : "First name"}
            aria-label={`Name ${existing.length + i + 1}`}
            maxLength={60}
            autoComplete="off"
            className={field}
          />
          {names.length > 1 && (
            <button
              type="button"
              onClick={() => setNames((cur) => cur.filter((_, j) => j !== i))}
              aria-label={`Remove name ${existing.length + i + 1}`}
              className="shrink-0 px-2 text-sm text-muted hover:text-offwhite"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {names.length + existing.length < 20 && (
        <button
          type="button"
          onClick={() => setNames((cur) => [...cur, ""])}
          className="self-start text-sm text-gold underline-offset-4 hover:underline"
        >
          + Add someone
        </button>
      )}
      <p className="text-xs text-muted">
        Everyone here can be booked. To let someone sign in and see their own day, invite them later on Team.
      </p>
      <FormError className="text-sm">{error}</FormError>
      <button type="submit" disabled={pending} className={primary}>
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
