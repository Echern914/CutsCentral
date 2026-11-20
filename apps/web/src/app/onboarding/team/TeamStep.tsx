"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui/FormError";
import { addPeopleAction, type SetupInvite } from "../stepActions";

const field =
  "h-11 w-full min-w-0 rounded-xl border border-subtle-strong bg-charcoal-800 px-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";
const primary =
  "inline-flex h-11 w-full items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50";

type Row = { name: string; email: string };
type Mode = "solo" | "team";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What to tell the owner about an invitation that did NOT go out. The person
 * is added and bookable in every case - only their sign-in is still to do, and
 * each line says where.
 */
function inviteNote(i: SetupInvite): string {
  switch (i.outcome) {
    case "email_unavailable":
      return `${i.name} is added and can be booked. Invitations can't be sent right now - invite them from Team later.`;
    case "email_failed":
      return `${i.name} is added, but the invitation to ${i.email} didn't send. Send it again from Team.`;
    case "already_member":
      return `${i.name} is added. ${i.email} already signs in here, so no invitation was sent.`;
    case "already_linked":
      return `${i.name} already has a sign-in here, so no invitation was sent.`;
    default:
      return "";
  }
}

/**
 * Setup: who takes appointments.
 *
 * One question first - just me, or a team - because the two shops need
 * different screens: someone working alone confirms their own name and moves
 * on; a shop adds each person, and an email beside a name sends that person
 * an invitation to sign in to their own day. The email is optional: without it
 * the person can still be booked, and is invited later from Team.
 *
 * Their own name is filled in from signup (most owners take appointments too -
 * clear it if they don't). A name already added is never added twice.
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
  // Coming back with people already added: this is a team, and every new row
  // is someone else.
  const returning = existing.length > 0;
  const [mode, setMode] = useState<Mode>(returning ? "team" : "solo");
  const [rows, setRows] = useState<Row[]>([{ name: returning ? "" : myName, email: "" }]);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Invitations that didn't go out. Shown INSTEAD of moving on, so the owner
  // reads them; the people themselves are saved either way.
  const [notSent, setNotSent] = useState<SetupInvite[] | null>(null);

  // Working alone sends only the first row, whatever was typed below it before
  // switching back.
  const active = mode === "solo" ? rows.slice(0, 1) : rows;
  // The first row of a new shop is the owner, who is already signed in.
  const isOwnerRow = (i: number) => !returning && i === 0;

  function choose(m: Mode) {
    setMode(m);
    setError(null);
    if (m === "team") setRows((cur) => (cur.length < 2 ? [...cur, { name: "", email: "" }] : cur));
  }

  function setRow(i: number, patch: Partial<Row>) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function save() {
    if (busy.current) return;
    const people: { name: string; email?: string }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < active.length; i++) {
      const name = active[i]!.name.trim();
      const email = mode === "team" && !isOwnerRow(i) ? active[i]!.email.trim().toLowerCase() : "";
      if (!name && !email) continue;
      if (!name) {
        setError(`Add a name for ${email}.`);
        return;
      }
      if (email && !EMAIL.test(email)) {
        setError(`The email for ${name} doesn't look right. Fix it, or clear it and invite them later.`);
        return;
      }
      if (email && seen.has(email)) {
        setError("Two people have the same email. Each person signs in with their own.");
        return;
      }
      if (email) seen.add(email);
      people.push(email ? { name, email } : { name });
    }
    if (people.length === 0 && !returning) {
      setError("Add at least one name - yours, if you take appointments.");
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (people.length > 0) {
        const res = await addPeopleAction(people);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const failed = res.invites.filter((i) => i.outcome !== "sent");
        if (failed.length > 0) {
          setNotSent(failed);
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

  if (notSent) {
    return (
      <div className="flex flex-col gap-3">
        <div role="status" className="flex flex-col gap-2 rounded-2xl border border-subtle p-4" data-testid="invites-not-sent">
          <p className="text-sm font-semibold text-offwhite">Everyone is added and can be booked.</p>
          <ul className="flex flex-col gap-2">
            {notSent.map((i) => (
              <li key={`${i.name}|${i.email}`} className="text-sm text-muted">
                {inviteNote(i)}
              </li>
            ))}
          </ul>
        </div>
        <a href={next} className={primary}>
          Continue
        </a>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      // Our own message names the person; the browser's bubble doesn't.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!returning && (
        <div role="group" aria-label="Who works here" className="grid grid-cols-2 gap-2">
          {(
            [
              ["solo", "Just me"],
              ["team", "I have a team"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => choose(m)}
              className={`h-11 min-w-0 rounded-xl border px-3 text-sm font-semibold transition-colors ${
                mode === m
                  ? "border-gold bg-gold/10 text-offwhite"
                  : "border-subtle-strong text-muted hover:text-offwhite"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {returning && (
        <ul className="flex flex-col gap-2" aria-label="Already added">
          {existing.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-xl border border-subtle px-3 py-2 text-sm text-offwhite">
              <span aria-hidden="true" className="text-emerald-soft">
                ✓
              </span>
              <span className="min-w-0 truncate">{s.name}</span>
            </li>
          ))}
        </ul>
      )}
      {active.map((r, i) => {
        const n = existing.length + i + 1;
        return (
          <div key={i} className="flex flex-col gap-2" data-testid="person-row">
            <div className="flex items-center gap-2">
              <input
                value={r.name}
                onChange={(e) => setRow(i, { name: e.target.value })}
                placeholder={isOwnerRow(i) ? "Your name" : "First name"}
                aria-label={`Name ${n}`}
                maxLength={60}
                autoComplete="off"
                className={field}
              />
              {mode === "team" && active.length > 1 && (
                <button
                  type="button"
                  onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                  aria-label={`Remove name ${n}`}
                  className="h-11 shrink-0 px-2 text-sm text-muted hover:text-offwhite"
                >
                  ✕
                </button>
              )}
            </div>
            {mode === "team" && !isOwnerRow(i) && (
              <input
                type="email"
                inputMode="email"
                value={r.email}
                onChange={(e) => setRow(i, { email: e.target.value })}
                placeholder="Their email (optional)"
                aria-label={`Email ${n}, optional`}
                maxLength={200}
                autoComplete="off"
                autoCapitalize="none"
                className={field}
              />
            )}
          </div>
        );
      })}
      {mode === "team" && rows.length + existing.length < 20 && (
        <button
          type="button"
          onClick={() => setRows((cur) => [...cur, { name: "", email: "" }])}
          className="self-start text-sm text-gold underline-offset-4 hover:underline"
        >
          + Add someone
        </button>
      )}
      <p className="text-xs text-muted">
        {mode === "team"
          ? "Everyone here can be booked. Add an email and they get an invitation to sign in and see their own day. Leave it blank and you can invite them later on Team."
          : "Clients book you by name. You can add more people any time on your Calendar."}
      </p>
      <FormError className="text-sm">{error}</FormError>
      <button type="submit" disabled={pending} className={primary}>
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
