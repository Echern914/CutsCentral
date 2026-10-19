"use client";

import { useRef, useState, type DragEvent } from "react";
import { FormError } from "@/components/ui/FormError";
import { cn } from "@/lib/cn";
import { reorderServicesAction } from "./actions";

/**
 * Put the services in the order clients see them (Snow, CutBySnow: "I
 * recommend adding an ability to move services up and down so retyping them
 * doesn't get a lil crazy"). Until this, the only way to move a service was to
 * delete it and type it in again.
 *
 * Two ways to move one, because the dashboard is ALSO the iPhone app's
 * WebView, where HTML drag-and-drop is unreliable:
 *  - the ≡ handle drags, where the browser supports it (a desktop, an iPad);
 *  - the ▲ / ▼ buttons always work - big tap targets, one step per tap.
 *
 * 🔴 NOTHING MOVES UNTIL IT IS SAVED. Each move sends the whole new order in
 * one request; the list changes only when the API answers with the order it
 * now holds (`onSaved`). A failed save leaves the list exactly where it was and
 * says so - the row never jumps and then jumps back, and a "moved" row is
 * never one the booking page doesn't have.
 */
export function ServiceOrderList({
  services,
  hasGroups,
  onSaved,
  toast,
}: {
  /** Every active service, in the order the list shows them now. */
  services: { id: string; name: string; hidden: boolean }[];
  /** The shop has a service group with members: say what this order governs. */
  hasGroups: boolean;
  /** The order the database now holds, after a successful save. */
  onSaved: (ids: string[]) => void;
  toast: (msg: string, kind?: "success" | "error") => void;
}) {
  // A plain flag, not useTransition: the save must hold every control
  // disabled until the answer is back, and a ref so two taps inside one tick
  // can't both send (state alone updates a render late).
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Spoken after a successful move, so a screen-reader user hears where the
  // service landed (the button they pressed may now be in a different row).
  const [announce, setAnnounce] = useState("");

  async function save(next: string[], moved: { id: string; name: string }) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    setAnnounce("");
    let r: Awaited<ReturnType<typeof reorderServicesAction>>;
    try {
      r = await reorderServicesAction(next);
    } catch {
      r = { ok: false, error: "network" };
    }
    inFlight.current = false;
    setPending(false);
    if (r.ok && r.ids) {
      onSaved(r.ids);
      const pos = r.ids.indexOf(moved.id);
      setAnnounce(pos >= 0 ? `${moved.name} moved to position ${pos + 1} of ${r.ids.length}.` : "Order saved.");
      return;
    }
    const msg =
      r.error === "incomplete_list" || r.error === "unknown_service"
        ? "Your services changed since this page loaded. Refresh the page, then move it again."
        : "Couldn't save the new order. Nothing moved - try again.";
    setError(msg);
    toast(msg, "error");
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (pending || target < 0 || target >= services.length) return;
    const ids = services.map((s) => s.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void save(ids, services[index]!);
  }

  function drop(targetId: string) {
    const from = services.findIndex((s) => s.id === dragId);
    const to = services.findIndex((s) => s.id === targetId);
    setDragId(null);
    setOverId(null);
    if (pending || from === -1 || to === -1 || from === to) return;
    const ids = services.map((s) => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    void save(ids, services[from]!);
  }

  return (
    <div className="mt-5">
      <p className="text-xs text-muted">
        Clients see your services in this order. Use the arrows, or drag a row by its ≡ handle.
        {hasGroups && " Services inside a group keep that group's own order - set it under Service groups."}
      </p>
      <p className="mt-1 min-h-[1rem] text-xs text-muted" aria-live="polite">
        {pending ? "Saving…" : announce}
      </p>
      <FormError className="mt-1">{error}</FormError>
      <ol className="mt-2 flex flex-col gap-2" aria-label="Service order">
        {services.map((s, i) => (
          <li
            key={s.id}
            data-testid="service-order-row"
            draggable={!pending}
            onDragStart={(e: DragEvent) => {
              setDragId(s.id);
              // Firefox starts no drag without data on the transfer.
              e.dataTransfer?.setData("text/plain", s.id);
            }}
            onDragOver={(e: DragEvent) => {
              if (dragId) {
                e.preventDefault();
                setOverId(s.id);
              }
            }}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              drop(s.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            className={cn(
              "flex items-center gap-2 rounded-xl border border-gold/25 bg-charcoal-800/40 py-1 pl-1 pr-1 transition-[border-color,box-shadow,opacity] duration-150 ease-out",
              dragId === s.id && "opacity-50",
              overId === s.id && dragId && dragId !== s.id && "border-gold/70 ring-2 ring-gold/40",
            )}
          >
            <span
              aria-hidden="true"
              title="Drag to move"
              className="flex h-11 w-9 shrink-0 cursor-grab items-center justify-center text-lg text-muted active:cursor-grabbing"
            >
              ≡
            </span>
            <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted">{i + 1}.</span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-offwhite">
              <span className="min-w-0 truncate" data-testid="service-order-name">
                {s.name}
              </span>
              {s.hidden && (
                <span className="shrink-0 rounded-full border border-subtle px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                  Hidden
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={pending || i === 0}
              aria-label={`Move ${s.name} up`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-subtle text-offwhite transition-colors hover:border-gold/50 hover:text-gold disabled:opacity-30 disabled:hover:border-subtle disabled:hover:text-offwhite"
            >
              <Chevron dir="up" />
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={pending || i === services.length - 1}
              aria-label={`Move ${s.name} down`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-subtle text-offwhite transition-colors hover:border-gold/50 hover:text-gold disabled:opacity-30 disabled:hover:border-subtle disabled:hover:text-offwhite"
            >
              <Chevron dir="down" />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Chevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={dir === "up" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}

/**
 * `rows` in the order `ids` gives. Rows `ids` doesn't name (a service added
 * after that order was saved) keep their own relative order, after the rest.
 */
export function inSavedOrder<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return rows
    .map((row, i) => ({ row, key: rank.get(row.id) ?? ids.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.row);
}
