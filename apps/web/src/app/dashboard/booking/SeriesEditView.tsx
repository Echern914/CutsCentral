"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/serviceFields";
import { Field, Group, INPUT } from "./formkit";
import {
  applySeriesEditAction,
  getEditContextAction,
  previewSeriesEditAction,
  recheckSeriesEditMirrorAction,
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
 * 🔴 "STILL CONFIRMING" IS NOT DONE. The apply answers without waiting for a
 * slow Acuity, so a date can come back "unknown". It is said as still
 * confirming - never as moved there - and read again (on its own a few times,
 * and on "Check again") until Acuity confirms or refuses it.
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
  /** Reading where the still-confirming dates stand now. */
  checking: boolean;
  recheck: () => void;
}

/** How often, and how many times, still-confirming dates are read again unasked. */
export const RECHECK_EVERY_MS = 5_000;
const AUTO_RECHECKS = 6;

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
  /**
   * The agenda needs re-reading: called once he LEAVES a change that landed
   * (or may have), never while its result is on screen - see below.
   */
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
  const [checking, setChecking] = useState(false);
  const checkingNow = useRef(false);
  const autoChecks = useRef(0);

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

  // 🔴 THE CALENDAR IS RE-READ WHEN HE LEAVES THE RESULT, not when it lands.
  // This sheet lives inside the visit's calendar card. Re-reading the agenda
  // moves a visit whose time changed into another slot, which remounts the
  // card and closes the sheet - taking the per-date result, and any date the
  // synced calendar did not confirm, with it before he has read it. So a
  // change that (may have) landed is remembered, and the agenda is re-read on
  // Done or Back, or when the sheet closes.
  const refreshOwed = useRef(false);
  const onAppliedNow = useRef(onApplied);
  onAppliedNow.current = onApplied;
  useEffect(() => {
    if (active || !refreshOwed.current) return;
    refreshOwed.current = false;
    onAppliedNow.current();
  }, [active]);
  useEffect(
    () => () => {
      if (!refreshOwed.current) return;
      refreshOwed.current = false;
      onAppliedNow.current();
    },
    [],
  );

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
        autoChecks.current = 0;
        setApplied(res.data);
        setStage("done");
        refreshOwed.current = true;
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
        if (res.error !== "stale_preview") refreshOwed.current = true;
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

  // Only the dates still confirming are read again, and only their state is
  // taken from the answer: a date already confirmed or refused stays as said.
  // A read that fails changes nothing - "still confirming" is still true.
  function recheck() {
    const seriesId = row.seriesId;
    const waiting = applied?.changed.filter((c) => c.mirror === "unknown").map((c) => c.id) ?? [];
    if (checkingNow.current || !seriesId || waiting.length === 0) return;
    checkingNow.current = true;
    setChecking(true);
    void (async () => {
      let res: Awaited<ReturnType<typeof recheckSeriesEditMirrorAction>> | undefined;
      try {
        res = await recheckSeriesEditMirrorAction(seriesId, waiting);
      } catch {
        res = undefined;
      }
      if (!res?.ok || !res.data) return;
      const now = new Map(res.data.changed.map((c) => [c.id, c.mirror] as const));
      setApplied((prev) =>
        prev && {
          ...prev,
          changed: prev.changed.map((c) =>
            c.mirror === "unknown" && now.has(c.id) ? { ...c, mirror: now.get(c.id)! } : c,
          ),
        },
      );
    })().finally(() => {
      checkingNow.current = false;
      setChecking(false);
    });
  }

  const stillConfirming = stage === "done" ? (applied?.changed.filter((c) => c.mirror === "unknown").length ?? 0) : 0;
  const recheckNow = useRef(recheck);
  recheckNow.current = recheck;
  useEffect(() => {
    if (!active || stillConfirming === 0 || checking || autoChecks.current >= AUTO_RECHECKS) return;
    const t = setTimeout(() => {
      autoChecks.current++;
      recheckNow.current();
    }, RECHECK_EVERY_MS);
    return () => clearTimeout(t);
  }, [active, stillConfirming, checking]);

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
    checking,
    recheck,
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
            <div className="flex min-w-0 flex-col items-start gap-2">
              <p className="text-sm text-amber-300 [overflow-wrap:anywhere]" role="status">
                Still confirming with Acuity for {unsettled.map((c) => day.format(new Date(c.startsAt))).join(", ")}.
                The old time stays blocked there until it does. This can take a few minutes.
              </p>
              <button
                type="button"
                onClick={state.recheck}
                disabled={state.checking}
                className="flex h-11 flex-none items-center justify-center rounded-xl border border-subtle px-5 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
              >
                {state.checking ? "Checking…" : "Check again"}
              </button>
            </div>
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
    // 🔴 A NEW SERVICE KEEPS THE BOOKED PRICE, and the review says so in as
    // many words - the same rule as editing one appointment's service. The new
    // service's menu price is never substituted; whether it should be is the
    // shop's call, made by changing a price on purpose.
    const serviceMoves = p.change.filter((c) => c.to.serviceId !== c.from.serviceId);
    const priceKnown = serviceMoves.every((c) => c.bookedPriceCents !== undefined);
    const prices = [...new Set(serviceMoves.map((c) => c.bookedPriceCents ?? null))];
    const mixedPrices = priceKnown && prices.length > 1;
    const priceLine = !priceKnown
      ? "Prices stay as booked."
      : prices.length > 1
        ? "Each keeps the price it was booked at, shown by date below."
        : prices[0] === null || prices[0] === undefined
          ? "No price was booked, and none is added."
          : `Booked price stays ${formatCents(prices[0])}.`;
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="series-edit-review">
        {state.notice && (
          <p role="status" className="rounded-xl border border-gold/30 bg-gold/5 px-3.5 py-2.5 text-sm text-offwhite">
            {state.notice}
          </p>
        )}
        {serviceMoves.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-subtle px-3.5 py-2.5" data-testid="series-service-price">
            <p className="text-sm text-offwhite [overflow-wrap:anywhere]">
              Service: {[...new Set(serviceMoves.map((c) => serviceName(c.from.serviceId)))].join(" or ")} →{" "}
              {serviceName(serviceMoves[0]!.to.serviceId)}
            </p>
            <p className="text-sm text-offwhite">{priceLine}</p>
            <p className="text-[11px] leading-snug text-muted/80">
              The new service&apos;s menu price isn&apos;t used. To charge it, change that appointment&apos;s price on
              its own.
            </p>
          </div>
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
                      {mixedPrices &&
                        c.to.serviceId !== c.from.serviceId &&
                        ` · stays ${c.bookedPriceCents == null ? "unpriced" : formatCents(c.bookedPriceCents)}`}
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
          {serviceMoves.length === 0 && (
            <li>Prices stay as booked. To change a price, edit that appointment on its own.</li>
          )}
          <li>
            If ChairBack emailed your {vocab.clientNoun} about these, they get one email with the new time for the
            next visit, and each later reminder shows its new time.
          </li>
          <li>
            A calendar connected to Acuity is updated one date at a time; any date Acuity hasn&apos;t confirmed yet, or
            turned down, is named after you apply.
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
