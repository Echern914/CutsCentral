"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Segmented } from "@/components/ui/Segmented";
import { MoneyField } from "@/components/ui/UnitField";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  PAYMENT_METHODS,
  centsFromInput,
  dayRange,
  describeRate,
  monthDay,
  hasRent,
  methodLabel,
  money,
  periodNoun,
  rentLines,
  shortDay,
  todayYmd,
  type RentHistory,
  type RentPayment,
  type RentPeriod,
  type RentRate,
  type RentSummary,
} from "@/lib/boothRent";
import {
  recordRentPaymentAction,
  rentHistoryAction,
  setRentAction,
  voidRentPaymentAction,
  voidRentRateAction,
} from "./actions";

const quiet =
  "min-h-[40px] rounded-full border border-subtle px-4 text-xs text-muted transition-colors hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-50";
const primary =
  "min-h-[40px] rounded-full bg-gold px-4 text-xs font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";
const field =
  "mt-1 min-h-[40px] w-full rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite outline-none focus:border-gold/50";

/** The rent in effect, this period, the whole balance, and what's coming. */
function RentLines({
  rent,
  who,
}: {
  rent: RentSummary;
  who: "owner" | "member";
}) {
  const l = rentLines(rent, who);
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted">
        Booth rent
      </p>
      <p className={cn("text-sm", rent.rate ? "text-offwhite" : "text-muted")}>
        {l.rate}
      </p>
      {l.current && (
        <p className="text-xs text-offwhite/90" data-qa="rent-current">
          {l.current}
        </p>
      )}
      {l.total && (
        <p
          className={cn(
            "text-xs",
            l.total.tone === "owing"
              ? "font-semibold text-gold"
              : "text-emerald-soft",
          )}
          data-qa="rent-total"
        >
          {l.total.label}
        </p>
      )}
      {l.next && (
        <p className="text-xs text-muted" data-qa="rent-next">
          {l.next}
        </p>
      )}
    </div>
  );
}

