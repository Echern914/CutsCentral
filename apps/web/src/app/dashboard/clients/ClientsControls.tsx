"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { addClientAction } from "../actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/** Search + sort + filter bar, plus an Add-client form. Drives the URL query. */
export function ClientsControls() {
  const router = useRouter();
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page"); // reset to page 1 on any filter change
    router.push(`/dashboard/clients?${next.toString()}`);
  }

  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          defaultValue={params.get("q") ?? ""}
          placeholder="Search name, phone, or email…"
          onKeyDown={(e) => {
            if (e.key === "Enter") setParam("q", (e.target as HTMLInputElement).value);
          }}
          className={`${field} flex-1 min-w-[180px]`}
        />
        <select
          value={params.get("sort") ?? "recent"}
          onChange={(e) => setParam("sort", e.target.value)}
          className={`${field} w-auto`}
        >
          <option value="recent">Recent visit</option>
          <option value="oldest">Oldest visit</option>
          <option value="name">Name</option>
        </select>
        <select
          value={params.get("filter") ?? "all"}
          onChange={(e) => setParam("filter", e.target.value)}
          className={`${field} w-auto`}
        >
          <option value="all">All clients</option>
          <option value="active">Active only</option>
          <option value="optedOut">Opted out</option>
        </select>
        <button
          onClick={() => setAdding((v) => !v)}
          className="rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal hover:bg-gold-muted"
        >
          {adding ? "Close" : "Add client"}
        </button>
      </div>

      {adding && <AddClientForm onDone={() => setAdding(false)} />}
    </div>
  );
}

function SubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal hover:bg-gold-muted disabled:opacity-50"
    >
      {pending ? "Adding…" : "Add client"}
    </button>
  );
}

function AddClientForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [, startTransition] = useTransition();
  const [state, action] = useFormState(
    async (prev: { error?: string; ok?: boolean }, fd: FormData) => {
      const r = await addClientAction(prev, fd);
      if (r.ok) {
        startTransition(() => {
          toast("Client added", "success");
          onDone();
        });
      } else if (r.error) {
        toast(r.error, "error");
      }
      return r;
    },
    {},
  );

  return (
    <Card className="p-5">
      <form action={action} className="grid gap-3 sm:grid-cols-2">
        <input name="firstName" placeholder="First name *" required className={field} />
        <input name="lastName" placeholder="Last name" className={field} />
        <input
          name="phone"
          type="tel"
          placeholder="Phone (for nudges)"
          // US numbers only - the API silently drops anything it can't parse to
          // E.164, so catch typos here instead of "adding" a client with no phone.
          pattern="^\+?1?[-. (]*\d{3}[-. )]*\d{3}[-. ]*\d{4}$"
          title="Enter a 10-digit US phone number, e.g. 302-555-0142"
          className={field}
        />
        <input name="email" type="email" placeholder="Email" className={field} />
        <textarea
          name="notes"
          placeholder="Notes (optional)"
          rows={2}
          className={`${field} resize-none sm:col-span-2`}
        />
        <div className="sm:col-span-2">
          <SubmitBtn />
          {state.error && (
            <span className="ml-3 text-sm text-danger-soft">{state.error}</span>
          )}
        </div>
      </form>
    </Card>
  );
}
