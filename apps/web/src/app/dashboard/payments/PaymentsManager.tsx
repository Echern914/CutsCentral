"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { PaymentStatus } from "./actions";
import {
  savePaymentSettingsAction,
  savePayDirectAction,
  startConnectOnboardingAction,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";

export function PaymentsManager({ initial }: { initial: PaymentStatus }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState(initial.paymentsMode);
  const [cancelHours, setCancelHours] = useState(initial.cancelWindowHours);
  const [cancelFeePct, setCancelFeePct] = useState(
    Math.round(initial.cancelFeeBps / 100),
  );

  // Fee-free pay-direct (Zelle/Venmo/Cash App) — independent of Stripe Connect.
  const [pd, setPd] = useState(initial.payDirect);
  function setPdField<K extends keyof typeof pd>(k: K, v: (typeof pd)[K]) {
    setPd((prev) => ({ ...prev, [k]: v }));
  }
  function savePayDirect() {
    start(async () => {
      const r = await savePayDirectAction({
        enabled: pd.enabled,
        zelle: pd.zelle ?? "",
        venmo: pd.venmo ?? "",
        cashApp: pd.cashApp ?? "",
        note: pd.note ?? "",
      });
      if (r.ok) toast("Pay-direct settings saved", "success");
      else toast("Couldn't save", "error");
    });
  }

  const { connect, connectAvailable } = initial;
  const ready = connect.chargesEnabled;

  function connectStripe() {
    start(async () => {
      const r = await startConnectOnboardingAction();
      if (r.ok && r.url) {
        window.location.href = r.url; // Stripe-hosted onboarding
      } else {
        toast("Couldn't start Stripe setup", "error");
      }
    });
  }

  function save() {
    start(async () => {
      const r = await savePaymentSettingsAction({
        paymentsMode: mode,
        cancelWindowHours: cancelHours,
        cancelFeeBps: Math.round(cancelFeePct * 100),
      });
      if (r.ok) toast("Payment settings saved", "success");
      else if (r.error === "connect_not_ready")
        toast("Finish connecting Stripe before turning payments on", "error");
      else toast("Couldn't save", "error");
    });
  }

  const payDirectCard = (
    <Card className="p-5">
      <CardHeader
        title="Pay you directly — no fees"
        subtitle="Let clients send payment straight to your Zelle, Venmo, or Cash App. Money lands in your bank with zero ChairBack or card fees."
      />
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={pd.enabled}
          onChange={(e) => setPdField("enabled", e.target.checked)}
          className="h-4 w-4 accent-gold"
        />
        Show my direct-payment info on the booking confirmation
      </label>
      {pd.enabled && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Zelle (email or phone)</span>
            <input
              className={field}
              placeholder="you@email.com or 555-123-4567"
              value={pd.zelle ?? ""}
              onChange={(e) => setPdField("zelle", e.target.value)}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Venmo</span>
            <input
              className={field}
              placeholder="@your-handle"
              value={pd.venmo ?? ""}
              onChange={(e) => setPdField("venmo", e.target.value)}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Cash App</span>
            <input
              className={field}
              placeholder="$yourcashtag"
              value={pd.cashApp ?? ""}
              onChange={(e) => setPdField("cashApp", e.target.value)}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Note (optional)</span>
            <input
              className={field}
              placeholder="e.g. Zelle or cash on arrival"
              value={pd.note ?? ""}
              onChange={(e) => setPdField("note", e.target.value)}
            />
          </label>
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        Heads up: ChairBack only shows this info — it doesn&apos;t process or
        confirm these payments (Zelle, Venmo, and Cash App don&apos;t allow that).
        You&apos;ll confirm payment yourself, the same as cash.
      </p>
      <button
        onClick={savePayDirect}
        disabled={pending}
        className="mt-4 self-start rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save pay-direct settings"}
      </button>
    </Card>
  );

  // Pay-direct needs NO Stripe, so it must show even when Connect is unavailable.
  if (!connectAvailable) {
    return (
      <div className="flex flex-col gap-5">
        <Card className="p-5 text-sm text-muted">
          Card payments aren&apos;t enabled on this platform yet — but you can still
          collect payment directly below, with no fees.
        </Card>
        {payDirectCard}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Connect status */}
      <Card className="p-5">
        <CardHeader title="Your Stripe account" subtitle="Where your payments land." />
        {!connect.connected ? (
          <div className="mt-3">
            <p className="text-sm text-muted">
              Connect a Stripe account to start taking payments. Stripe handles
              the signup, your bank details, and payouts — ChairBack never sees
              your card or bank info.
            </p>
            <button
              onClick={connectStripe}
              disabled={pending}
              className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
            >
              {pending ? "Starting…" : "Connect with Stripe"}
            </button>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <StatusRow label="Charges enabled" ok={connect.chargesEnabled} />
            <StatusRow label="Payouts enabled" ok={connect.payoutsEnabled} />
            {!ready && (
              <>
                <p className="mt-1 text-xs text-muted">
                  Stripe still needs a few details before you can take payments.
                </p>
                <button
                  onClick={connectStripe}
                  disabled={pending}
                  className="mt-1 self-start rounded-xl border border-subtle px-4 py-2 text-sm text-offwhite disabled:opacity-50"
                >
                  {pending ? "Opening…" : "Finish Stripe setup"}
                </button>
              </>
            )}
          </div>
        )}
      </Card>

      {/* Payment mode */}
      <Card className="p-5">
        <CardHeader title="How customers pay" />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <ModeButton
            active={mode === "off"}
            onClick={() => setMode("off")}
            title="In person"
            desc="No online charge. Pay at the chair."
          />
          <ModeButton
            active={mode === "ahead"}
            onClick={() => ready && setMode("ahead")}
            disabled={!ready}
            title="Pay when booking"
            desc={ready ? "Card or Apple Pay, charged at booking." : "Connect Stripe first."}
          />
        </div>
        <p className="mt-3 text-xs text-muted">
          Pay-after (hold the card until the cut is done) is coming soon.
        </p>
      </Card>

      {/* Cancellation policy */}
      <Card className="p-5">
        <CardHeader
          title="Cancellation policy"
          subtitle="Customers can always cancel; you decide the cutoff + fee."
        />
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Free-cancel cutoff (hours before)</span>
            <input
              type="number"
              min={0}
              className={field}
              value={cancelHours}
              onChange={(e) => setCancelHours(Number(e.target.value))}
            />
            <span className="mt-1 block text-[11px] text-muted">
              0 = always full refund.
            </span>
          </label>
          <label className="block">
            <span className={labelCls}>Fee if cancelled inside the cutoff (%)</span>
            <input
              type="number"
              min={0}
              max={100}
              className={field}
              value={cancelFeePct}
              onChange={(e) => setCancelFeePct(Number(e.target.value))}
            />
            <span className="mt-1 block text-[11px] text-muted">
              100 = no refund inside the cutoff.
            </span>
          </label>
        </div>
      </Card>

      <button
        onClick={save}
        disabled={pending}
        className="self-start rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save payment settings"}
      </button>

      {/* Fee-free direct payment — shown alongside card payments. */}
      {payDirectCard}
    </div>
  );
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span>{label}</span>
      <span className={ok ? "text-emerald-soft" : "text-muted"}>
        {ok ? "✓ Yes" : "Not yet"}
      </span>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  desc,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-xl border p-3 text-left transition-colors disabled:opacity-50",
        active ? "border-gold/60 bg-gold/10" : "border-subtle hover:bg-charcoal-700",
      )}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs text-muted">{desc}</span>
    </button>
  );
}
