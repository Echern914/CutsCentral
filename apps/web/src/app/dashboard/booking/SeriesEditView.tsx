"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Field, Group, INPUT } from "./formkit";
import {
  applySeriesEditAction,
  getEditContextAction,
  previewSeriesEditAction,
  type EditContext,
  type SeriesEditApplied,
  type SeriesEditInput,
  type SeriesEditPreview,
  type SeriesSkipReason,
} from "./actions";
import type { AgendaRow } from "./page";

/**
 * "EDIT THIS AND FUTURE" ON A REPEAT - start time, service, provider.
 *
 * Three steps, in the sheet:
 *   form    -> what to change (only what differs from this visit is sent)
 *   review  -> every date that would change, from and to, and anything in the
 *              way, BEFORE anything is written. Apply is offered only when
 *              every date can take it.
 *   done    -> what happened, per date, including what the synced calendar
 *              did or did not confirm.
 *
 * The API applies exactly the reviewed rows (a digest pins them): if they
 * changed in between, it refuses and this view reviews again. A tap whose
 * answer was lost is never retried blind - the review is re-read, which shows
 * whether it already landed.
 *
 * "This appointment" is the ordinary single edit; nothing here touches price
 * or charges anything.
 */

export type SeriesEditStage = "form" | "review" | "done";

export interface SeriesEditState {
  stage: SeriesEditStage;
  ctx: EditContext | null;
  loadError: boolean;
  time: string;
  setTime: (v: string) => void;
  serviceId: string | null;
  setServiceId: (v: string | null) => void;
  staffId: string | null;
  setStaffId: (v: string | null) => void;
  includeExceptions: boolean;
  setIncludeExceptions: (v: boolean) => void;
  customTime: boolean;
  setCustomTime: (v: boolean) => void;
  preview: SeriesEditPreview | null;
  applied: SeriesEditApplied | null;
  /** Something to say above the list (e.g. "these changed since you looked"). */
  notice: string | null;
  error: string | null;
  busy: boolean;
  hasChanges: boolean;
  blocked: boolean;
  review: () => void;
  apply: () => void;
  back: () => void;
}

/** "14:30" -> 870; null when it is not a time. */
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