/** "Void" with an inline "Void it / Keep" confirm. Resolves true once the server has it. */
function VoidButton({
  what,
  hint,
  onVoid,
}: {
  what: string;
  hint?: string;
  onVoid: () => Promise<boolean>;
}) {
  const [state, setState] = useState<"idle" | "confirm" | "busy">("idle");
  if (state === "idle") {
    return (
      <button
        type="button"
        onClick={() => setState("confirm")}
        aria-label={`Void ${what}`}
        className="min-h-[40px] shrink-0 px-2 text-[11px] text-muted hover:text-offwhite"
      >
        Void
      </button>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={state === "busy"}
          onClick={async () => {
            setState("busy");
            setState((await onVoid()) ? "idle" : "confirm");
          }}
          className="min-h-[40px] rounded-full bg-rose-500/90 px-3 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {state === "busy" ? "Voiding…" : "Void it"}
        </button>
        <button
          type="button"
          disabled={state === "busy"}
          onClick={() => setState("idle")}
          className="min-h-[40px] px-2 text-[11px] text-muted"
        >
          Keep
        </button>
      </div>
      {hint && (
        <p className="max-w-[16rem] text-right text-[11px] text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-wide text-muted">
        {title}
      </h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function rateText(r: RentRate) {
  return r.amountCents === null || r.period === null
    ? `Stopped from ${shortDay(r.startsOn)}`
    : `${describeRate(r.amountCents, r.period)} from ${shortDay(r.startsOn)}`;
}

/**
 * The whole record, the same for both sides: what's unpaid, every payment and
 * every rent entry - voided ones included, struck through. `owner` adds Void.
 */
function HistoryDialog({
  open,
  onClose,
  title,
  who,
  load,
  owner,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  who: "owner" | "member";
  load: () => Promise<RentHistory | null>;
  owner?: {
    voidPayment: (p: RentPayment) => Promise<boolean>;
    voidRate: (r: RentRate) => Promise<boolean>;
  };
}) {
  const [data, setData] = useState<RentHistory | "loading" | "failed">(
    "loading",
  );

  async function refresh() {
    setData("loading");
    setData((await load()) ?? "failed");
  }
  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // After a void the server's answer replaces the list; a failed re-read keeps what's shown.
  async function reread() {
    const next = await load();
    if (next) setData(next);
  }

  let body: ReactNode;
  if (data === "loading") body = <p className="text-sm text-muted">Loading…</p>;
  else if (data === "failed") {
    body = (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Couldn&apos;t load the rent history.
        </p>
        <button type="button" onClick={() => void refresh()} className={quiet}>
          Try again
        </button>
      </div>
    );
  } else {
    const { summary, payments } = data;
    const rates = [...data.rates].reverse(); // newest first, like the payments
    // Only the latest entry in effect can be voided, and never a stop (the
    // API refuses both; this only avoids offering it).
    const latest = rates.find((r) => r.status === "active");
    const voidableRate =
      latest && latest.amountCents !== null ? latest.id : null;
    const total = rentLines(summary, who).total;
    body = (
      <div className="flex flex-col gap-5">
        {total && (
          <p
            className={cn(
              "text-sm",
              total.tone === "owing"
                ? "font-semibold text-gold"
                : "text-emerald-soft",
            )}
            data-qa="history-total"
          >
            {total.label}
          </p>
        )}
        <Section title="Unpaid">
          {summary.unpaid.length === 0 ? (
            <p className="text-sm text-muted">Nothing unpaid.</p>
          ) : (
            <ul className="divide-y divide-subtle">
              {summary.unpaid.map((u) => (
                <li
                  key={u.start}
                  className="flex justify-between gap-3 py-2 text-sm"
                  data-qa="rent-unpaid"
                >
                  <span className="text-offwhite">
                    {dayRange(u.start, u.end)}
                  </span>
                  <span className="tabular-nums text-gold">
                    {u.dueCents < u.amountCents
                      ? `${money(u.dueCents)} left of ${money(u.amountCents)}`
                      : `${money(u.dueCents)} due`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Payments">
          {payments.length === 0 ? (
            <p className="text-sm text-muted">No payments yet.</p>
          ) : (
            <ul className="divide-y divide-subtle">
              {payments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                  data-qa="rent-payment"
                >
                  <div
                    className={cn(
                      "min-w-0",
                      p.voided && "text-muted line-through",
                    )}
                  >
                    <p className={cn("text-sm", !p.voided && "text-offwhite")}>
                      {money(p.amountCents)} · {methodLabel(p.method)}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {shortDay(p.paidOn)}
                      {p.note ? ` · ${p.note}` : ""}
                    </p>
                  </div>
                  {p.voided ? (
                    <span className="shrink-0 text-[11px] text-muted">
                      Voided{p.voidedOn ? ` ${monthDay(p.voidedOn)}` : ""}
                    </span>
                  ) : (
                    owner && (
                      <VoidButton
                        what={`the ${money(p.amountCents)} payment from ${shortDay(p.paidOn)}`}
                        onVoid={async () => {
                          const ok = await owner.voidPayment(p);
                          if (ok) await reread();
                          return ok;
                        }}
                      />
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Rent">
          {rates.length === 0 ? (
            <p className="text-sm text-muted">No rent set.</p>
          ) : (
            <ul className="divide-y divide-subtle">
              {rates.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                  data-qa="rent-rate"
                >
                  <p
                    className={cn(
                      "min-w-0 text-sm",
                      r.status === "active"
                        ? "text-offwhite"
                        : "text-muted line-through",
                    )}
                  >
                    {rateText(r)}
                  </p>
                  {r.status !== "active" ? (
                    <span className="shrink-0 text-[11px] text-muted">
                      {r.status === "voided"
                        ? `Voided${r.voidedOn ? ` ${monthDay(r.voidedOn)}` : ""}`
                        : "Replaced"}
                    </span>
                  ) : (
                    owner &&
                    r.id === voidableRate && (
                      <VoidButton
                        what={`the rent entry "${rateText(r)}"`}
                        hint="For a mistake. From its start, the rent before it applies again; earlier weeks don't change."
                        onVoid={async () => {
                          const ok = await owner.voidRate(r);
                          if (ok) await reread();
                          return ok;
                        }}
                      />
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      {body}
    </Dialog>
  );
}

/** The owner's booth rent for one member: the lines, and Record payment / Set / History. */
export function OwnerRent({
  linkId,
  businessName,
  rent,
  onRent,
}: {
  linkId: string;
  businessName: string;
  rent: RentSummary;
  onRent: (next: RentSummary) => void;
}) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<null | "rent" | "pay" | "history">(null);
  const canPay = rent.rate !== null || rent.balanceCents > 0;

  async function afterVoid(
    res: { ok: boolean; rent?: RentSummary },
    done: string,
  ) {
    if (res.ok && res.rent) {
      onRent(res.rent);
      toast(done, "success");
      return true;
    }
    toast("Couldn't void it - try again", "error");
    return false;
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-subtle px-3 py-2.5">
      <RentLines rent={rent} who="owner" />
      <div className="flex flex-wrap gap-2">
        {canPay && (
          <button
            type="button"
            onClick={() => setDialog("pay")}
            className={primary}
            data-qa="record-payment"
          >
            Record payment
          </button>
        )}
        <button
          type="button"
          onClick={() => setDialog("rent")}
          className={quiet}
          data-qa="set-rent"
        >
          {rent.rate || rent.scheduled ? "Change" : "Set rent"}
        </button>
        {hasRent(rent) && (
          <button
            type="button"
            onClick={() => setDialog("history")}
            className={quiet}
            data-qa="rent-history"
          >
            History
          </button>
        )}
      </div>

      {dialog === "rent" && (
        <RentDialog
          linkId={linkId}
          businessName={businessName}
          rent={rent}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            onRent(next);
            setDialog(null);
          }}
        />
      )}
      {dialog === "pay" && (
        <PaymentDialog
          linkId={linkId}
          businessName={businessName}
          rent={rent}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            onRent(next);
            setDialog(null);
          }}
        />
      )}
      <HistoryDialog
        open={dialog === "history"}
        onClose={() => setDialog(null)}
        title={`Booth rent · ${businessName}`}
        who="owner"
        load={() => rentHistoryAction(linkId)}
        owner={{
          voidPayment: async (p) =>
            afterVoid(
              await voidRentPaymentAction(linkId, p.id),
              "Payment voided",
            ),
          voidRate: async (r) =>
            afterVoid(
              await voidRentRateAction(linkId, r.id),
              "Rent entry voided",
            ),
        }}
      />
    </div>
  );
}

const RENT_ERRORS: Record<string, string> = {
  start_required: "Pick the day rent starts.",
  start_out_of_range: "Pick a start within a year of today.",
};

/**
 * Start, change or stop. With rent in effect a change waits for the next
 * period (this one keeps its rate); with none, the owner picks the start day.
 */
function RentDialog({
  linkId,
  businessName,
  rent,
  onClose,
  onSaved,
}: {
  linkId: string;
  businessName: string;
  rent: RentSummary;
  onClose: () => void;
  onSaved: (next: RentSummary) => void;
}) {
  const { toast } = useToast();
  const inEffect = rent.rate;
  const scheduled = rent.scheduled;
  const [amount, setAmount] = useState(() => {
    const cents = scheduled?.amountCents ?? inEffect?.amountCents ?? null;
    return cents ? String(cents / 100) : "";
  });
  const [period, setPeriod] = useState<RentPeriod>(
    scheduled?.period ?? inEffect?.period ?? "WEEKLY",
  );
  const [startsOn, setStartsOn] = useState(
    !inEffect && scheduled ? scheduled.startsOn : todayYmd(),
  );
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const stopScheduled = scheduled !== null && scheduled.amountCents === null;
  // Rent never restarts before what's recorded, or before they (re)joined -
  // the server enforces it; this says so before they press Save.
  const earliest = rent.earliestStart;
  const tooEarly = Boolean(earliest && startsOn && startsOn < earliest);
  const tooEarlyMessage = earliest
    ? `Pick ${shortDay(earliest)} or later - rent can't reach back over what's recorded, or before they joined again.`
    : "Pick a later start.";

  async function save(stop: boolean) {
    setError(null);
    const parsed = stop ? null : centsFromInput(amount);
    if (parsed && !parsed.ok) {
      setAmountError(parsed.error);
      return;
    }
    setAmountError(null);
    if (!stop && !inEffect && !startsOn) {
      setError(RENT_ERRORS.start_required!);
      return;
    }
    if (!stop && !inEffect && tooEarly) {
      setError(tooEarlyMessage);
      return;
    }
    setSaving(true);
    const res = await setRentAction(
      linkId,
      parsed
        ? {
            amountCents: parsed.cents,
            period,
            ...(inEffect ? {} : { startsOn }),
          }
        : { amountCents: null },
    );
    setSaving(false);
    if (res.ok && res.rent) {
      const when = res.rent.scheduled
        ? shortDay(res.rent.scheduled.startsOn)
        : null;
      toast(
        stop
          ? inEffect && when
            ? `Rent stops ${when}`
            : "Start cancelled"
          : inEffect
            ? `Takes effect ${when ?? ""}`.trim()
            : when
              ? `Rent starts ${when}`
              : "Rent saved",
        "success",
      );
      onSaved(res.rent);
    } else {
      // What they typed stays; only the message changes. A retry is safe:
      // the same change sent twice is still one change.
      setError(
        res.error === "not_found"
          ? `${businessName} is no longer on your team.`
          : res.error === "start_too_early"
            ? tooEarlyMessage
            : (RENT_ERRORS[res.error ?? ""] ??
              "Couldn't confirm the change. Try again."),
      );
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Booth rent · ${businessName}`}
      footer={
        <div className="flex items-center justify-between gap-2">
          {(inEffect && !stopScheduled) || (!inEffect && scheduled) ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(true)}
              className="min-h-[40px] px-2 text-xs text-rose-300 hover:text-rose-200 disabled:opacity-50"
            >
              {inEffect ? "Stop rent" : "Cancel the start"}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={quiet}>
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(false)}
              className={primary}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <MoneyField
          label="Amount"
          value={amount}
          onChange={setAmount}
          error={amountError}
          placeholder="150"
          inputClassName="min-h-[40px]"
        />
        <div>
          <p className="text-xs text-muted">How often</p>
          <Segmented
            className="mt-1"
            size="comfortable"
            ariaLabel="How often rent is due"
            options={[
              { key: "WEEKLY", label: "Every week" },
              { key: "MONTHLY", label: "Every month" },
            ]}
            value={period}
            onChange={setPeriod}
          />
        </div>
        {inEffect ? (
          <p className="text-xs text-muted" data-qa="takes-effect">
            A change or a stop takes effect{" "}
            {shortDay(rent.nextChangeOn ?? inEffect.since)}. This{" "}
            {periodNoun(inEffect.period)} stays {money(inEffect.amountCents)}.
          </p>
        ) : (
          <label className="block">
            <span className="text-xs text-muted">Starts on</span>
            <input
              type="date"
              value={startsOn}
              min={earliest ?? undefined}
              onChange={(e) => setStartsOn(e.target.value)}
              className={field}
              data-qa="rent-starts-on"
            />
            <span className="mt-1 block text-[11px] text-muted">
              Rent is due from this day on. Nothing is owed before it.
              {earliest ? ` ${shortDay(earliest)} or later.` : ""}
            </span>
          </label>
        )}
        <FormError>{error}</FormError>
      </div>
    </Dialog>
  );
}

function PaymentDialog({
  linkId,
  businessName,
  rent,
  onClose,
  onSaved,
}: {
  linkId: string;
  businessName: string;
  rent: RentSummary;
  onClose: () => void;
  onSaved: (next: RentSummary) => void;
}) {
  const { toast } = useToast();
  // One period's rent is the usual payment; after a stop, what's left.
  const suggested = rent.rate?.amountCents ?? rent.balanceCents;
  const [amount, setAmount] = useState(
    suggested > 0 ? String(suggested / 100) : "",
  );
  const [date, setDate] = useState(todayYmd());
  const [method, setMethod] = useState("cash");
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One id per payment: a retry after a failed or lost response finds this
  // payment instead of recording a second one.
  const [clientRef] = useState(() => crypto.randomUUID());

  async function save() {
    setError(null);
    const parsed = centsFromInput(amount);
    if (!parsed.ok) {
      setAmountError(parsed.error);
      return;
    }
    setAmountError(null);
    setSaving(true);
    const res = await recordRentPaymentAction(linkId, {
      amountCents: parsed.cents,
      date,
      method,
      ...(note.trim() ? { note: note.trim() } : {}),
      clientRef,
    });
    setSaving(false);
    if (res.ok && res.rent) {
      toast(`${money(parsed.cents)} recorded`, "success");
      onSaved(res.rent);
    } else {
      setError(
        res.error === "invalid_date"
          ? "Pick today or an earlier date."
          : res.error === "not_found"
            ? `${businessName} is no longer on your team.`
            : "Couldn't confirm it was recorded. Try again - retrying here won't record it twice.",
      );
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Payment from ${businessName}`}
      subtitle={rentLines(rent, "owner").total?.label}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={quiet}>
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className={primary}
            data-qa="save-payment"
          >
            {saving ? "Saving…" : "Record payment"}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <MoneyField
          label="Amount"
          value={amount}
          onChange={setAmount}
          error={amountError}
          inputClassName="min-h-[40px]"
        />
        <p className="-mt-2 text-[11px] text-muted">
          Payments go to the oldest unpaid period first.
        </p>
        <label className="block">
          <span className="text-xs text-muted">Paid on</span>
          <input
            type="date"
            value={date}
            max={todayYmd()}
            onChange={(e) => setDate(e.target.value)}
            className={field}
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted">How</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className={field}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-muted">Note (optional)</span>
          <input
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            className={field}
          />
        </label>
        <FormError>{error}</FormError>
      </div>
    </Dialog>
  );
}

/**
 * A rent record either side can read but not change: the member's own rent
 * with a team, and - for either side - a relationship that has ended. The
 * same lines and history the owner's card shows.
 */
export function ReadOnlyRent({
  title,
  who,
  rent,
  loadHistory,
}: {
  title: string;
  who: "owner" | "member";
  rent: RentSummary;
  loadHistory: () => Promise<RentHistory | null>;
}) {
  const [open, setOpen] = useState(false);
  if (!hasRent(rent)) return null;
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-subtle px-4 py-3"
      data-qa="rent-readonly"
    >
      <RentLines rent={rent} who={who} />
      <button type="button" onClick={() => setOpen(true)} className={quiet}>
        History
      </button>
      <HistoryDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        who={who}
        load={loadHistory}
      />
    </div>
  );
}

/** The member's own rent with a team. Read-only. */
export function MemberRent({
  teamName,
  rent,
  loadHistory,
}: {
  teamName: string;
  rent: RentSummary;
  loadHistory: () => Promise<RentHistory | null>;
}) {
  return (
    <ReadOnlyRent
      title={`Booth rent · ${teamName}`}
      who="member"
      rent={rent}
      loadHistory={loadHistory}
    />
  );
}
