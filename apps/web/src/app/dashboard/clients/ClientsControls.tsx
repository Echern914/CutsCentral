"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { LOYALTY_TIERS, LOYALTY_TIER_KEYS } from "@chairback/config/constants";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { addClientAction, searchClientsByNameAction, type ClientSearchResult } from "../actions";
import { ImportClients } from "./ImportClients";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/** Search + sort + filter bar, plus an Add-client form. Drives the URL query. */
export function ClientsControls() {
  const router = useRouter();
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  // Live typeahead: as you type (>=2 chars), show a dropdown of the first few
  // matches so you don't have to type the whole name / number and hit Enter.
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [results, setResults] = useState<ClientSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const searchBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchClientsByNameAction(q).then((res) => {
        if (res.ok && res.clients) {
          setResults(res.clients);
          setOpen(true);
        }
      });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (searchBox.current && !searchBox.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page"); // reset to page 1 on any filter change
    router.push(`/dashboard/clients?${next.toString()}`);
  }

  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div ref={searchBox} className="relative w-full sm:flex-1 sm:min-w-[180px]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            placeholder="Search name, phone, or email…"
            autoComplete="off"
            aria-label="Search clients"
            onKeyDown={(e) => {
              // Enter still runs the full filtered list (the fallback).
              if (e.key === "Enter") {
                setOpen(false);
                setParam("q", query);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            className={`${field}`}
          />
          {/* Live matches: click one to jump straight to that client. */}
          {open && results.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-subtle bg-charcoal-800 py-1 shadow-lg">
              {results.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/dashboard/clients/${c.id}`}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-charcoal-700"
                  >
                    <span className="truncate text-offwhite">{c.name || "Client"}</span>
                    {c.phone && (
                      <span className="shrink-0 text-xs text-muted tabular-nums">{c.phone}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <select
          value={params.get("sort") ?? "recent"}
          onChange={(e) => setParam("sort", e.target.value)}
          className={`${field} w-full sm:w-auto`}
        >
          <option value="recent">Recent visit</option>
          <option value="oldest">Oldest visit</option>
          <option value="name">Name</option>
        </select>
        <select
          value={params.get("filter") ?? "all"}
          onChange={(e) => setParam("filter", e.target.value)}
          className={`${field} w-full sm:w-auto`}
        >
          <option value="all">All clients</option>
          <option value="active">Active only</option>
          <option value="optedOut">Opted out</option>
          <option value="needsConsent">Needs SMS consent</option>
          <option value="archived">Archived</option>
        </select>
        <select
          value={params.get("tier") ?? ""}
          onChange={(e) => setParam("tier", e.target.value)}
          className={`${field} w-full sm:w-auto`}
          aria-label="Loyalty tier"
        >
          <option value="">All tiers</option>
          {LOYALTY_TIER_KEYS.map((k) => (
            <option key={k} value={k}>
              {LOYALTY_TIERS[k].label}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setAdding((v) => !v);
            setImporting(false);
          }}
          className="rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
        >
          {adding ? "Close" : "Add client"}
        </button>
        <button
          onClick={() => {
            setImporting((v) => !v);
            setAdding(false);
          }}
          className="rounded-full border border-subtle px-4 py-2 text-sm font-semibold text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
        >
          {importing ? "Close" : "Import CSV"}
        </button>
      </div>

      {adding && <AddClientForm onDone={() => setAdding(false)} />}
      {importing && <ImportClients onDone={() => setImporting(false)} />}
    </div>
  );
}

function SubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-50"
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
        <label className="flex items-start gap-2.5 text-xs leading-relaxed text-muted sm:col-span-2">
          <input
            type="checkbox"
            name="smsConsent"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-subtle bg-charcoal-700 accent-gold"
          />
          <span>
            This client agreed to receive text reminders. Leave unchecked and we
            won&apos;t text them until they opt in.
          </span>
        </label>
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
