"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { LOYALTY_TIERS, LOYALTY_TIER_KEYS, type LoyaltyTierKey } from "@chairback/config/constants";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { displayPhone } from "@/lib/contactUri";
import { addClientAction, searchClientsByNameAction, type ClientSearchResult } from "../actions";
import { ImportClients } from "./ImportClients";

const field =
  "min-h-[44px] w-full rounded-xl border border-subtle-strong bg-charcoal-800 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/** One entry in the "Booked a service" filter (GET /api/dashboard/clients/service-options). */
export interface ServiceFilterOption {
  key: string;
  label: string;
  kind: "group" | "menu" | "synced";
}

/** The windows the API accepts (engines/clientServiceFilter.ts), plus any time. */
const WITHIN = [
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["365", "Last year"],
  ["any", "Any time"],
] as const;
const DEFAULT_WITHIN = "90";

const SORTS = [
  ["recent", "Recent visit"],
  ["oldest", "Oldest visit"],
  ["name", "Name"],
] as const;
const STATUSES = [
  ["all", "All clients"],
  ["active", "Active only"],
  ["optedOut", "Opted out"],
  ["needsConsent", "Needs SMS consent"],
  ["blocked", "Blocked from booking"],
  ["archived", "Archived"],
] as const;
const labelOf = (list: readonly (readonly [string, string])[], value: string) =>
  list.find(([v]) => v === value)?.[1] ?? list[0]![1];

/**
 * A filter as a pill, sized to the choice it SHOWS. A bare <select> is as wide
 * as its longest option, so "All clients" sat in a pill built for "Blocked
 * from booking". The select is still the control - laid invisibly over the
 * pill, so a tap opens the native picker and screen readers meet a real
 * combobox - while the pill draws the current choice. Filled once it is
 * narrowing the list, so a barber sees at a glance why fewer people show.
 */
function Pill({
  active,
  label,
  children,
}: {
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`relative inline-flex min-h-[44px] shrink-0 items-center rounded-full border pl-4 pr-9 text-sm font-medium transition-colors duration-150 ease-out focus-within:ring-2 focus-within:ring-gold/60 ${
        active
          ? "border-primary bg-primary text-on-primary"
          : "border-subtle-strong bg-charcoal-800 text-offwhite hover:bg-charcoal-700"
      }`}
    >
      <span aria-hidden className="max-w-[13rem] truncate">
        {label}
      </span>
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className={`pointer-events-none absolute right-3.5 top-1/2 h-3 w-3 -translate-y-1/2 ${
          active ? "text-on-primary" : "text-muted"
        }`}
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </span>
  );
}

/** The select inside a Pill: the whole pill is its hit area. */
const PILL_SELECT = "absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0";

