"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  getSquareSetupAction,
  refreshSquareCapabilityAction,
  setSquareLocationAction,
  setSquareModeAction,
  setSquareTeamMemberAction,
  setSquareVariationAction,
  type SquareConnectionProblem,
  type SquareMappingProblem,
  type SquareSetupData,
} from "./actions";

/**
 * SQUARE CALENDAR PROTECTION - the setup screen.
 *
 * Square has no blocked-time concept, so protecting a chair means creating a
 * real Square Booking, and a Booking names a location, a team member and a
 * service variation. This card is where a manager supplies all three and sees,
 * in one place, whether a real write would actually succeed.
 *
 * The design brief it answers: never show a green light that isn't true. Every
 * refusal names the specific thing to fix and the person or service it belongs
 * to, because "not ready" on its own sends an owner hunting through Square for
 * a problem that is one dropdown away.
 */

const MODES = ["OFF", "OBSERVE", "ENFORCE"] as const;
type Mode = (typeof MODES)[number];

const MODE_COPY: Record<Mode, { label: string; blurb: string }> = {
  OFF: { label: "Off", blurb: "Square is never written to. Bookings sync in only." },
  OBSERVE: {
    label: "Rehearse",
    blurb: "Shows exactly what would be sent to Square. Writes nothing.",
  },
  ENFORCE: {
    label: "Protect",
    blurb: "Every ChairBack booking is mirrored into Square, so the time stops being sold twice.",
  },
};

/** What a manager should DO about each problem - never just what it is called. */
const CONNECTION_FIX: Record<SquareConnectionProblem, string> = {
  not_connected: "Connect Square first.",
  revoked: "Square access was revoked. Reconnect to restore it.",
  scopes_unverified: "We could not read your Square permissions yet. Re-check below.",
  reauth_required:
    "Your Square connection is read-only. Grant calendar permission to let ChairBack protect your time.",
  capability_unknown: "We could not read your Square booking plan yet. Re-check below.",
  seller_writes_unsupported:
    "Your Square plan does not allow other apps to add bookings. Square Appointments Plus or Premium is required.",
  booking_disabled: "Online booking is switched off inside Square. Turn it on there first.",
  location_unset: "Choose which Square location your chairs belong to.",
  location_stale: "Confirm your Square location again - the connection changed.",
  location_invalid: "That Square location no longer exists. Choose another.",
};

const MAPPING_FIX: Record<SquareMappingProblem, string> = {
  unmapped: "Not linked yet",
  stale: "Confirm again - the Square connection changed",
  invalid: "No longer in Square",
  version_stale: "Changed in Square - re-save to refresh",
};

