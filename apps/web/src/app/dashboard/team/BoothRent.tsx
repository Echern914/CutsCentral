"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Segmented } from "@/components/ui/Segmented";
import { MoneyField } from "@/components/ui/UnitField";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  PAYMENT_METHODS,
  centsFromInput,
  describeRent,
  methodLabel,
  money,
  rentStatus,
  shortDay,
  todayYmd,
  type RentPayment,
  type RentPeriod,
  type RentSummary,
} from "@/lib/boothRent";
import {
  deleteRentPaymentAction,
  recordRentPaymentAction,
  rentHistoryAction,
  setRentAction,
} from "./actions";

const quiet =
  "min-h-[40px] rounded-full border border-subtle px-4 text-xs text-muted transition-colors hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-50";
const primary =
  "min-h-[40px] rounded-full bg-gold px-4 text-xs font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";
const field =
  "mt-1 min-h-[40px] w-full rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite outline-none focus:border-gold/50";

type History = { summary: RentSummary; payments: RentPayment[] };

function RentLine({ rent, who }: { rent: RentSummary; who: "owner" | "member" }) {
  const status = rentStatus(rent, who);
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted">Booth rent</p>
      <p className={cn("text-sm", status ? "text-offwhite" : "text-muted")}>{describeRent(rent) ?? "Not set"}</p>
      {status && (
        <p
          className={cn("text-xs", status.owing ? "font-semibold text-gold" : "text-emerald-soft")}
          data-qa="rent-status"
        >
          {status.label}
        </p>
      )}
    </div>
  );
}

