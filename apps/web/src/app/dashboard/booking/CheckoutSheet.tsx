"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Sheet } from "./AppointmentForm";
import type { AgendaRow } from "./page";
import { checkoutAppointmentAction } from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * Appointment detail + chair-side checkout.
 *
 * Three steps, deliberately in this order: what the cut IS, what it COSTS, and
 * how it was PAID. Splitting price from payment is what lets the barber fold a
 * tip in or knock $5 off a regular without editing the service.
 *
 * 🔴 THIS RECORDS A SALE — IT DOES NOT CHARGE A CARD. ChairBack has no card
 * reader (Tap to Pay / Card Reader are Stripe Terminal, which needs the native
 * SDK and hardware). The barber collects however they already do, keeping 100%
 * of it, and the method here is a label so the money lands in Insights. The one
 * exception is money Stripe ALREADY holds from a pay-ahead booking: that shows
 * as "Already paid" and is subtracted from what is still owed, so nobody gets
 * asked for the same $60 twice.
 */

const METHODS = [
  { key: "cash" as const, label: "Cash", hint: "You keep 100%" },
  { key: "direct" as const, label: "Zelle · Venmo · Cash App", hint: "Sent to your handle" },
  { key: "card" as const, label: "Card", hint: "Your own reader" },
  { key: "other" as const, label: "Other", hint: "Comp, trade, split" },
];