function localTime(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

export function useSeriesEdit({
  row,
  active,
  onApplied,
}: {
  row: AgendaRow;
  /** The view is open. Nothing is fetched for a sheet that never opens it. */
  active: boolean;
  /** After a change landed: the agenda needs re-reading. */
  onApplied: () => void;
}): SeriesEditState {
  const [ctx, setCtx] = useState<EditContext | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [stage, setStage] = useState<SeriesEditStage>("form");
  const [time, setTime] = useState("");
  const [serviceId, setServiceId] = useState<string | null>(row.serviceId ?? null);
  const [staffId, setStaffId] = useState<string | null>(row.staffId ?? null);
  const [includeExceptions, setIncludeExceptions] = useState(false);
  const [customTime, setCustomTime] = useState(false);
  const [preview, setPreview] = useState<SeriesEditPreview | null>(null);
  const [applied, setApplied] = useState<SeriesEditApplied | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Flips synchronously: two taps in one tick must not send two applies.
  const inFlight = useRef(false);

  // Every OPENING starts from this visit as it is now - never from a review or
  // a result left over from the last time. Keyed on opening alone: an apply
  // re-reads the agenda, which hands back this row at its NEW time, and
  // re-seeding on that would wipe the result he is reading.
  const rowNow = useRef(row);
  rowNow.current = row;
  useEffect(() => {
    if (!active) return;
    const r = rowNow.current;
    let alive = true;
    setStage("form");
    setPreview(null);
    setApplied(null);
    setNotice(null);
    setError(null);
    setLoadError(false);
    setServiceId(r.serviceId ?? null);
    setStaffId(r.staffId ?? null);
    setIncludeExceptions(false);
    setCustomTime(false);
    void (async () => {
      const res = await getEditContextAction();
      if (!alive) return;
      if (res.ok && res.data) {
        setCtx(res.data);
        setTime(localTime(r.start, res.data.timezone));
      } else {
        setLoadError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [active]);

  const input = useMemo((): SeriesEditInput | null => {
    if (!ctx || !row.seriesId) return null;
    const changes: SeriesEditInput["changes"] = {};
    const startMin = toMinutes(time);
    if (startMin !== null && time !== localTime(row.start, ctx.timezone)) changes.startMin = startMin;
    if (serviceId && serviceId !== row.serviceId) changes.serviceId = serviceId;
    if (staffId && staffId !== row.staffId) changes.staffId = staffId;
    return {
      fromAppointmentId: row.id,
      changes,
      ...(includeExceptions ? { includeExceptions: true } : {}),
      ...(customTime ? { customTime: true } : {}),
    };
  }, [ctx, row, time, serviceId, staffId, includeExceptions, customTime]);

  const hasChanges = Boolean(input && Object.keys(input.changes).length > 0);
  const blocked = Boolean(preview?.change.some((c) => c.problem));

  async function readPreview(): Promise<boolean> {
    if (!input || !row.seriesId) return false;
    let res: Awaited<ReturnType<typeof previewSeriesEditAction>>;
    try {
      res = await previewSeriesEditAction(row.seriesId, input);
    } catch {
      res = { ok: false, error: "network_error" };
    }
    if (!res.ok || !res.data) {
      setError(ERRORS[res.error ?? ""] ?? "Couldn't check those dates. Nothing changed - try again.");
      return false;
    }
    setPreview(res.data);
    setStage("review");
    return true;
  }

  function review() {
    if (inFlight.current || !hasChanges) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    void readPreview().finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }

  function apply() {
    if (inFlight.current || !input || !preview || !row.seriesId || blocked) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const seriesId = row.seriesId;
    void (async () => {
      let res: Awaited<ReturnType<typeof applySeriesEditAction>>;
      try {
        res = await applySeriesEditAction(seriesId, { ...input, digest: preview.digest });
      } catch {
        res = { ok: false, error: "network_error" };
      }
      if (res.ok && res.data) {
        setApplied(res.data);
        setStage("done");
        onApplied();
        return;
      }
      if (res.error === "series_conflict" && res.preview) {
        // Something landed on one of the dates since the review.
        setPreview(res.preview);
        setNotice("Something changed on one of these dates since you looked. Nothing was moved.");
        return;
      }
      if (res.error === "stale_preview" || res.error === "network_error" || res.error?.startsWith("http_5")) {
        // Never retried blind: read the dates again, which also shows whether
        // a tap whose answer was lost already went through.
        const again = await readPreview();
        if (again) {
          setNotice(
            res.error === "stale_preview"
              ? "These appointments changed since you looked. Here's the change again - nothing was moved yet."
              : "We couldn't confirm that went through. Here's where things stand now.",
          );
        }
        return;
      }
      setError(ERRORS[res.error ?? ""] ?? "That didn't go through. Nothing changed, so try again.");
    })().finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }

  function back() {
    setStage("form");
    setPreview(null);
    setNotice(null);
    setError(null);
  }

  return {
    stage,
    ctx,
    loadError,
    time,
    setTime,
    serviceId,
    setServiceId,
    staffId,
    setStaffId,
    includeExceptions,
    setIncludeExceptions,
    customTime,
    setCustomTime,
    preview,
    applied,
    notice,
    error,
    busy,
    hasChanges,
    blocked,
    review,
    apply,
    back,
  };
}

const ERRORS: Record<string, string> = {
  nothing_to_change: "Change the time, service or provider first.",
  anchor_not_editable: "This appointment can no longer be changed. Open an upcoming one in the repeat.",
  not_found: "This repeat isn't on your calendar any more.",
  service_not_found: "That service is no longer available.",
  staff_not_found: "That provider is no longer available.",
  staff_does_not_offer_service: "That provider doesn't offer that service.",
  slot_taken: "Another appointment starts at exactly that minute on one of these dates. Nothing was moved.",
};

const SKIP_WORDS: Record<SeriesSkipReason, string> = {
  past: "already over",
  completed: "done",
  cancelled: "cancelled",
  not_confirmed: "waiting on the client",
  external: "managed in your synced calendar",
  edited_on_its_own: "you changed this one on its own",
};

export function SeriesEditFields({ state }: { state: SeriesEditState }) {
  const vocab = useVocab();
  const { ctx } = state;
  if (state.loadError) {
    return <p className="text-sm text-danger-soft">Couldn&apos;t load this repeat. Close and try again.</p>;
  }
  if (!ctx) return <p className="text-sm text-muted">Loading…</p>;
  const zone = ctx.timezone;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" });
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  const serviceName = (id: string) => ctx.services.find((s) => s.id === id)?.name ?? "Service";
  const staffName = (id: string) => ctx.staff.find((s) => s.id === id)?.name ?? cap(vocab.providerNoun);

  if (state.stage === "done" && state.applied) {
    const a = state.applied;
    const unsettled = a.changed.filter((c) => c.mirror === "unknown");
    const refused = a.changed.filter((c) => c.mirror === "failed");
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="series-edit-done">
        <Group title="Done">
          <p className="text-sm text-offwhite">
            {a.changed.length === 0
              ? a.alreadyApplied
                ? "Already done - these appointments were changed earlier. Nothing new was changed."
                : "Nothing needed changing."
              : `Changed ${a.changed.length} appointment${a.changed.length === 1 ? "" : "s"}.`}
          </p>
          {a.clientNotified && (
            <p className="text-sm text-muted">
              Your {vocab.clientNoun} gets one email with the new time for the next visit. Each later reminder shows
              its new time.
            </p>
          )}
          {unsettled.length > 0 && (
            <p className="text-sm text-amber-300" role="status">
              Still confirming with Acuity for {unsettled.map((c) => day.format(new Date(c.startsAt))).join(", ")}.
              The old time stays blocked there until it does.
            </p>
          )}
          {refused.length > 0 && (
            <p className="text-sm text-amber-300" role="alert">
              Acuity didn&apos;t take the new time for {refused.map((c) => day.format(new Date(c.startsAt))).join(", ")}.
              The old time is still blocked there and the new one isn&apos;t - check Acuity before someone books it.
            </p>
          )}
        </Group>
      </div>
    );
  }

  if (state.stage === "review" && state.preview) {
    const p = state.preview;
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="series-edit-review">
        {state.notice && (
          <p role="status" className="rounded-xl border border-gold/30 bg-gold/5 px-3.5 py-2.5 text-sm text-offwhite">
            {state.notice}
          </p>
        )}
        <Group title={p.change.length ? `${p.change.length} will change` : "Nothing will change"}>
          {p.change.length === 0 ? (
            <p className="text-sm text-muted">
              {p.alreadyDone > 0
                ? "These appointments are already like that."
                : "No upcoming appointment in this repeat can take this change."}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-subtle/60">
              {p.change.map((c) => {
                const moved = c.from.startsAt !== c.to.startsAt;
                return (
                  <li key={c.id} className="flex min-w-0 flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                    <span className="text-sm font-medium text-offwhite">{day.format(new Date(c.to.startsAt))}</span>
                    <span className="text-sm tabular-nums text-muted [overflow-wrap:anywhere]">
                      {moved
                        ? `${clock.format(new Date(c.from.startsAt))} → ${clock.format(new Date(c.to.startsAt))}`
                        : clock.format(new Date(c.to.startsAt))}
                      {c.to.staffId !== c.from.staffId && ` · ${staffName(c.from.staffId)} → ${staffName(c.to.staffId)}`}
                      {c.to.serviceId !== c.from.serviceId &&
                        ` · ${serviceName(c.from.serviceId)} → ${serviceName(c.to.serviceId)}`}
                    </span>
                    {c.problem && (
                      <span className="text-sm text-danger-soft [overflow-wrap:anywhere]" data-testid="series-problem">
                        {c.problem.text}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Group>

        {p.skipped.length > 0 && (
          <Group title="Left as they are">
            <ul className="flex flex-col gap-1.5">
              {p.skipped.map((s) => (
                <li key={s.id} className="text-sm text-muted">
                  {day.format(new Date(s.startsAt))} · {clock.format(new Date(s.startsAt))} - {SKIP_WORDS[s.reason]}
                </li>
              ))}
            </ul>
            {p.skipped.some((s) => s.reason === "edited_on_its_own") && !state.includeExceptions && (
              <p className="text-[11px] leading-snug text-muted/80">
                To change those too, go back and turn on &ldquo;Also change ones I changed on their own&rdquo;.
              </p>
            )}
          </Group>
        )}

        <ul className="flex flex-col gap-1 px-1 text-[11px] leading-snug text-muted/80">
          <li>Prices stay as booked. To change a price, edit that appointment on its own.</li>
          <li>
            If ChairBack emailed your {vocab.clientNoun} about these, they get one email with the new time for the
            next visit, and each later reminder shows its new time.
          </li>
          <li>
            A calendar connected to Acuity is updated one date at a time; anything Acuity doesn&apos;t confirm is named
            after you apply.
          </li>
        </ul>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="series-edit-form">
      <p className="px-1 text-sm text-muted">
        Changes this appointment and every upcoming one after it in the repeat. Earlier, finished and cancelled ones
        stay as they are.
      </p>
      <Group title="Change">
        <Field
          label="Start time"
          hint={`The same time on every date, in your ${vocab.businessNoun}'s time zone.`}
        >
          <input
            type="time"
            value={state.time}
            onChange={(e) => state.setTime(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field label="Service" hint="Each appointment keeps its price.">
          <select
            value={state.serviceId ?? ""}
            onChange={(e) => state.setServiceId(e.target.value || null)}
            className={INPUT}
          >
            {ctx.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={cap(vocab.providerNoun)}>
          <select
            value={state.staffId ?? ""}
            onChange={(e) => state.setStaffId(e.target.value || null)}
            className={INPUT}
          >
            {ctx.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </Group>
      <Group title="Options">
        <Toggle
          checked={state.includeExceptions}
          onChange={state.setIncludeExceptions}
          label="Also change ones I changed on their own"
          hint="Off: an appointment you already moved or changed by itself stays as you left it."
        />
        <Toggle
          checked={state.customTime}
          onChange={state.setCustomTime}
          label="Custom time"
          hint="Allow a time outside your open hours. Other appointments still count."
        />
      </Group>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex min-w-0 cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-5 w-5 flex-none"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-offwhite">{label}</span>
        <span className="text-[11px] leading-snug text-muted/80">{hint}</span>
      </span>
    </label>
  );
}

/** The sheet's footer for this view: one primary, the error right above it. */
export function SeriesEditFooter({ state, onClose }: { state: SeriesEditState; onClose: () => void }) {
  const count = state.preview?.change.length ?? 0;
  const primary =
    state.stage === "done"
      ? { label: "Done", onClick: onClose, disabled: false }
      : state.stage === "review"
        ? {
            label: state.busy
              ? "Applying…"
              : state.blocked
                ? "Fix the dates above first"
                : count === 0
                  ? "Nothing to apply"
                  : `Apply to ${count} appointment${count === 1 ? "" : "s"}`,
            onClick: state.apply,
            disabled: state.busy || state.blocked || count === 0,
          }
        : {
            label: state.busy ? "Checking…" : "Review dates",
            onClick: state.review,
            disabled: state.busy || !state.ctx || !state.hasChanges,
          };
  return (
    <div className="flex w-full flex-col gap-2">
      {state.error && (
        <p role="alert" className="text-sm text-danger-soft">
          {state.error}
        </p>
      )}
      <div className="flex w-full flex-col-reverse gap-2 min-[380px]:flex-row min-[380px]:items-center min-[380px]:justify-end">
        {state.stage === "review" && (
          <button
            type="button"
            onClick={state.back}
            disabled={state.busy}
            className="flex h-11 flex-none items-center justify-center rounded-xl border border-subtle px-5 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={primary.onClick}
          disabled={primary.disabled}
          className={cn(
            "flex h-11 flex-none items-center justify-center rounded-xl bg-gold px-5 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50 min-[380px]:flex-1 sm:max-w-[16rem]",
          )}
        >
          {primary.label}
        </button>
      </div>
    </div>
  );
}
