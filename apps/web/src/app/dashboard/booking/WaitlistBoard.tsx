"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import {
  BTN_BASE,
  NAME_WRAP_CLS,
  initialsOf,
} from "../_components/appointmentCardStyles";
import {
  getWaitlistAction,
  setWaitlistStatusAction,
  type WaitlistEntry,
  type WaitlistSection,
  type WaitlistSort,
} from "./actions";
import { WaitlistAddForm } from "./WaitlistAddForm";
import type { StaffRow, ServiceRow } from "./page";
import type { Toast } from "@/components/ui/Toaster";

/**
 * The waitlist, as the barber works it.
 *
 * Five sections, because the five statuses mean genuinely different jobs:
 * WAITING is the queue, CONTACTED is "I reached out, no answer yet", BOOKED is
 * done, EXPIRED is the list's own housekeeping (phase F fills it), and REMOVED
 * is the audit trail of people who left. Nothing is deleted, ever - a barber
 * who removes someone by mistake can still see them.
 *
 * Card language is the redesigned appointment card's (shared module): the
 * CUSTOMER'S NAME is the focus and never truncates, everything else is quiet
 * around it. A waitlist card is deliberately more compact than an appointment
 * card - a barber scans forty of these looking for one person.
 */

const SECTIONS: { key: WaitlistSection; label: string }[] = [
  { key: "WAITING", label: "Waiting" },
  { key: "CONTACTED", label: "Contacted" },
  { key: "BOOKED", label: "Booked" },
  { key: "EXPIRED", label: "Expired" },
  { key: "REMOVED", label: "Removed" },
];

/** Section chip styling: gold only for the ACTIVE tab (brand rule). */
const chipCls = (active: boolean) =>
  cn(
    // 44px on mobile (the tap rule), relaxing to 36px once there is a pointer.
    "flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-xs font-medium transition-colors sm:h-9 sm:px-3.5",
    active
      ? "bg-gold/15 text-gold ring-1 ring-gold/30"
      : "text-muted hover:bg-charcoal-700 hover:text-offwhite",
  );

const STATUS_BADGE: Record<WaitlistSection, string> = {
  WAITING: "bg-gold/15 text-gold",
  CONTACTED: "bg-sky-400/15 text-sky-300",
  BOOKED: "bg-emerald-soft/15 text-emerald-soft",
  EXPIRED: "bg-charcoal-700 text-muted",
  REMOVED: "bg-charcoal-700 text-muted",
};

