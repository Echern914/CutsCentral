"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { PaymentStatus } from "./actions";
import {
  savePaymentSettingsAction,
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

  if (!connectAvailable) {
    return (
      <Card className="p-5 text-sm text-muted">
        Online payments aren&apos;t enabled on this platform yet. Customers pay in
        person for now.
      </Card>
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