export function SquareSetup({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<SquareSetupData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const res = await getSquareSetupAction();
    if (res.ok && res.data) {
      setData(res.data);
      setLoadError(null);
    } else {
      setLoadError(res.error ?? "failed");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Every save re-reads the snapshot rather than patching local state.
   *
   * One mapping can change another row's meaning - claiming a team member takes
   * it away from the chair that had it, and the readiness badge depends on the
   * whole picture - so a local patch would routinely render a state the server
   * does not agree with.
   */
  function save(action: () => Promise<{ ok: boolean; error?: string }>, failure: string) {
    start(async () => {
      const res = await action();
      if (!res.ok) toast(explain(res.error) ?? failure, "error");
      await refresh();
    });
  }

  if (loading) {
    return (
      <Card className="p-5">
        <CardHeader title="Square calendar protection" subtitle="Loading your Square account…" />
        <div className="space-y-3 pt-4" aria-hidden>
          <div className="h-11 animate-pulse rounded-xl bg-white/5" />
          <div className="h-11 animate-pulse rounded-xl bg-white/5" />
        </div>
      </Card>
    );
  }

  if (loadError || !data) {
    const notConnected = loadError === "square_not_connected";
    return (
      <Card className="p-5">
        <CardHeader
          title="Square calendar protection"
          subtitle={
            notConnected
              ? "Connect Square above to protect your calendar."
              : "We could not reach Square just now."
          }
        />
        {!notConnected && (
          <div className="pt-4">
            <p className="text-sm text-muted">
              This is a Square problem, not a setup problem — your mappings are untouched. Try again
              in a moment.
            </p>
            <button
              type="button"
              onClick={() => start(() => void refresh())}
              className="mt-3 min-h-[44px] rounded-xl border border-subtle px-4 text-sm font-medium hover:border-gold/30"
            >
              Try again
            </button>
          </div>
        )}
      </Card>
    );
  }

  const gen = data.generation;
  const bookableStaff = data.staff.filter((s) => s.bookable);
  const bookableServices = data.services.filter((s) => s.bookable);
  const staffDone = bookableStaff.filter((s) => s.problem === null).length;
  const serviceDone = bookableServices.filter((s) => s.problem === null).length;
  const permissionsOk = !data.connectionProblems.some((p) =>
    ["scopes_unverified", "reauth_required", "capability_unknown", "seller_writes_unsupported", "booking_disabled", "revoked", "not_connected"].includes(p),
  );
  const locationOk = !data.connectionProblems.some((p) => p.startsWith("location_"));

  // A shop that is ARMED with a pair it cannot mirror is the one state that
  // needs shouting about: someone was hired, or a service was added, after
  // enforcement was switched on, and those bookings are being turned away right
  // now.
  const armedWithGaps = data.mode === "ENFORCE" && data.blockingPairs.length > 0;

  return (
    <Card className="p-5">
      <CardHeader
        title="Square calendar protection"
        subtitle="Stop Square selling the time ChairBack already booked."
        action={<ReadyBadge ready={data.ready} mode={data.mode} gaps={data.blockingPairs.length} />}
      />

      {armedWithGaps && (
        <div className="mt-4 rounded-xl border border-danger-soft/40 bg-danger-soft/10 p-4">
          <p className="text-sm font-semibold text-danger-soft">
            {data.blockingPairs.length === 1 ? "1 booking option is" : `${data.blockingPairs.length} booking options are`}{" "}
            turned away right now
          </p>
          <p className="mt-1 text-sm text-muted">
            Protection is on, but these are not linked to Square yet — so customers cannot book
            them. Link them below and they go straight back on sale.
          </p>
          <ul className="mt-2 space-y-1">
            {data.blockingPairs.slice(0, 6).map((p) => (
              <li key={`${p.staffId}-${p.serviceId}`} className="text-sm">
                <span className="font-medium">{p.staffName}</span>
                <span className="text-muted"> · {p.serviceName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Step n={1} label="Permission" done={permissionsOk} detail={permissionsOk ? "Granted" : "Needed"} />
        <Step
          n={2}
          label="Location"
          done={locationOk}
          detail={data.connection.outboundLocationName ?? "Not chosen"}
        />
        <Step
          n={3}
          label="Barbers"
          done={bookableStaff.length > 0 && staffDone === bookableStaff.length}
          detail={`${staffDone} of ${bookableStaff.length} barbers linked`}
        />
        <Step
          n={4}
          label="Services"
          done={bookableServices.length > 0 && serviceDone === bookableServices.length}
          detail={`${serviceDone} of ${bookableServices.length} services linked`}
        />
      </ol>

      {/*  1. Permission  */}
      <Section title="Permission" desc="What Square lets ChairBack do on your behalf.">
        {data.connectionProblems.length === 0 ? (
          <p className="text-sm text-emerald-soft">
            Square is letting ChairBack add bookings to your calendar.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.connectionProblems.map((p) => (
              <li key={p} className="flex gap-2 text-sm">
                <span aria-hidden className="mt-[2px] text-gold">
                  •
                </span>
                <span>{CONNECTION_FIX[p]}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={`${apiBase}/api/square/oauth/start?outbound=1`}
            // Loud only while it is the thing standing in the way. Once Square
            // has granted the permission, re-granting is a repair tool, and a
            // gold primary button next to "you already have this" reads as an
            // instruction to click it - which would invalidate every mapping.
            className={cn(
              "inline-flex min-h-[44px] items-center rounded-xl px-4 text-sm font-semibold transition-colors",
              permissionsOk
                ? "border border-subtle font-medium hover:border-gold/30"
                : "bg-gold text-charcoal-900 hover:bg-gold-muted",
            )}
          >
            {permissionsOk ? "Re-grant permission" : "Grant calendar permission"}
          </a>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              save(refreshSquareCapabilityAction, "Could not re-check your Square permissions.")
            }
            className="min-h-[44px] rounded-xl border border-subtle px-4 text-sm font-medium hover:border-gold/30 disabled:opacity-50"
          >
            Re-check
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Re-granting permission asks you to confirm every link below again — Square cannot tell us
          whether you reconnected the same business.
        </p>
      </Section>

      {/*  2. Location  */}
      <Section title="Location" desc="Which Square location your chairs belong to.">
        {data.locations.length === 0 ? (
          <Empty>No locations on this Square account yet.</Empty>
        ) : (
          <label className="block">
            <span className="sr-only">Square location</span>
            <select
              aria-label="Square location"
              value={data.connection.outboundLocationId ?? data.preselectLocationId ?? ""}
              disabled={pending}
              onChange={(e) =>
                save(
                  () => setSquareLocationAction(e.target.value || null, gen),
                  "Could not save that location.",
                )
              }
              className="min-h-[44px] w-full rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite outline-none focus:border-gold/50"
            >
              <option value="">Choose a location…</option>
              {data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name ?? l.id}
                  {l.status === "INACTIVE" ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </Section>

      {/*  3. Barbers  */}
      <Section title="Barbers" desc="Each chair, matched to the person it is in Square.">
        {bookableStaff.length === 0 ? (
          <Empty>Add a barber with at least one service to link them here.</Empty>
        ) : data.teamMembers.length === 0 ? (
          <Empty>
            No bookable team members in Square. Add one in Square (Staff → allow online booking),
            then re-check.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {bookableStaff.map((s) => (
              <li
                key={s.id}
                className="grid min-w-0 gap-2 rounded-xl border border-subtle p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.name}</p>
                  <ProblemChip problem={s.problem} />
                </div>
                <select
                  aria-label={`Square team member for ${s.name}`}
                  value={s.teamMemberId ?? ""}
                  disabled={pending}
                  onChange={(e) =>
                    save(
                      () => setSquareTeamMemberAction(s.id, e.target.value || null, gen),
                      "Could not link that barber.",
                    )
                  }
                  className="min-h-[44px] w-full min-w-0 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite outline-none focus:border-gold/50"
                >
                  <option value="">Not linked</option>
                  {data.teamMembers.map((tm) => (
                    <option
                      key={tm.id}
                      value={tm.id}
                      // One team member, one chair: a person already claimed
                      // elsewhere would double-book themselves in Square.
                      disabled={tm.takenByStaffId !== null && tm.takenByStaffId !== s.id}
                    >
                      {tm.name ?? tm.id}
                      {tm.takenByStaffId !== null && tm.takenByStaffId !== s.id ? " (already linked)" : ""}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/*  4. Services  */}
      <Section title="Services" desc="Each service, matched to the one Square charges for.">
        {bookableServices.length === 0 ? (
          <Empty>Add a service that at least one barber offers to link it here.</Empty>
        ) : data.variations.length === 0 ? (
          <Empty>
            No bookable services in your Square catalogue. Add an Appointments service in Square,
            then re-check.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {bookableServices.map((s) => (
              <li
                key={s.id}
                className="grid min-w-0 gap-2 rounded-xl border border-subtle p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.name}</p>
                  <ProblemChip problem={s.problem} />
                </div>
                <select
                  aria-label={`Square service for ${s.name}`}
                  value={s.variationId ?? ""}
                  disabled={pending}
                  onChange={(e) =>
                    save(
                      () => setSquareVariationAction(s.id, e.target.value || null, gen),
                      "Could not link that service.",
                    )
                  }
                  className="min-h-[44px] w-full min-w-0 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite outline-none focus:border-gold/50"
                >
                  <option value="">Not linked</option>
                  {data.variations.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                      {v.durationMin ? ` · ${v.durationMin} min` : ""}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/*  5. The switch  */}
      <Section title="Protection" desc="Nothing is written to Square until you turn this on.">
        <div className="grid gap-2 sm:grid-cols-3">
          {MODES.map((m) => {
            const locked = m === "ENFORCE" && !data.ready;
            const active = data.mode === m;
            return (
              <button
                key={m}
                type="button"
                disabled={pending || locked}
                aria-pressed={active}
                onClick={() =>
                  save(() => setSquareModeAction(m), "Could not change protection.")
                }
                className={cn(
                  "min-h-[44px] rounded-xl border px-4 py-3 text-left transition-colors",
                  active
                    ? "border-gold/50 bg-gold/10"
                    : "border-subtle hover:border-gold/25",
                  locked && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="block text-sm font-semibold">{MODE_COPY[m].label}</span>
                <span className="mt-0.5 block text-xs text-muted">{MODE_COPY[m].blurb}</span>
              </button>
            );
          })}
        </div>
        {!data.ready && (
          <p className="mt-3 text-xs text-muted">
            {/* Never a bare "not ready": the blocker itself is the instruction. */}
            Protect unlocks once every step above is done
            {data.blockingPairs.length > 0
              ? ` — ${data.blockingPairs.length} barber/service ${
                  data.blockingPairs.length === 1 ? "pairing" : "pairings"
                } still to link.`
              : "."}
          </p>
        )}
      </Section>
    </Card>
  );
}

//  Pieces

function ReadyBadge({ ready, mode, gaps }: { ready: boolean; mode: Mode; gaps: number }) {
  if (mode === "ENFORCE") {
    // Armed WITH gaps is not "Protected". Some of this shop's booking options
    // are being turned away right now, and a green badge over that is the one
    // thing this card promises never to show.
    if (gaps > 0) {
      return (
        <span className="rounded-full border border-danger-soft/40 bg-danger-soft/10 px-3 py-1 text-xs font-semibold text-danger-soft">
          Partly protected
        </span>
      );
    }
    return (
      <span className="rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-3 py-1 text-xs font-semibold text-emerald-soft">
        Protected
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-semibold",
        ready ? "border-gold/40 bg-gold/10 text-gold" : "border-subtle text-muted",
      )}
    >
      {ready ? "Ready to turn on" : "Setup needed"}
    </span>
  );
}

function Step({
  n,
  label,
  done,
  detail,
}: {
  n: number;
  label: string;
  done: boolean;
  detail: string;
}) {
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-xl border border-subtle px-3 py-2">
      <span
        aria-hidden
        className={cn(
          "grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
          done ? "bg-emerald-soft/15 text-emerald-soft" : "bg-white/5 text-muted",
        )}
      >
        {done ? "✓" : n}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted">{detail}</span>
      </span>
    </li>
  );
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 border-t border-subtle pt-5">
      <h3 className="font-display text-base">{title}</h3>
      <p className="mb-3 text-xs text-muted">{desc}</p>
      {children}
    </section>
  );
}

function ProblemChip({ problem }: { problem: SquareMappingProblem | null }) {
  if (!problem) {
    return <span className="text-xs text-emerald-soft">Linked</span>;
  }
  return <span className="text-xs text-gold">{MAPPING_FIX[problem]}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-subtle px-4 py-6 text-center text-sm text-muted">
      {children}
    </p>
  );
}

/** Turn an API error code into the one sentence that says what to do about it. */
function explain(code: string | undefined): string | null {
  switch (code) {
    case "square_connection_changed":
      return "Your Square connection changed while this page was open. It has been refreshed — please pick again.";
    case "team_member_already_mapped":
      return "That person is already linked to another chair.";
    case "team_member_not_on_account":
      return "That person is no longer bookable in Square.";
    case "service_variation_not_on_account":
      return "That service is no longer in your Square catalogue.";
    case "location_not_on_account":
      return "That location is no longer on your Square account.";
    case "mapping_incomplete":
      return "Not everything is linked yet — see the steps above.";
    case "square_not_connected":
      return "Square is not connected to this shop.";
    case "square_unavailable":
      return "Square did not answer. Your links are untouched — try again in a moment.";
    default:
      return null;
  }
}
