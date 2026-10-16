"use client";

import { useRef, useState } from "react";
import { parseServiceMenu, type MenuItemDraft } from "@chairback/config/clientImportParse";
import { cap, useVocab } from "@/components/VocabProvider";
import { FormError } from "@/components/ui/FormError";
import { cn } from "@/lib/cn";
import { MAX_SERVICE_MINUTES, MIN_SERVICE_MINUTES, parseDuration, parsePrice } from "@/lib/serviceFields";
import { createServicesBulkAction } from "./actions";

/**
 * PASTE YOUR MENU FROM ANOTHER APP.
 *
 * A shop switching from Booksy, TheCut or Google copies its service menu from
 * its old profile and pastes it here. Parsed in the browser
 * (config parseServiceMenu), shown as a list to check and fix, and only the
 * rows still ticked are saved, in one go (API engines/serviceBulkCreate.ts).
 *
 *  - A length or price the paste didn't have stays empty; a row with no length
 *    can't be saved until one is typed. Nothing is guessed.
 *  - A name already on the menu is shown as such and never sent; the API skips
 *    it too, so a second tap or a lost answer can't double the menu.
 *  - Lines it couldn't read are listed word for word, to add by hand.
 */

interface Row {
  key: number;
  keep: boolean;
  name: string;
  minutes: string;
  price: string;
  priceIsFrom: boolean;
  description?: string;
}

const fieldClass =
  "h-10 w-full rounded-lg border border-subtle bg-charcoal-700 px-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

const nameKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function toRow(item: MenuItemDraft, key: number): Row {
  return {
    key,
    keep: true,
    name: item.name,
    minutes: item.durationMin === null ? "" : String(item.durationMin),
    price: item.priceCents === null ? "" : (item.priceCents / 100).toFixed(item.priceCents % 100 === 0 ? 0 : 2),
    priceIsFrom: item.priceIsFrom,
    ...(item.description ? { description: item.description } : {}),
  };
}

