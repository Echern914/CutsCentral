"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { bulkClientAction } from "../actions";

export interface ClientRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  optedOut: boolean;
  source: string;
  lastVisitAt: string | null;
  medianIntervalDays: number | null;
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
  function toggleAll() {
    setSelected((prev) =>
      prev.size === clients.length ? new Set() : new Set(clients.map((c) => c.id)),
    );
  }

  function runBulk(action: "optOut" | "optIn" | "nudge") {
    const ids = [...selected];
    startTransition(async () => {
      const r = await bulkClientAction(action, ids);
      if (r.ok) {
        const n = action === "nudge" ? (r.sent ?? 0) : (r.updated ?? ids.length);
        toast(
          action === "nudge"
            ? `Nudged ${n} ${n === 1 ? "client" : "clients"}`
            : `${action === "optOut" ? "Opted out" : "Opted in"} ${n}`,
          "success",
        );
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
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-gold/30 bg-charcoal-800 px-4 py-3">
          <span className="text-sm text-offwhite">{selected.size} selected</span>
          <button
            disabled={pending}
            onClick={() => runBulk("nudge")}
            className="rounded-full bg-gold px-4 py-1.5 text-xs font-semibold text-charcoal hover:bg-gold-muted disabled:opacity-50"
          >
            Nudge
          </button>
          <button
            disabled={pending}
            onClick={() => runBulk("optOut")}
            className="rounded-full border border-subtle px-4 py-1.5 text-xs text-muted hover:bg-charcoal-700 disabled:opacity-50"
          >
            Opt out
          </button>
          <button
            disabled={pending}
            onClick={() => runBulk("optIn")}
            className="rounded-full border border-subtle px-4 py-1.5 text-xs text-muted hover:bg-charcoal-700 disabled:opacity-50"
          >
            Opt in
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-muted hover:text-offwhite"
          >
            Clear
          </button>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 border-b border-subtle px-4 py-2.5 sm:px-5">
          <input
            type="checkbox"
            checked={selected.size === clients.length && clients.length > 0}
            onChange={toggleAll}
            className="h-4 w-4 accent-gold"
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
                className="h-4 w-4 shrink-0 accent-gold"
                aria-label={`Select ${c.name}`}
              />
              <Link
                href={`/dashboard/clients/${c.id}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 hover:opacity-80"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm font-medium text-offwhite">
                    {c.name}
                    {c.source === "manual" && (
                      <span className="rounded-full bg-charcoal-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        manual
                      </span>
                    )}
                    {c.optedOut && (
                      <span className="text-[10px] uppercase tracking-wide text-danger-soft">
                        opted out
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {c.phone ?? c.email ?? "no contact"}
                    {c.lastVisitAt
                      ? ` · last ${new Date(c.lastVisitAt).toLocaleDateString()}`
                      : ""}
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
