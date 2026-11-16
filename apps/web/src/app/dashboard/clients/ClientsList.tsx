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
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import { bulkClientAction } from "../actions";
import { initialsOf } from "../_components/appointmentCardStyles";

/** "Nov 13" this year, "Sep 27, 2025" for an older visit. */
function shortDate(iso: string): Intl.DateTimeFormatOptions {
  const sameYear = new Date(iso).getUTCFullYear() === new Date().getUTCFullYear();
  return sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
}

function TickMark() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export interface ClientRow {
  id: string;
  name: string;
  /** The shop had no name, so `name` is what the customer set in their own app. */
  nameFromApp?: boolean;
  /** Bare Instagram handle - what tells two same-named clients apart. */
  instagram?: string | null;
  phone: string | null;
  email: string | null;
  optedOut: boolean;
  smsConsent: boolean;
  archived?: boolean;
  /** The shop blocked them from booking online. Optional: an older API sends none. */
  bookingBlocked?: boolean;
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
export function ClientsList({
  clients,
  filtered = false,
}: {
  clients: ClientRow[];
  /** A search or filter is narrowing the list: an empty one means "none match", not "none yet". */
  filtered?: boolean;
}) {
  const { toast } = useToast();
  // No "upgrade" steering inside the iOS app (Guideline 3.1.1) - the Billing
  // page is hidden there, so the hint would point at nothing anyway.
  const inApp = useIsNativeApp();
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
        if (action === "optIn" && (r.lockedByStop ?? 0) > 0) {
          toast(
            `${r.lockedByStop} skipped: they texted STOP, so only they can opt back in`,
            "error",
          );
        }
        setSelected(new Set());
      } else if (r.error === "subscription_required" || r.error === "premium_required") {
        toast(
          inApp
            ? "Texting is a Premium feature"
            : "Texting is a Premium feature - upgrade from the Billing page",
          "error",
        );
      } else if (r.error === "quiet_hours") {
        toast("Texting is paused 9pm-8am (client local time)", "error");
      } else {
        toast("Bulk action failed", "error");
      }
    });
  }

  if (clients.length === 0) {
    return (
      <Card className="overflow-hidden">
        <p className="px-5 py-8 text-center text-sm text-muted">
          {filtered
            ? "No clients match these filters."
            : "No clients found. Use “Add client” for walk-ins, or connect Acuity to sync your appointment history."}
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
            className="rounded-md bg-primary min-h-[44px] px-4 text-sm font-semibold text-on-primary transition-colors duration-150 ease-out hover:bg-primary/90 disabled:opacity-50"
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
            className="rounded-md border border-emerald-soft/40 min-h-[44px] px-4 text-sm text-emerald-soft transition-colors duration-150 ease-out hover:bg-emerald-soft/10 disabled:opacity-50"
          >
            Mark consent
          </button>
          <button
            disabled={pending}
            onClick={() => runBulk("optOut")}
            className="rounded-md border border-subtle min-h-[44px] px-4 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
          >
            Opt out
          </button>
          <button
            disabled={pending}
            onClick={() => runBulk("optIn")}
            className="rounded-md border border-subtle min-h-[44px] px-4 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
          >
            Opt in
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto min-h-[44px] px-2 text-sm text-muted transition-colors duration-150 ease-out hover:text-offwhite"
          >
            Clear
          </button>
        </div>
      )}

      <Card className="overflow-hidden">
        <label className="flex min-h-[44px] cursor-pointer items-center gap-3 border-b border-subtle px-3 sm:px-4">
          <span className="flex w-11 shrink-0 justify-center">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-5 w-5 accent-gold"
              aria-label="Select all"
            />
          </span>
          <span className="text-xs text-muted">Select all, or tap a client&apos;s initials</span>
        </label>
        <ul className="divide-y divide-subtle">
          {clients.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
              {/* The avatar IS the row's checkbox (Studio): tap it to select,
                  it turns to a tick. Still a real checkbox underneath, so a
                  keyboard and a screen reader get "Select <name>" as before. */}
              <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="peer sr-only"
                  aria-label={`Select ${c.name}`}
                />
                <span
                  aria-hidden
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-charcoal-700 text-sm font-semibold text-offwhite transition-colors duration-150 ease-out peer-checked:bg-primary peer-checked:text-on-primary peer-focus-visible:ring-2 peer-focus-visible:ring-gold"
                >
                  {selected.has(c.id) ? <TickMark /> : initialsOf(c.name || "Client")}
                </span>
              </label>
              <Link
                href={`/dashboard/clients/${c.id}`}
                className="flex min-h-[44px] min-w-0 flex-1 items-center justify-between gap-3 transition-opacity duration-150 ease-out hover:opacity-80"
              >
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-offwhite">
                    {c.name}
                    {/* Plain text: the whole row is already a link. */}
                    {c.instagram && <span className="font-normal text-muted"> @{c.instagram}</span>}
                  </p>
                  {/* One line of what a barber scans for: how often, and when
                      they were last in. The phone lives on the profile (and
                      search finds it): at 390px it only ever showed half. */}
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {c.frequencySegment && FREQUENCY_SEGMENTS[c.frequencySegment].label}
                    {c.frequencySegment && c.lastVisitAt && " · "}
                    {c.lastVisitAt ? (
                      <>
                        {"last "}
                        <LocalDate iso={c.lastVisitAt} options={shortDate(c.lastVisitAt)} />
                      </>
                    ) : (
                      !c.frequencySegment && "No visits yet"
                    )}
                  </p>
                  {/* Only the exceptions get a badge - they carry the consent /
                      opt-out signal, so they wrap on their own line rather
                      than being pushed off-screen by a long name. */}
                  {(c.nameFromApp ||
                    c.optedOut ||
                    !c.smsConsent ||
                    c.archived ||
                    c.bookingBlocked ||
                    (!c.phone && !c.email)) && (
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {/* Nothing to reach them by: no reminder, no nudge by
                          text or email. Worth fixing, so it is flagged. */}
                      {!c.phone && !c.email && (
                        <span className="rounded-md bg-charcoal-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                          no contact
                        </span>
                      )}
                      {/* The shop had no name for this row; the one shown is the
                          customer's own, from their ChairBack app - say so. */}
                      {c.nameFromApp && (
                        <span
                          className="rounded-md bg-charcoal-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                          title="You have no name for this client. This is the name they set in their own ChairBack app."
                        >
                          name from app
                        </span>
                      )}
                      {c.archived && (
                        <span className="rounded-md bg-charcoal-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted/80">
                          archived
                        </span>
                      )}
                      {c.bookingBlocked && (
                        <span
                          className="rounded-md bg-danger-soft/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-danger-soft"
                          title="Blocked from booking online - they can't book, join your waitlist or move a booking themselves"
                        >
                          blocked
                        </span>
                      )}
                      {c.optedOut && (
                        <span className="rounded-md bg-danger-soft/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-danger-soft">
                          opted out
                        </span>
                      )}
                      {!c.optedOut && !c.smsConsent && (
                        <span
                          className="rounded-md bg-gold/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gold/90"
                          title="No SMS consent on file - this client won't be texted until they opt in"
                        >
                          needs consent
                        </span>
                      )}
                    </span>
                  )}
                </div>
                {/* Standing on the right, as on the board: the tier, then the
                    punch balance said in words (a bare gold "2" read as nothing). */}
                {(c.loyaltyTier || c.balance > 0) && (
                  <span className="shrink-0 text-right">
                    {c.loyaltyTier && (
                      // Ink text with the tier's colour as a dot: Silver's
                      // #C7CBD1 as TEXT vanished on the light theme.
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full border border-subtle px-2 py-0.5 text-[11px] font-semibold text-offwhite"
                        title="Loyalty tier (set by your tier rules on Rewards, or raised by hand)"
                      >
                        <span
                          aria-hidden
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: LOYALTY_TIERS[c.loyaltyTier].color }}
                        />
                        {LOYALTY_TIERS[c.loyaltyTier].label}
                      </span>
                    )}
                    {c.balance > 0 && (
                      <span className="mt-0.5 block text-[11px] tabular-nums text-muted" title="Punch balance">
                        {c.balance} {c.balance === 1 ? "punch" : "punches"}
                      </span>
                    )}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