export function PasteMenu({
  existingNames,
  defaultOpen,
  toast,
}: {
  /** Names already on the menu: shown, never sent again. */
  existingNames: string[];
  /** Open from the start when the menu is still empty. */
  defaultOpen: boolean;
  toast: (msg: string, kind?: "success" | "error") => void;
}) {
  const vocab = useVocab();
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [unread, setUnread] = useState<string[]>([]);
  const [repeated, setRepeated] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A second tap in the same frame must not send twice.
  const busy = useRef(false);

  const taken = new Set(existingNames.map(nameKey));
  const already = (r: Row) => taken.has(nameKey(r.name));

  function read() {
    const parsed = parseServiceMenu(text);
    setError(null);
    setUnread(parsed.unread);
    setRepeated(parsed.repeated);
    setRows(parsed.items.map(toRow).map((r) => (taken.has(nameKey(r.name)) ? { ...r, keep: false } : r)));
  }

  function update(key: number, patch: Partial<Row>) {
    setRows((cur) => (cur ? cur.map((r) => (r.key === key ? { ...r, ...patch } : r)) : cur));
  }

  const kept = (rows ?? []).filter((r) => r.keep && !already(r));
  // What each kept row would save as, or why it can't yet.
  const checked = kept.map((r) => {
    const name = r.name.replace(/\s+/g, " ").trim();
    const length = parseDuration(r.minutes, { min: MIN_SERVICE_MINUTES, max: MAX_SERVICE_MINUTES });
    const price = parsePrice(r.price);
    const problem = !name
      ? "Give it a name."
      : !r.minutes.trim()
        ? "Add how long it takes."
        : !length.ok
          ? length.error
          : !price.ok
            ? price.error
            : null;
    return { row: r, name, minutes: length.ok ? length.value : null, price: price.ok ? price.value : null, problem };
  });
  const problems = checked.filter((c) => c.problem !== null);
  const sameNameTwice = new Set<string>();
  const seen = new Set<string>();
  for (const c of checked) {
    const k = nameKey(c.name);
    if (k && seen.has(k)) sameNameTwice.add(c.name);
    seen.add(k);
  }

  async function save() {
    if (busy.current || problems.length > 0 || sameNameTwice.size > 0 || checked.length === 0) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await createServicesBulkAction(
        checked.map((c) => ({
          name: c.name,
          durationMin: c.minutes!,
          price: c.price ?? null,
          ...(c.row.description ? { description: c.row.description.slice(0, 800) } : {}),
        })),
      );
      if (!res.ok) {
        setError(
          res.answered
            ? "Couldn't add them. Nothing was changed - check the list and try again."
            : "No answer from ChairBack. Tap Add again: anything already added is skipped, never doubled.",
        );
        return;
      }
      const skippedNote = res.skipped.length > 0 ? ` ${res.skipped.join(", ")} ${res.skipped.length === 1 ? "was" : "were"} already on your menu.` : "";
      toast(`Added ${res.created} ${res.created === 1 ? "service" : "services"}.${skippedNote}`, "success");
      setRows(null);
      setText("");
      setUnread([]);
      setRepeated([]);
      setOpen(false);
    } catch {
      setError("No answer from ChairBack. Tap Add again: anything already added is skipped, never doubled.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 text-sm text-gold underline-offset-4 hover:underline"
      >
        Paste your menu from another app
      </button>
    );
  }

  return (
    <section className="mt-4 rounded-xl border border-subtle p-4" data-testid="paste-menu">
      <h3 className="text-sm font-semibold text-offwhite">Paste your menu from another app</h3>
      {!rows && (
        <>
          <p className="mt-1 text-xs text-muted">
            Copy your services from your Booksy, TheCut or Google profile and paste them here. You&apos;ll check every
            one before anything is added.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            aria-label="Your menu"
            placeholder={`${cap(vocab.serviceNoun)} - $40 · 45 min\nConsultation - free · 15 min`}
            className="mt-3 w-full rounded-lg border border-subtle bg-charcoal-700 p-3 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={read}
              disabled={!text.trim()}
              className="h-11 rounded-lg bg-gold px-4 text-sm font-semibold text-charcoal-900 disabled:opacity-50 sm:h-9"
            >
              Read my menu
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-11 rounded-lg border border-subtle px-4 text-sm font-medium text-offwhite hover:bg-charcoal-700 sm:h-9"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {rows && (
        <>
          <p role="status" className="mt-2 text-sm text-offwhite">
            {rows.length === 0
              ? "Couldn't find any services in that. Try copying the menu again, or add them below."
              : `Found ${rows.length} ${rows.length === 1 ? "service" : "services"}. Check each one, untick any you don't want, then add them.`}
          </p>
          {rows.length > 0 && (
            // A phone scrolls the page, not a box inside it: a row's "add a
            // length" note must never sit hidden below an inner fold.
            <ul className="mt-3 flex flex-col gap-2 sm:max-h-[28rem] sm:overflow-y-auto">
              {rows.map((r) => {
                const isAlready = already(r);
                const issue = checked.find((c) => c.row.key === r.key)?.problem ?? null;
                return (
                  <li
                    key={r.key}
                    data-testid="paste-menu-row"
                    className={cn(
                      "rounded-lg border px-3 py-2",
                      r.keep && !isAlready ? "border-gold/40" : "border-subtle opacity-70",
                    )}
                  >
                    <div className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2 sm:grid-cols-[auto_1fr_96px_96px]">
                      <input
                        type="checkbox"
                        checked={r.keep && !isAlready}
                        disabled={isAlready}
                        onChange={(e) => update(r.key, { keep: e.target.checked })}
                        aria-label={`Add ${r.name || "this service"}`}
                        className="mt-3"
                      />
                      <input
                        value={r.name}
                        onChange={(e) => update(r.key, { name: e.target.value })}
                        aria-label="Name"
                        maxLength={120}
                        className={cn(fieldClass, "min-w-0")}
                      />
                      <label className="col-start-2 flex items-center gap-1 text-xs text-muted sm:col-start-auto">
                        <input
                          value={r.minutes}
                          onChange={(e) => update(r.key, { minutes: e.target.value })}
                          inputMode="numeric"
                          aria-label={`Minutes for ${r.name || "this service"}`}
                          className={fieldClass}
                        />
                        min
                      </label>
                      <label className="col-start-2 flex items-center gap-1 text-xs text-muted sm:col-start-auto">
                        $
                        <input
                          value={r.price}
                          onChange={(e) => update(r.key, { price: e.target.value, priceIsFrom: false })}
                          inputMode="decimal"
                          placeholder="none"
                          aria-label={`Price for ${r.name || "this service"}`}
                          className={fieldClass}
                        />
                      </label>
                    </div>
                    {isAlready && <p className="mt-1 text-xs text-muted">Already on your menu - left as it is.</p>}
                    {!isAlready && r.keep && issue && <FormError className="mt-1">{issue}</FormError>}
                    {!isAlready && r.priceIsFrom && (
                      <p className="mt-1 text-xs text-muted">Your old menu said &ldquo;from&rdquo; this price.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {repeated.length > 0 && (
            <p className="mt-3 text-xs text-muted">Pasted more than once, kept once: {repeated.join(", ")}.</p>
          )}
          {unread.length > 0 && (
            <div className="mt-3 text-xs text-muted">
              <p>These lines had no price or length to go on. If any is a service, add it below:</p>
              <ul className="mt-1 list-disc pl-5">
                {unread.map((u) => (
                  <li key={u} className="[overflow-wrap:anywhere]">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            New services are offered by everyone on your team and use your regular hours.
          </p>
          {sameNameTwice.size > 0 && (
            <FormError className="mt-2">Two services can&apos;t share a name: {[...sameNameTwice].join(", ")}.</FormError>
          )}
          <FormError className="mt-2">{error}</FormError>
          {/* A greyed-out Add says why, beside it. */}
          {problems.length > 0 && (
            <p className="mt-2 text-xs text-muted" data-testid="paste-menu-blocked">
              {`${problems[0]!.name || "A service"}: ${problems[0]!.problem!.charAt(0).toLowerCase()}${problems[0]!.problem!.slice(1)}`}
              {problems.length > 1 ? ` And ${problems.length - 1} more above.` : ""}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {checked.length > 0 && (
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || problems.length > 0 || sameNameTwice.size > 0}
                className="h-11 rounded-lg bg-gold px-4 text-sm font-semibold text-charcoal-900 disabled:opacity-50 sm:h-9"
              >
                {saving ? "Adding…" : `Add ${checked.length} ${checked.length === 1 ? "service" : "services"}`}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setRows(null);
                setError(null);
              }}
              disabled={saving}
              className="h-11 rounded-lg border border-subtle px-4 text-sm font-medium text-offwhite hover:bg-charcoal-700 disabled:opacity-50 sm:h-9"
            >
              Back to the pasted text
            </button>
          </div>
        </>
      )}
    </section>
  );
}