/** Search + sort + filter bar, plus an Add-client form. Drives the URL query. */
export function ClientsControls({
  serviceOptions = null,
}: {
  /** null = the list could not be read: the filter is hidden, the rest works. */
  serviceOptions?: ServiceFilterOption[] | null;
} = {}) {
  const router = useRouter();
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);
  // `?import=1` opens the importer: the "Switching from Booksy or TheCut"
  // guide links here. Read on mount AND whenever the param arrives, because a
  // soft navigation from a page already on Clients keeps this component (and
  // its state) as it was.
  const importParam = params.get("import");
  const [importing, setImporting] = useState(importParam === "1");
  useEffect(() => {
    if (importParam === "1") {
      setImporting(true);
      setAdding(false);
    }
  }, [importParam]);

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

  function setParams(changes: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete("page"); // reset to page 1 on any filter change
    next.delete("import"); // a filter change is not a request to reopen the importer
    router.push(`/dashboard/clients?${next.toString()}`);
  }
  const setParam = (key: string, value: string) => setParams({ [key]: value });

  // Booked a service. The window only means something with a service picked,
  // so it goes with it: picking one starts at 90 days, clearing it drops both.
  const service = params.get("service") ?? "";
  // Missing or unknown reads as 90 days, as the API does (parseWithin).
  const rawWithin = params.get("within");
  const within = WITHIN.some(([v]) => v === rawWithin) ? rawWithin! : DEFAULT_WITHIN;
  const groups = serviceOptions?.filter((o) => o.kind === "group") ?? [];
  const menu = serviceOptions?.filter((o) => o.kind === "menu") ?? [];
  const synced = serviceOptions?.filter((o) => o.kind === "synced") ?? [];
  // A link to a service the list no longer offers still says what it filters by.
  const unknownPick = service !== "" && !serviceOptions?.some((o) => o.key === service);

  const sort = params.get("sort") ?? "recent";
  const filter = params.get("filter") ?? "all";
  const tier = params.get("tier") ?? "";
  // Sort is an order, not a narrowing, so it never counts as a filter here.
  const narrowed = filter !== "all" || tier !== "" || service !== "" || (params.get("q") ?? "") !== "";

  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div ref={searchBox} className="relative min-w-0 flex-1">
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          >
            <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="m13.2 13.2 3.8 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            placeholder="Search clients"
            autoComplete="off"
            enterKeyHint="search"
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
            className={`${field} pl-9`}
          />
          {/* Live matches: click one to jump straight to that client. */}
          {open && results.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-subtle bg-charcoal-800 py-1 shadow-lg">
              {results.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/dashboard/clients/${c.id}`}
                    onClick={() => setOpen(false)}
                    className="flex min-h-[44px] items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-charcoal-700"
                  >
                    <span className="truncate text-offwhite">{c.name || "Client"}</span>
                    {c.phone && (
                      <span className="shrink-0 text-xs text-muted tabular-nums">{displayPhone(c.phone)}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setImporting((v) => !v);
            setAdding(false);
          }}
          aria-expanded={importing}
          // The name stays the whole phrase even where only the icon shows.
          aria-label={importing ? "Close" : "Import clients"}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-2 rounded-xl border border-subtle-strong px-3 text-sm font-semibold text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
        >
          <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4">
            {importing ? (
              <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            ) : (
              <path
                d="M10 13V3.5M6 7l4-4 4 4M3.5 12.5v2a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
          <span className="hidden sm:inline">{importing ? "Close" : "Import clients"}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            setImporting(false);
          }}
          aria-expanded={adding}
          className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-semibold text-on-primary transition-colors duration-150 ease-out hover:bg-primary/90"
        >
          {!adding && (
            <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4">
              <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          )}
          {adding ? "Close" : "Add client"}
        </button>
      </div>

      {/* The filters, one scrolling row on a phone so the list starts higher.
          Order is load-bearing for tests: sort is the first select. */}
      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Pill active={false} label={labelOf(SORTS, sort)}>
          <select
            value={sort}
            onChange={(e) => setParam("sort", e.target.value)}
            aria-label="Sort by"
            className={PILL_SELECT}
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Pill>
        <Pill active={filter !== "all"} label={labelOf(STATUSES, filter)}>
          <select
            value={filter}
            onChange={(e) => setParam("filter", e.target.value)}
            aria-label="Client status"
            className={PILL_SELECT}
          >
            {STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Pill>
        <Pill
          active={tier !== ""}
          label={LOYALTY_TIER_KEYS.find((k) => k === tier) ? LOYALTY_TIERS[tier as LoyaltyTierKey].label : "All tiers"}
        >
          <select
            value={tier}
            onChange={(e) => setParam("tier", e.target.value)}
            className={PILL_SELECT}
            aria-label="Loyalty tier"
          >
            <option value="">All tiers</option>
            {LOYALTY_TIER_KEYS.map((k) => (
              <option key={k} value={k}>
                {LOYALTY_TIERS[k].label}
              </option>
            ))}
          </select>
        </Pill>
        {serviceOptions !== null && serviceOptions.length > 0 && (
          <Pill
            active={service !== ""}
            label={
              service === ""
                ? "Any service"
                : (serviceOptions.find((o) => o.key === service)?.label ?? "A service no longer listed")
            }
          >
            <select
              data-qa="clients-service"
              value={service}
              onChange={(e) =>
                setParams(
                  e.target.value
                    ? { service: e.target.value, within }
                    : { service: "", within: "" },
                )
              }
              className={PILL_SELECT}
              aria-label="Booked a service"
            >
              <option value="">Any service</option>
              {unknownPick && <option value={service}>A service no longer listed</option>}
              {groups.length > 0 && (
                <optgroup label="Groups">
                  {groups.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {menu.length > 0 && (
                <optgroup label="Services">
                  {menu.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {synced.length > 0 && (
                <optgroup label="From your old booking system">
                  {synced.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Pill>
        )}
        {service !== "" && (
          <Pill active label={labelOf(WITHIN, within)}>
            <select
              data-qa="clients-service-within"
              value={within}
              onChange={(e) => setParam("within", e.target.value)}
              className={PILL_SELECT}
              aria-label="Booked within"
            >
              {WITHIN.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Pill>
        )}
        {narrowed && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setParams({ q: "", filter: "", tier: "", service: "", within: "" });
            }}
            className="min-h-[44px] shrink-0 px-2 text-sm font-medium text-muted underline-offset-4 transition-colors duration-150 ease-out hover:text-offwhite hover:underline"
          >
            Clear filters
          </button>
        )}
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
      className="rounded-xl bg-primary px-5 py-2 text-sm font-semibold text-on-primary transition-colors duration-200 ease-out hover:bg-primary/90 disabled:opacity-50"
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