/** Every payment, newest first. `onRemove` = the owner's view. */
function PaymentsDialog({
  open,
  onClose,
  title,
  load,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  load: () => Promise<History | null>;
  onRemove?: (p: RentPayment) => Promise<boolean>;
}) {
  const [data, setData] = useState<History | "loading" | "failed">("loading");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function refresh() {
    setData("loading");
    setData((await load()) ?? "failed");
  }
  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      {data === "loading" ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : data === "failed" ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted">Couldn&apos;t load the payments.</p>
          <button type="button" onClick={() => void refresh()} className={quiet}>
            Try again
          </button>
        </div>
      ) : data.payments.length === 0 ? (
        <p className="text-sm text-muted">No payments yet.</p>
      ) : (
        <ul className="divide-y divide-subtle">
          {data.payments.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2.5" data-qa="rent-payment">
              <div className="min-w-0">
                <p className="text-sm text-offwhite">
                  {money(p.amountCents)} · {methodLabel(p.method)}
                </p>
                <p className="truncate text-xs text-muted">
                  {shortDay(p.paidOn)}
                  {p.note ? ` · ${p.note}` : ""}
                </p>
              </div>
              {onRemove &&
                (confirming === p.id ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={removing !== null}
                      onClick={async () => {
                        setRemoving(p.id);
                        const ok = await onRemove(p);
                        setRemoving(null);
                        setConfirming(null);
                        if (ok) await refresh();
                      }}
                      className="min-h-[40px] rounded-full bg-rose-500/90 px-3 text-[11px] font-semibold text-white disabled:opacity-50"
                    >
                      {removing === p.id ? "Removing…" : "Remove it"}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="min-h-[40px] px-2 text-[11px] text-muted">
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(p.id)}
                    className="min-h-[40px] shrink-0 px-2 text-[11px] text-muted hover:text-offwhite"
                  >
                    Remove
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** The owner's booth rent for one member: the line, and Record payment / Set / Payments. */
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
  const [dialog, setDialog] = useState<null | "rent" | "pay" | "payments">(null);
  const hasRent = rent.amountCents !== null;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-subtle px-3 py-2.5">
      <RentLine rent={rent} who="owner" />
      <div className="flex flex-wrap gap-2">
        {hasRent && (
          <button type="button" onClick={() => setDialog("pay")} className={primary} data-qa="record-payment">
            Record payment
          </button>
        )}
        <button type="button" onClick={() => setDialog("rent")} className={quiet} data-qa="set-rent">
          {hasRent ? "Change" : "Set rent"}
        </button>
        {(hasRent || rent.lastPayment) && (
          <button type="button" onClick={() => setDialog("payments")} className={quiet}>
            Payments
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
      <PaymentsDialog
        open={dialog === "payments"}
        onClose={() => setDialog(null)}
        title={`${businessName} · rent payments`}
        load={() => rentHistoryAction(linkId)}
        onRemove={async (p) => {
          const res = await deleteRentPaymentAction(linkId, p.id);
          if (res.ok && res.rent) {
            onRent(res.rent);
            toast("Payment removed", "success");
            return true;
          }
          toast("Couldn't remove it - try again", "error");
          return false;
        }}
      />
    </div>
  );
}

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
  const [amount, setAmount] = useState(rent.amountCents ? String(rent.amountCents / 100) : "");
  const [period, setPeriod] = useState<RentPeriod>(rent.period ?? "WEEKLY");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(turnOff: boolean) {
    setError(null);
    const parsed = turnOff ? null : centsFromInput(amount);
    if (parsed && !parsed.ok) {
      setAmountError(parsed.error);
      return;
    }
    setAmountError(null);
    setSaving(true);
    const res = await setRentAction(linkId, parsed ? { amountCents: parsed.cents, period } : { amountCents: null });
    setSaving(false);
    if (res.ok && res.rent) {
      toast(turnOff ? "Rent turned off" : "Rent saved", "success");
      onSaved(res.rent);
    } else {
      // What they typed stays; only the message changes.
      setError(
        res.error === "not_found"
          ? `${businessName} is no longer on your team.`
          : "Couldn't save that - nothing changed. Try again.",
      );
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${businessName}'s booth rent`}
      footer={
        <div className="flex items-center justify-between gap-2">
          {rent.amountCents !== null ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(true)}
              className="min-h-[40px] px-2 text-xs text-rose-300 hover:text-rose-200 disabled:opacity-50"
            >
              Turn off rent
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={quiet}>
              Cancel
            </button>
            <button type="button" disabled={saving} onClick={() => void save(false)} className={primary}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <MoneyField label="Amount" value={amount} onChange={setAmount} error={amountError} placeholder="150" />
        <div>
          <p className="text-xs text-muted">How often</p>
          <Segmented
            className="mt-1"
            ariaLabel="How often rent is due"
            options={[
              { key: "WEEKLY", label: "Every week" },
              { key: "MONTHLY", label: "Every month" },
            ]}
            value={period}
            onChange={setPeriod}
          />
        </div>
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
  const suggested = rent.dueCents > 0 ? rent.dueCents : (rent.amountCents ?? 0);
  const [amount, setAmount] = useState(suggested > 0 ? String(suggested / 100) : "");
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
            : "Couldn't record that - nothing was saved. Try again.",
      );
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Record ${businessName}'s payment`}
      subtitle={rentStatus(rent, "owner")?.label}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={quiet}>
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={() => void save()} className={primary} data-qa="save-payment">
            {saving ? "Saving…" : "Record payment"}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <MoneyField label="Amount" value={amount} onChange={setAmount} error={amountError} />
        <label className="block">
          <span className="text-xs text-muted">Paid on</span>
          <input type="date" value={date} max={todayYmd()} onChange={(e) => setDate(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-muted">How</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={field}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-muted">Note (optional)</span>
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={field} />
        </label>
        <FormError>{error}</FormError>
      </div>
    </Dialog>
  );
}

/** The member's own rent with a team: the line, and their payments. Read-only. */
export function MemberRent({
  teamName,
  rent,
  loadHistory,
}: {
  teamName: string;
  rent: RentSummary;
  loadHistory: () => Promise<History | null>;
}) {
  const [open, setOpen] = useState(false);
  if (rent.amountCents === null && !rent.lastPayment) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-subtle px-4 py-3">
      <RentLine rent={rent} who="member" />
      <button type="button" onClick={() => setOpen(true)} className={quiet}>
        Payments
      </button>
      <PaymentsDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Booth rent · ${teamName}`}
        load={loadHistory}
      />
    </div>
  );
}
