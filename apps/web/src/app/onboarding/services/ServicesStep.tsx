"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ServiceTemplate } from "@chairback/config/businessTypes";
import { FormError } from "@/components/ui/FormError";
import { cn } from "@/lib/cn";
import { MAX_SERVICE_MINUTES, MIN_SERVICE_MINUTES, parseDuration, parsePrice } from "@/lib/serviceFields";
import { PasteMenu } from "@/app/dashboard/booking/PasteMenu";
import { createServicesBulkAction } from "@/app/dashboard/booking/actions";

const primary =
  "inline-flex h-11 w-full items-center justify-center rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";
const field =
  "h-10 w-full rounded-lg border border-subtle bg-charcoal-700 px-2 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";

interface StarterRow {
  key: string;
  pick: boolean;
  name: string;
  minutes: string;
  price: string;
}

/**
 * Setup: what clients can book. Two ways in, both checked before anything is
 * added: paste the menu from the old app (the same screen as Services), or
 * tick from a starter list for their kind of business. The starter list
 * starts unticked - a template becomes a service only when the owner ticks it.
 */
export function ServicesStep({
  existing,
  templates,
  next,
}: {
  existing: string[];
  templates: ServiceTemplate[];
  next: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  const [rows, setRows] = useState<StarterRow[]>(() =>
    templates
      .filter((t) => !existing.some((e) => e.trim().toLowerCase() === t.name.trim().toLowerCase()))
      .map((t) => ({
        key: t.id,
        pick: false,
        name: t.name,
        minutes: String(t.durationMin),
        price: t.priceCents === null ? "" : String(t.priceCents / 100),
      })),
  );
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const added = (msg: string, kind?: "success" | "error") => {
    setNote(kind === "error" ? null : msg);
    if (kind !== "error") router.refresh();
  };

  const picked = rows.filter((r) => r.pick);
  const checked = picked.map((r) => {
    const length = parseDuration(r.minutes, { min: MIN_SERVICE_MINUTES, max: MAX_SERVICE_MINUTES });
    const price = parsePrice(r.price);
    const problem = !r.name.trim()
      ? "Give it a name."
      : !length.ok || length.value === null
        ? `${r.name}: add how long it takes.`
        : !price.ok
          ? `${r.name}: ${price.error}`
          : null;
    return { r, minutes: length.ok ? length.value : null, price: price.ok ? price.value : null, problem };
  });
  const problem = checked.find((c) => c.problem)?.problem ?? null;

  async function addStarters() {
    if (busy.current || problem || checked.length === 0) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await createServicesBulkAction(
        checked.map((c) => ({ name: c.r.name.trim(), durationMin: c.minutes!, price: c.price ?? null })),
      );
      if (!res.ok) {
        setError(
          res.answered
            ? "Couldn't add them. Nothing was changed - try again."
            : "No answer from ChairBack. Tap Add again: anything already added is skipped.",
        );
        return;
      }
      setRows((cur) => cur.filter((r) => !r.pick));
      added(`Added ${res.created} ${res.created === 1 ? "service" : "services"}.`);
    } catch {
      setError("No answer from ChairBack. Tap Add again: anything already added is skipped.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {existing.length > 0 && (
        <div className="rounded-2xl border border-subtle p-4" data-testid="services-so-far">
          <p className="text-sm text-emerald-soft">
            {existing.length} {existing.length === 1 ? "service" : "services"} on your menu
          </p>
          <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">{existing.slice(0, 12).join(" · ")}</p>
        </div>
      )}
      {note && (
        <p role="status" className="text-sm text-emerald-soft">
          {note}
        </p>
      )}

      <div className="rounded-2xl border border-subtle p-4">
        <PasteMenu existingNames={existing} defaultOpen={existing.length === 0} toast={added} />
      </div>

      {rows.length > 0 && (
        <div className="rounded-2xl border border-subtle p-4" data-testid="starter-list">
          <h2 className="text-sm font-semibold text-offwhite">Or start from a list</h2>
          <p className="mt-1 text-xs text-muted">Tick what you offer, set your prices, then add them.</p>
          <ul className="mt-3 flex flex-col gap-2">
            {rows.map((r) => (
              <li
                key={r.key}
                className={cn(
                  "grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 sm:grid-cols-[auto_1fr_88px_88px]",
                  r.pick ? "border-gold/40" : "border-subtle",
                )}
              >
                <input
                  type="checkbox"
                  checked={r.pick}
                  onChange={(e) => setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, pick: e.target.checked } : x)))}
                  aria-label={`Offer ${r.name}`}
                />
                <span className="min-w-0 text-sm text-offwhite">{r.name}</span>
                <label className="col-start-2 flex items-center gap-1 text-xs text-muted sm:col-start-auto">
                  <input
                    value={r.minutes}
                    onChange={(e) => setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, minutes: e.target.value } : x)))}
                    inputMode="numeric"
                    aria-label={`Minutes for ${r.name}`}
                    className={field}
                  />
                  min
                </label>
                <label className="col-start-2 flex items-center gap-1 text-xs text-muted sm:col-start-auto">
                  $
                  <input
                    value={r.price}
                    onChange={(e) => setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, price: e.target.value } : x)))}
                    inputMode="decimal"
                    placeholder="none"
                    aria-label={`Price for ${r.name}`}
                    className={field}
                  />
                </label>
              </li>
            ))}
          </ul>
          {picked.length > 0 && problem && <p className="mt-2 text-xs text-muted">{problem}</p>}
          <FormError className="mt-2">{error}</FormError>
          {picked.length > 0 && (
            <button
              type="button"
              onClick={() => void addStarters()}
              disabled={pending || Boolean(problem)}
              className="mt-3 h-11 rounded-lg bg-gold px-4 text-sm font-semibold text-charcoal-900 disabled:opacity-50 sm:h-9"
            >
              {pending ? "Adding…" : `Add ${picked.length} ${picked.length === 1 ? "service" : "services"}`}
            </button>
          )}
        </div>
      )}

      {existing.length > 0 ? (
        <a href={next} className={primary}>
          Continue
        </a>
      ) : (
        <a href={next} className="text-center text-xs text-muted underline-offset-4 hover:text-offwhite hover:underline">
          I&apos;ll add my services later
        </a>
      )}
    </div>
  );
}
