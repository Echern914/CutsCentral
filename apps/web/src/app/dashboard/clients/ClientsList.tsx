"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  LOYALTY_TIERS,
  FREQUENCY_SEGMENTS,
  type LoyaltyTierKey,
  type FrequencySegmentKey,
} from "@chairback/config/constants";
import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";
import { useToast } from "@/components/ui/Toast";
import { bulkClientAction } from "../actions";

export interface ClientRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  optedOut: boolean;
  smsConsent: boolean;
  archived?: boolean;
  source: string;
  lastVisitAt: string | null;
  medianIntervalDays: number | null;
  /** Loyalty status tier (stored), null below the first threshold. */
  loyaltyTier: LoyaltyTierKey | null;
  /** Coarse visit-frequency segment, derived from cadence; null when unknown. */
  frequencySegment: FrequencySegmentKey | null;
  balance: number;
}

/**
 * Selectable client list with a batch-action bar. Checkboxes drive a selection
 * set; the bar appears when 1+ are selected and runs opt-out / opt-in / nudge.
 */
export function ClientsList({ clients }: { clients: ClientRow[] }) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  // Membership-checked (not size-checked) so stale ids can never read as
  // "everything selected" after the visible rows change.
  const allSelected =
    clients.length > 0 && clients.every((c) => selected.has(c.id));
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(clients.map((c) => c.id)));
  }

  function runBulk(action: "optOut" | "optIn" | "attestConsent" | "nudge") {
    const ids = [...selected];
    startTransition(async () => {
      const r = await bulkClientAction(action, ids);
      if (r.ok) {
        const n = action === "nudge" ? (r.sent ?? 0) : (r.updated ?? ids.length);
        const verb =
          action === "nudge"
            ? `Nudged ${n} ${n === 1 ? "client" : "clients"}`
            : action === "optOut"
              ? `Opted out ${n}`
              : action === "attestConsent"
                ? `Marked consent for ${n}`
                : `Opted in ${n}`;
        toast(verb, "success");
        setSelected(new Set());
      } else {
        toast("Bulk action failed", "error");
      }
    });
  }

  if (clients.length === 0) {
    return (
      <Card className="overflow-hidden">
        <p className="px-5 py-8 text-center text-sm text-muted">
          No clients found. Use “Add client” for walk-ins, or connect Acuity to
          sync your appointment history.
        </p>
      </Card>
    );
  }

  return (
    <>
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-gold/30 bg-charcoal-800 px-4 py-3">
          <span className="w-full text-sm text-offwhite sm:w-auto">{selected.size} selected</span>
          <button
            disabled={pending}
            onClick={() => runBulk("nudge")}
            className="rounded-full bg-gold px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
          >
            Nudge
          </button>
          <button
            disabled={pending}
            onClick={() => {
              if (
                confirm(
                  "Confirm these clients agreed to receive text messages from your shop. Only mark consent for clients who actually opted in. This is a legal record.",
                )
              )
                runBulk("attestConsent");
            }}
            className="rounded-full border border-emerald-soft/40 px-4 py-1.5 text-xs text-emerald-soft transition-colors duration-150 ease-out hover:bg-emerald-soft/10 disabled:opacity-50"
          >
            Mark consent
          </button>
          <button
            disabled={pending}
            onClick={() => runBulk("optOut")}
            className="rounded-full border border-subtle px-4 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
          >
            Opt out
          </button>
          <button
            disabled={pending}
            onClick={() => runBulk("optIn")}
            className="rounded-full border border-subtle px-4 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
          >
            Opt in
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
          >
            Clear
          </button>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 border-b border-subtle px-4 py-2.5 sm:px-5">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="h-5 w-5 accent-gold"
            aria-label="Select all"
          />
          <span className="text-xs text-muted">Select all</span>
        </div>
        <ul className="divide-y divide-subtle">
          {clients.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-4 sm:px-5">
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                className="h-5 w-5 shrink-0 accent-gold"
                aria-label={`Select ${c.name}`}
              />
              <Link
                href={`/dashboard/clients/${c.id}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 transition-opacity duration-150 ease-out hover:opacity-80"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-offwhite">{c.name}</p>
                  {/* Badges on their own wrapping line so a long name can't push
                      them off-screen (they carry the consent/opt-out signal). */}
                  {(c.source === "manual" ||
                    c.optedOut ||
                    !c.smsConsent ||
                    c.archived ||
                    c.loyaltyTier ||
                    c.frequencySegment) && (
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {c.loyaltyTier && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                          style={{
                            color: LOYALTY_TIERS[c.loyaltyTier].color,
                            backgroundColor: `${LOYALTY_TIERS[c.loyaltyTier].color}1A`,
                          }}
                          title="Loyalty tier (by lifetime completed visits)"
                        >
                          {LOYALTY_TIERS[c.loyaltyTier].label}
                        </span>
                      )}
                      {c.frequencySegment && (
                        <span
                          className="rounded-full bg-charcoal-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                          title="How often this client visits"
                        >
                          {FREQUENCY_SEGMENTS[c.frequencySegment].label}
                        </span>
                      )}
                      {c.archived && (
                        <span className="rounded-full bg-charcoal-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted/80">
                          archived
                        </span>
                      )}
                      {c.source === "manual" && (
                        <span className="rounded-full bg-charcoal-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                          manual
                        </span>
                      )}
                      {c.optedOut && (
                        <span className="rounded-full bg-danger-soft/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-danger-soft">
                          opted out
                        </span>
                      )}
                      {!c.optedOut && !c.smsConsent && (
                        <span
                          className="rounded-full bg-gold/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gold/90"
                          title="No SMS consent on file - this client won't be texted until they opt in"
                        >
                          needs consent
                        </span>
                      )}
                    </span>
                  )}
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {c.phone ?? c.email ?? "no contact"}
                    {c.lastVisitAt ? (
                      <>
                        {" · last "}
                        <LocalDate iso={c.lastVisitAt} />
                      </>
                    ) : null}
                  </p>
                </div>
                <span className="shrink-0 font-display text-gold" title="Punch balance">
                  {c.balance}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