/** "9:00 AM" from minutes past midnight. */
function clock(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** "Aug 29" from "2026-08-29" - parsed as a calendar label, not an instant. */
function prettyDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** One preference window in the barber's words. */
function describeWindow(w: WaitlistEntry["windows"][number]): string {
  const when =
    w.startDate === null || w.endDate === null
      ? "Any date"
      : w.startDate === w.endDate
        ? prettyDate(w.startDate)
        : `${prettyDate(w.startDate)}–${prettyDate(w.endDate)}`;
  const time =
    w.startMin === null || w.endMin === null
      ? "any time"
      : `${clock(w.startMin)}–${clock(w.endMin)}`;
  return `${when} · ${time}`;
}

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function WaitlistBoard({
  staff,
  services,
  timezone,
  toast,
}: {
  staff: StaffRow[];
  services: ServiceRow[];
  timezone: string;
  toast: Toast;
}) {
  const [section, setSection] = useState<WaitlistSection>("WAITING");
  const [staffId, setStaffId] = useState<string>("");
  const [sort, setSort] = useState<WaitlistSort>("joined");
  const [rows, setRows] = useState<WaitlistEntry[]>([]);
  const [counts, setCounts] = useState<Record<WaitlistSection, number> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = useCallback(
    async (opts: { append?: boolean } = {}) => {
      setLoading(true);
      const res = await getWaitlistAction({
        status: section,
        staffId: staffId || undefined,
        sort,
        cursor: opts.append ? (cursor ?? undefined) : undefined,
      });
      setLoading(false);
      if (!res.ok) {
        toast("Couldn't load the waitlist", "error");
        return;
      }
      setRows((prev) => (opts.append ? [...prev, ...res.waitlist] : res.waitlist));
      setCounts(res.counts);
      setCursor(res.nextCursor);
    },
    [section, staffId, sort, cursor, toast],
  );

  // Reload whenever the view changes. `cursor` is deliberately NOT a dep - it
  // changes as pages append and would re-fire the first page underneath them.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, staffId, sort]);

  const providers = useMemo(() => staff.filter((s) => s.active), [staff]);

  return (
    <div className="flex flex-col gap-4">
      {/* ---- header: what this is, and the one primary action ---- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">Waitlist</h2>
          <p className="mt-0.5 text-xs text-muted">
            Everyone waiting on a spot — and what they actually asked for.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className={cn(
            "flex h-11 items-center rounded-xl px-4 text-sm font-semibold transition-colors sm:h-10",
            adding
              ? "border border-subtle text-muted hover:text-offwhite"
              : "bg-gold text-charcoal-900 hover:bg-gold/90",
          )}
        >
          {adding ? "Cancel" : "+ Add someone"}
        </button>
      </div>

      {adding && (
        <WaitlistAddForm
          staff={providers}
          services={services}
          toast={toast}
          onDone={() => {
            setAdding(false);
            setSection("WAITING");
            void load();
          }}
        />
      )}

      {/* ---- sections ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSection(s.key)}
            aria-pressed={section === s.key}
            className={chipCls(section === s.key)}
          >
            {s.label}
            {counts && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                  section === s.key ? "bg-gold/20" : "bg-charcoal-700 text-muted",
                )}
              >
                {counts[s.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ---- filters: quiet, inline, never a form ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="wl-provider">
          Filter by provider
        </label>
        <select
          id="wl-provider"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          className="h-11 rounded-lg border border-subtle bg-charcoal-800 px-3 text-xs text-offwhite sm:h-10"
        >
          <option value="">All providers</option>
          <option value="any">No preference</option>
          {providers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="flex h-11 items-center rounded-lg border border-subtle p-1 sm:h-10">
          {(
            [
              ["joined", "Joined"],
              ["requested", "Requested date"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              aria-pressed={sort === key}
              className={cn(
                "h-9 rounded-md px-3 text-xs font-medium transition-colors sm:h-8",
                sort === key ? "bg-gold/15 text-gold" : "text-muted hover:text-offwhite",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- the list ---- */}
      {loading && rows.length === 0 ? (
        <Card className="px-5 py-10 text-center">
          <p className="text-sm text-muted">Loading…</p>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState section={section} filtered={Boolean(staffId)} />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((e) => (
            <WaitlistCard
              key={e.id}
              entry={e}
              timezone={timezone}
              toast={toast}
              onChanged={() => void load()}
            />
          ))}
        </ul>
      )}

      {cursor && (
        <button
          type="button"
          onClick={() => void load({ append: true })}
          disabled={loading}
          className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite")}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

/** Each section's empty state says something true about THAT section. */
function EmptyState({
  section,
  filtered,
}: {
  section: WaitlistSection;
  filtered: boolean;
}) {
  const copy: Record<WaitlistSection, { title: string; body: string }> = {
    WAITING: {
      title: "Nobody's waiting",
      body: "When someone joins from your booking page — or you add them here — they'll line up in this list.",
    },
    CONTACTED: {
      title: "Nobody contacted yet",
      body: "Mark someone contacted once you've reached out, so you remember who's still owed an answer.",
    },
    BOOKED: {
      title: "No one booked from the list yet",
      body: "Book someone straight off the waitlist and they'll land here, linked to their appointment.",
    },
    EXPIRED: {
      title: "Nothing expired",
      body: "Requests that ran past their dates end up here instead of quietly disappearing.",
    },
    REMOVED: {
      title: "Nobody removed",
      body: "Removed requests are kept, not deleted — so you can always see who asked.",
    },
  };
  const c = copy[section];
  return (
    <Card className="px-6 py-12 text-center">
      <p className="font-display text-lg text-offwhite">{c.title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
        {filtered ? "Nobody here for this provider. Try All providers." : c.body}
      </p>
    </Card>
  );
}

function WaitlistCard({
  entry,
  timezone,
  toast,
  onChanged,
}: {
  entry: WaitlistEntry;
  timezone: string;
  toast: Toast;
  onChanged: () => void;
}) {
  const vocab = useVocab();
  const [pending, start] = useTransition();
  const name = `${entry.firstName} ${entry.lastName ?? ""}`.trim() || "Client";
  const status = entry.status as WaitlistSection;
  const joined = dayFmt.format(new Date(entry.createdAt));

  function setStatus(next: WaitlistSection, label: string, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    start(async () => {
      const res = await setWaitlistStatusAction(entry.id, next);
      toast(res.ok ? label : "Couldn't update", res.ok ? "success" : "error");
      if (res.ok) onChanged();
    });
  }

  const contact = entry.phone ?? entry.email;
  const active = status === "WAITING" || status === "CONTACTED";
  // Only the facts that exist - an empty part must never leave a dangling "·".
  const meta = [
    entry.minHoursNotice != null ? `Needs ${entry.minHoursNotice}h notice` : null,
    entry.timezone && entry.timezone !== timezone ? `their time: ${entry.timezone}` : null,
    entry.notifiedAt ? `last offered ${dayFmt.format(new Date(entry.notifiedAt))}` : null,
  ].filter((x): x is string => x !== null);

  return (
    <li className="rounded-xl border border-subtle bg-charcoal-800/60 px-4 py-3.5 shadow-[0_2px_10px_-6px_rgba(0,0,0,0.6)]">
      {/* joined + status, quiet and structural */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="whitespace-nowrap text-xs tabular-nums text-muted">
          Joined {joined}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold",
            STATUS_BADGE[status] ?? STATUS_BADGE.REMOVED,
          )}
        >
          {status === "BOOKED" && !entry.bookedAppointmentId
            ? "Booked externally"
            : status.charAt(0) + status.slice(1).toLowerCase()}
        </span>
      </div>

      {/* WHO - the focus, never truncated */}
      <div className="mt-2 flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-charcoal-700 text-[11px] font-semibold text-offwhite/80 ring-1 ring-white/10"
        >
          {initialsOf(name)}
        </span>
        <p className={cn(NAME_WRAP_CLS, "flex-1 text-[17px]")}>{name}</p>
      </div>

      {/* what they asked for */}
      <div className="mt-1.5 flex flex-col gap-1 pl-[38px] text-xs text-muted">
        <p className="[overflow-wrap:anywhere]">
          {entry.serviceName ?? "Any service"}
          {" · "}
          {entry.staffName ?? `Any ${vocab.providerNoun}`}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {entry.windows.map((w, i) => (
            <span
              key={i}
              className="rounded-md border border-subtle px-2 py-0.5 text-[11px] text-offwhite/75"
            >
              {describeWindow(w)}
            </span>
          ))}
          {entry.legacyAnyDate && (
            <span
              title="Joined before fixed 14-day windows — still eligible, no end date."
              className="rounded-md bg-charcoal-700 px-2 py-0.5 text-[11px] text-muted"
            >
              legacy
            </span>
          )}
        </div>
        {meta.length > 0 && <p className="text-[11px] text-muted/80">{meta.join(" · ")}</p>}
        {entry.preferredTime && (
          <p className="text-[11px] text-muted/80">“{entry.preferredTime}”</p>
        )}
        {entry.note && <p className="text-[11px] text-muted/80">“{entry.note}”</p>}
        {contact && (
          <p>
            {entry.phone && (
              <a href={`sms:${entry.phone}`} className="text-gold hover:underline">
                {entry.phone}
              </a>
            )}
            {entry.phone && entry.email && <span className="text-muted"> · </span>}
            {entry.email && (
              <a href={`mailto:${entry.email}`} className="text-gold hover:underline">
                {entry.email}
              </a>
            )}
          </p>
        )}
        {/* A BOOKED entry says WHICH appointment - or admits there isn't one. */}
        {status === "BOOKED" &&
          (entry.bookedAppointment ? (
            <p className="text-[11px] text-emerald-soft">
              Booked{" "}
              {new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }).format(new Date(entry.bookedAppointment.startsAt))}
              {entry.bookedAppointment.staffName
                ? ` with ${entry.bookedAppointment.staffName}`
                : ""}
            </p>
          ) : (
            <p className="text-[11px] text-muted/80">
              Booked outside ChairBack — no linked appointment.
            </p>
          ))}
      </div>

      {/* actions: only where they mean something */}
      {active && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button
            type="button"
            onClick={() => window.dispatchEvent(bookEvent(entry))}
            disabled={pending}
            className={cn(BTN_BASE, "bg-gold font-semibold text-charcoal-900 hover:bg-gold/90")}
          >
            Book appointment
          </button>
          {status !== "CONTACTED" && (
            <button
              type="button"
              onClick={() => setStatus("CONTACTED", "Marked contacted")}
              disabled={pending}
              className={cn(BTN_BASE, "border border-sky-400/40 text-sky-300 hover:bg-sky-400/10")}
            >
              Contacted
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              setStatus(
                "BOOKED",
                "Marked booked externally",
                `Mark ${name} as booked OUTSIDE ChairBack?\n\nNo appointment will be created and nothing links to your calendar. Use "Book appointment" if you want a real booking.`,
              )
            }
            disabled={pending}
            className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite")}
          >
            Booked externally
          </button>
          <button
            type="button"
            onClick={() => setStatus("REMOVED", "Removed")}
            disabled={pending}
            className={cn(BTN_BASE, "border border-danger-soft/40 text-danger-soft hover:bg-danger-soft/10")}
          >
            Remove
          </button>
        </div>
      )}
      {/* A closed entry can be put back on the list - nothing here is final. */}
      {!active && status !== "BOOKED" && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setStatus("WAITING", "Back on the list")}
            disabled={pending}
            className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite sm:w-auto sm:px-4")}
          >
            Put back on the list
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * "Book appointment" hands off to the calendar's existing AppointmentForm,
 * prefilled. A CustomEvent keeps the board from having to own the booking
 * flow (or duplicate a line of it) - BookingCalendar listens and opens the
 * form it already renders for every other create.
 */
export const WAITLIST_BOOK_EVENT = "chairback:waitlist-book";
export interface WaitlistBookDetail {
  entryId: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  serviceId: string | null;
  staffId: string | null;
  windowHint: string | null;
}
function bookEvent(entry: WaitlistEntry): CustomEvent<WaitlistBookDetail> {
  return new CustomEvent<WaitlistBookDetail>(WAITLIST_BOOK_EVENT, {
    detail: {
      entryId: entry.id,
      firstName: entry.firstName,
      lastName: entry.lastName,
      phone: entry.phone,
      email: entry.email,
      serviceId: entry.serviceId,
      staffId: entry.staffId,
      windowHint: entry.windows.length ? entry.windows.map(describeWindow).join(" · ") : null,
    },
  });
}
