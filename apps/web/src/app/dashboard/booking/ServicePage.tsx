"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isHiddenService } from "@chairback/config/serviceVisibility";
import { cn } from "@/lib/cn";
import { createServiceAction, deleteServiceAction, updateServiceAction } from "./actions";
import type { ServiceRow } from "./page";
import { duplicatePayload } from "./serviceRowValues";

/**
 * THE ONE-SERVICE PAGE.
 *
 * Editing a service used to be one tall form: every editor open at once, the
 * seven-day grids stacked under each other, and Save at the bottom of all of
 * it. To change one price a barber scrolled past everything else, and could
 * not tell at a glance how the service was set up.
 *
 * Now each setting is a ROW that says what it is set to. Tap a row and its
 * editor opens under it; the rest stay closed. One Save writes the lot.
 *
 * These are the pieces: a titled group of rows, the row that opens, a row
 * that goes somewhere else, a row that only tells, and the three things that
 * act on the service right away (show or hide, duplicate, remove).
 */

const rowCls =
  "flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left transition-colors duration-150 ease-out";

function Chevron({ open = false }: { open?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 text-muted transition-transform duration-150 ease-out", open && "rotate-90")}
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

/** A titled card of rows. */
export function SettingGroup({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
      <div className="mt-2 overflow-hidden rounded-2xl border border-subtle bg-charcoal-800/40">
        {children}
      </div>
    </section>
  );
}

/**
 * A setting and what it is set to. Tapping it opens its editor underneath.
 *
 * The editor stays MOUNTED while the row is closed: it is hidden, not
 * removed, so whatever it holds is still there when the row is opened again.
 */
export function SettingRow({
  id,
  label,
  value,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  value: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const panel = `${id}-panel`;
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  // Opening one row closes whichever was open. If that one sat above, the
  // page moves up by its whole height and the row just tapped can end up off
  // the top of a phone. Bring it back - only as far as needed, and only when
  // it has just opened.
  useEffect(() => {
    if (open && !wasOpen.current) button.current?.scrollIntoView?.({ block: "nearest" });
    wasOpen.current = open;
  }, [open]);
  return (
    // The id and the margin are for a page that brings the WHOLE row to the
    // top itself (the Special dates list does, for a tool far below it); the
    // margin keeps it clear of the dashboard's sticky bar.
    <div id={id} className="scroll-mt-24 border-b border-subtle last:border-b-0">
      <button
        ref={button}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panel}
        className={cn(rowCls, "hover:bg-charcoal-700/40")}
      >
        <span className="shrink-0 text-sm text-offwhite">{label}</span>
        <span className="min-w-0 flex-1 truncate text-right text-sm text-muted">{value}</span>
        <Chevron open={open} />
      </button>
      {/* No display class on this one: a `flex` or `grid` here beats `hidden`. */}
      <div id={panel} hidden={!open}>
        <div className="px-3.5 pb-4 pt-1">{children}</div>
      </div>
    </div>
  );
}

/** A row that opens something else (the dates sheet), with a line saying what. */
export function GoRow({
  label,
  hint,
  value,
  onClick,
}: {
  label: string;
  hint: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <div className="border-b border-subtle last:border-b-0">
      <button type="button" onClick={onClick} className={cn(rowCls, "hover:bg-charcoal-700/40")}>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-offwhite">{label}</span>
          <span className="block text-xs text-muted">{hint}</span>
        </span>
        <span className="shrink-0 text-sm text-muted">{value}</span>
        <Chevron />
      </button>
    </div>
  );
}

/** A row that only tells: the setting lives somewhere else. */
export function InfoRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="border-b border-subtle px-3.5 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-sm text-offwhite">{label}</span>
        <span className="min-w-0 flex-1 truncate text-right text-sm text-muted">{value}</span>
      </div>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

/**
 * Show or hide, duplicate, remove. They were five small links on every row of
 * the menu; they now sit on the service's own page, each a full-height row.
 *
 * 🔴 They act on the service AS SAVED and they act RIGHT AWAY - Save is not
 * involved, and the page says so. What happened is said HERE, under the rows:
 * a toast raised from inside a sheet is drawn behind it on a phone.
 */
export function ServiceOwnActions({
  service,
  groupName,
  onVisibility,
  onRemoved,
}: {
  /** The service as the server holds it (never the unsaved draft). */
  service: ServiceRow;
  groupName: string | null;
  onVisibility: (hidden: boolean) => void;
  /** The service is gone: close the page. */
  onRemoved: () => void;
}) {
  const hidden = isHiddenService(service);
  const [busy, setBusy] = useState(false);
  // A ref as well as the state: two taps in one tick both see `busy` false.
  const inFlight = useRef(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run(work: () => Promise<{ ok: boolean }>): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    let ok = false;
    try {
      ok = (await work()).ok;
    } catch {
      // The phone lost its connection before the server could answer.
      ok = false;
    }
    inFlight.current = false;
    setBusy(false);
    return ok;
  }

  async function flip() {
    const hide = !hidden;
    const ok = await run(() =>
      updateServiceAction(service.id, { visibility: hide ? "hidden" : "public" }),
    );
    if (!ok) {
      setNote({ tone: "error", text: "Couldn't change that. Nothing was changed - try again." });
      return;
    }
    onVisibility(hide);
    setNote({
      tone: "ok",
      text: hide
        ? "Hidden from clients. You can still book it yourself."
        : "Back on your booking page.",
    });
  }

  async function copy() {
    const ok = await run(() => createServiceAction(duplicatePayload(service)));
    setNote(
      ok
        ? {
            tone: "ok",
            text: `Copied. "${duplicatePayload(service).name}" is on your menu, made from what is saved here.`,
          }
        : { tone: "error", text: "Couldn't duplicate. Nothing was added - try again." },
    );
  }

  async function remove() {
    if (
      !window.confirm(
        `Remove "${service.name}"? Its prices, hours and staff setup are deleted` +
          (groupName ? ` and it leaves the "${groupName}" group` : "") +
          ". This can't be undone.",
      )
    ) {
      return;
    }
    const ok = await run(() => deleteServiceAction(service.id));
    if (ok) onRemoved();
    else setNote({ tone: "error", text: "Couldn't remove it. Nothing was changed - try again." });
  }

  return (
    <div>
      <SettingGroup title="This service" note="These happen right away. Save is for the settings above.">
        <div className="border-b border-subtle">
          <button
            type="button"
            role="switch"
            aria-checked={!hidden}
            aria-label="Shown to clients"
            aria-describedby="service-shown-hint"
            onClick={flip}
            disabled={busy}
            className={cn(rowCls, "hover:bg-charcoal-700/40 disabled:opacity-50")}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-offwhite">Shown to clients</span>
              <span id="service-shown-hint" className="block text-xs text-muted">
                {hidden
                  ? "Hidden: off your booking page. Only you can book it."
                  : "On your booking page."}
              </span>
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "shrink-0 rounded-full px-4 py-2 text-xs font-medium",
                hidden ? "border border-subtle text-muted" : "bg-emerald-soft/15 text-emerald-soft",
              )}
            >
              {hidden ? "Off" : "On"}
            </span>
          </button>
        </div>
        <div className="border-b border-subtle">
          <button
            type="button"
            onClick={copy}
            disabled={busy}
            aria-label={`Duplicate ${service.name}`}
            className={cn(rowCls, "hover:bg-charcoal-700/40 disabled:opacity-50")}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-offwhite">Duplicate</span>
              <span className="block text-xs text-muted">Start a new service from this one.</span>
            </span>
          </button>
        </div>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label={`Remove ${service.name}`}
          className={cn(rowCls, "text-sm text-danger-soft hover:bg-charcoal-700/40 disabled:opacity-50")}
        >
          Remove this service
        </button>
      </SettingGroup>
      {note && (
        <p
          role={note.tone === "error" ? "alert" : "status"}
          className={cn("mt-2 text-xs", note.tone === "error" ? "text-danger-soft" : "text-emerald-soft")}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