export function CheckoutSheet({
  row,
  onClose,
  onDone,
  toast,
}: {
  row: AgendaRow;
  onClose: () => void;
  onDone: () => void;
  toast: Toast;
}) {
  const [view, setView] = useState<"detail" | "charges" | "pay">("detail");
  const [pending, start] = useTransition();

  const ticket = row.price ?? 0;
  const prepaid = row.prepaid ?? 0;
  // What the chair still needs to collect. Never negative: a shop that took
  // more up front than the ticket (a deposit plus a later discount) owes $0,
  // not a refund the barber would have to reason about at the chair.
  const owed = Math.max(0, ticket - prepaid);
  const alreadyPaid = row.paid != null;

  // The editable figure. Seeded from what's owed, so the common case is one tap
  // through — "Modify" exists for the tip and the regular's discount.
  const [amount, setAmount] = useState<string>(owed.toFixed(2));
  const [method, setMethod] = useState<(typeof METHODS)[number]["key"] | null>(null);
  const parsed = Number.parseFloat(amount);
  const amountValid = Number.isFinite(parsed) && parsed >= 0;

  const dateLabel = useMemo(() => {
    const d = new Date(row.start);
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(d);
  }, [row.start]);
  const timeLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
    const s = fmt.format(new Date(row.start));
    const e = row.end ? fmt.format(new Date(row.end)) : null;
    const mins =
      row.end != null
        ? Math.round((Date.parse(row.end) - Date.parse(row.start)) / 60_000)
        : null;
    return `${s}${e ? `–${e}` : ""}${mins ? ` · ${mins}min` : ""}`;
  }, [row.start, row.end]);

  function submit() {
    if (!method || !amountValid) return;
    start(async () => {
      const res = await checkoutAppointmentAction(row.id, {
        amount: Number(parsed.toFixed(2)),
        method,
      });
      if (!res.ok) {
        // The 409 is the double-tap guard, and it deserves its own words: the
        // money DID land, so "try again" would be exactly wrong advice.
        toast(
          res.error === "paid_already"
            ? "This cut was already checked out"
            : "Couldn't save the checkout",
          "error",
        );
        return;
      }
      toast(`Paid $${parsed.toFixed(2)} · ${row.clientName}`, "success");
      onDone();
    });
  }

  const card = "rounded-xl border border-subtle bg-charcoal-800/40 p-4";
  const label = "text-[11px] font-medium uppercase tracking-wide text-muted";

  //  Step 3 — how it was paid
  if (view === "pay") {
    return (
      <Sheet title="Checkout" onClose={onClose}>
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-subtle bg-charcoal-800/40 px-4 py-3 text-center text-xs text-muted">
            <p className="font-medium text-offwhite">{row.clientName}</p>
            <p className="mt-0.5">
              {dateLabel} · {timeLabel}
            </p>
            {row.serviceName && <p className="mt-0.5">{row.serviceName}</p>}
          </div>

          <div className="py-2 text-center">
            <label className="sr-only" htmlFor="checkout-amount">
              Amount collected
            </label>
            <div className="flex items-center justify-center gap-1">
              <span className="font-display text-3xl text-muted">$</span>
              <input
                id="checkout-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={!amountValid || undefined}
                className="w-40 bg-transparent text-center font-display text-5xl tabular-nums text-offwhite outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
              />
            </div>
            {!amountValid ? (
              <p role="alert" className="mt-1 text-xs text-danger-soft">
                Enter an amount.
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">
                {prepaid > 0
                  ? `$${prepaid.toFixed(2)} already paid online · $${ticket.toFixed(2)} ticket`
                  : "Tap to change — tips and discounts go here"}
              </p>
            )}
          </div>

          <div>
            <p className={label}>How did they pay?</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {METHODS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMethod(m.key)}
                  aria-pressed={method === m.key}
                  className={cn(
                    "flex items-center justify-between rounded-lg border px-3.5 py-3 text-left text-sm transition-colors",
                    method === m.key
                      ? "border-gold/50 bg-gold/10 text-gold"
                      : "border-subtle text-offwhite hover:border-subtle-strong",
                  )}
                >
                  <span className="font-medium">{m.label}</span>
                  <span
                    className={cn(
                      "text-[11px]",
                      method === m.key ? "text-gold/80" : "text-muted",
                    )}
                  >
                    {m.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setView("charges")}
              className="rounded-xl border border-subtle px-4 py-3 text-sm text-muted transition-colors hover:text-offwhite"
            >
              Back
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || !method || !amountValid}
              className="flex-1 rounded-xl bg-offwhite py-3 text-center text-sm font-semibold text-charcoal transition-colors hover:bg-white disabled:opacity-50"
            >
              {pending
                ? "Saving…"
                : method
                  ? `Mark paid · $${amountValid ? parsed.toFixed(2) : "—"}`
                  : "Pick a payment method"}
            </button>
          </div>
          <p className="text-center text-[11px] text-muted">
            Records the sale and marks the cut done. ChairBack never touches the
            money — you keep 100%.
          </p>
        </div>
      </Sheet>
    );
  }

  //  Step 2 — what it costs
  if (view === "charges") {
    return (
      <Sheet title="Checkout" onClose={onClose}>
        <div className="flex flex-col gap-4">
          <div className={card}>
            <p className={label}>Charges</p>
            <div className="mt-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-offwhite">
                  {row.serviceName ?? "Appointment"}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {dateLabel} · {timeLabel}
                </p>
              </div>
              <span className="shrink-0 text-sm tabular-nums text-offwhite">
                ${ticket.toFixed(2)}
              </span>
            </div>
            {/* Add-ons are already folded into the ticket price at booking, so
                they are itemised here for the barber's eyes, never re-added. */}
            {(row.addOns ?? []).length > 0 && (
              <ul className="mt-2 border-t border-subtle pt-2">
                {(row.addOns ?? []).map((a) => (
                  <li key={a.id} className="py-0.5 text-xs text-muted">
                    + {a.name}
                  </li>
                ))}
                <li className="pt-1 text-[10px] text-muted/70">Included in the price above</li>
              </ul>
            )}
          </div>

          {prepaid > 0 && (
            <div className="flex justify-between rounded-xl border border-emerald-soft/30 bg-emerald-soft/5 px-4 py-3 text-sm">
              <span className="text-emerald-soft">Already paid online</span>
              <span className="tabular-nums text-emerald-soft">−${prepaid.toFixed(2)}</span>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-subtle pt-3">
            <span className="text-sm text-muted">Due now</span>
            <span className="font-display text-2xl tabular-nums text-offwhite">
              ${owed.toFixed(2)}
            </span>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setView("detail")}
              className="rounded-xl border border-subtle px-4 py-3 text-sm text-muted transition-colors hover:text-offwhite"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setView("pay")}
              className="flex-1 rounded-xl bg-offwhite py-3 text-center text-sm font-semibold text-charcoal transition-colors hover:bg-white"
            >
              Next
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  //  Step 1 — the appointment itself
  return (
    <Sheet title="Appointment" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          {row.clientId ? (
            <Link
              href={`/dashboard/clients/${row.clientId}`}
              className="inline-flex items-center gap-1.5 font-display text-2xl text-offwhite transition-colors hover:text-gold"
            >
              {row.clientName}
              <span aria-hidden="true" className="text-base text-muted">
                ↗
              </span>
              <span className="sr-only">Open client</span>
            </Link>
          ) : (
            <p className="font-display text-2xl text-offwhite">{row.clientName}</p>
          )}
        </div>

        <div className={card}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-offwhite">
                {row.serviceName ?? "Appointment"}
              </p>
              <p className="mt-1 text-xs text-muted">
                {dateLabel} · {timeLabel}
              </p>
            </div>
            {row.price != null && (
              <span className="shrink-0 text-sm tabular-nums text-offwhite">
                ${ticket.toFixed(2)}
              </span>
            )}
          </div>
        </div>

        {alreadyPaid ? (
          <div className="rounded-xl border border-emerald-soft/30 bg-emerald-soft/5 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-emerald-soft">Paid ✓</span>
              <span className="font-display text-xl tabular-nums text-emerald-soft">
                ${(row.paid ?? 0).toFixed(2)}
              </span>
            </div>
            {row.paidMethod && (
              <p className="mt-1 text-xs text-muted">
                {METHODS.find((m) => m.key === row.paidMethod)?.label ?? row.paidMethod}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-subtle bg-charcoal-800/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className={label}>Remaining</p>
                <p className="mt-0.5 font-display text-2xl tabular-nums text-offwhite">
                  ${owed.toFixed(2)}
                </p>
                {prepaid > 0 && (
                  <p className="mt-0.5 text-[11px] text-emerald-soft">
                    ${prepaid.toFixed(2)} paid online
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setView("charges")}
                className="shrink-0 rounded-xl bg-offwhite px-5 py-3 text-sm font-semibold text-charcoal transition-colors hover:bg-white"
              >
                Start checkout
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
