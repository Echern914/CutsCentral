"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { PaymentStatus } from "./actions";
import {
  disconnectStripeAction,
  savePaymentSettingsAction,
  savePayDirectAction,
  startConnectOnboardingAction,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";

export function PaymentsManager({
  initial,
  apiBase,
}: {
  initial: PaymentStatus;
  /** API origin. The Standard door is a top-level NAVIGATION to the API host,
   *  not a fetch — the session cookie is set on the parent domain so it rides. */
  apiBase: string;
}) {
  const vocab = useVocab();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [mode, setMode] = useState(initial.paymentsMode);
  // Held as raw strings so the field can be empty while typing. A numeric state
  // defaulting to 0 rendered a literal "0" the barber couldn't delete (typing
  // "40" showed "040"); the string lets the input clear, and we coerce on save.
  const [cancelHours, setCancelHours] = useState(String(initial.cancelWindowHours));
  // bps -> percent WITHOUT rounding, so a stored 4050 bps reloads as "40.5", not
  // "41" (a rounded initializer made the displayed value drift from what was
  // saved on every reload). Save re-multiplies by 100 and rounds to whole bps.
  const [cancelFeePct, setCancelFeePct] = useState(
    String(initial.cancelFeeBps / 100),
  );
  // Deposit shown in DOLLARS (cents is a storage detail, not something a barber
  // should type). $20 is the suggested default for a shop that has never set
  // one - it is the number Eric asked for and a realistic no-show deterrent.
  const [depositDollars, setDepositDollars] = useState(
    String((initial.depositAmountCents ?? 2000) / 100),
  );

  // Whether shown prices already include a tip. THREE states, not two: null
  // means the barber has not said, and the booking page then says nothing.
  // There is no safe default here - claiming “included” wrongly costs their
  // staff money, and claiming “not included” invents a policy they never set.
  const [tipPolicy, setTipPolicy] = useState(initial.tipPolicy);

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

  /**
   * The other door: the barber logs in at Stripe and authorises an account they
   * ALREADY own. A full-page navigation, not a fetch — it is an OAuth redirect
   * chain, exactly like the Acuity/Square connect buttons.
   */
  function linkExistingStripe() {
    start(() => {
      window.location.href = `${apiBase}/api/payments/connect/oauth/start`;
    });
  }

  function disconnectStripe() {
    start(async () => {
      const r = await disconnectStripeAction();
      if (r.ok) {
        setConfirmDisconnect(false);
        toast("Stripe disconnected", "success");
      } else {
        toast("Couldn't disconnect", "error");
      }
    });
  }

  function save() {
    start(async () => {
      // Coerce the raw string inputs and clamp to the API's bounds (fee 0-100%
      // -> 0-10000 bps, hours 0-720). An empty/garbage field saves as 0.
      const feePct = Math.min(100, Math.max(0, Number(cancelFeePct) || 0));
      const hours = Math.min(720, Math.max(0, Math.round(Number(cancelHours) || 0)));
      // $1 floor matches the API: "deposit mode with a $0 deposit" would be a
      // silently free booking, which is never what the barber meant.
      const depositCents = Math.min(
        100_000,
        Math.max(100, Math.round((Number(depositDollars) || 0) * 100)),
      );
      const r = await savePaymentSettingsAction({
        paymentsMode: mode,
        cancelWindowHours: hours,
        cancelFeeBps: Math.round(feePct * 100),
        ...(mode === "deposit" ? { depositAmountCents: depositCents } : {}),
        tipPolicy,
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
              Your money lands in your own Stripe account and pays out to your
              own bank. Stripe handles your details and payouts — ChairBack never
              sees your card or bank info.
            </p>
            {/* 🔴 TWO DOORS, and the order is deliberate. Most barbers have
                never taken card payments, so the door that makes an account for
                them leads. The other one exists because someone who ALREADY has
                Stripe should never be forced into a second account. Both end at
                the same place: an account they own, that we never hold money in. */}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                onClick={connectStripe}
                disabled={pending}
                className="rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
              >
                {pending ? "Starting…" : "Set up a new Stripe account"}
              </button>
              {initial.standardAvailable && (
                <button
                  onClick={linkExistingStripe}
                  disabled={pending}
                  className="rounded-xl border border-subtle px-5 py-2.5 text-sm font-medium text-offwhite transition-colors duration-150 ease-out hover:border-strong disabled:opacity-50"
                >
                  {pending ? "Opening…" : "I already have Stripe"}
                </button>
              )}
            </div>
            {initial.standardAvailable && (
              <p className="mt-2 text-xs text-muted">
                Linking keeps everything in the account you already use. Setting
                one up is the quicker route if you&apos;ve never taken card
                payments — you don&apos;t need a Stripe account beforehand.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {/* 🔴 WHICH account. Without this a barber has no way to tell the
                right Stripe account from the wrong one, and "wrong one" means
                their money is arriving somewhere they aren't looking. */}
            {initial.connectAccountLast4 && (
              <p className="text-xs text-muted">
                {initial.connectAccountType === "standard"
                  ? "Your own Stripe account, linked by you"
                  : "Stripe account set up through ChairBack"}{" "}
                · ends {initial.connectAccountLast4}
              </p>
            )}
            <StatusRow label="Charges enabled" ok={connect.chargesEnabled} />
            <StatusRow label="Payouts enabled" ok={connect.payoutsEnabled} />
            {!ready &&
              /* Only an EXPRESS account has a ChairBack-openable form to go back
                 to. A standard account is finished in the barber's own Stripe
                 dashboard, so offering a button that reopens nothing would send
                 them in a circle. */
              (initial.connectAccountType !== "standard" ? (
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
              ) : (
                <p className="mt-1 text-xs text-muted">
                  Stripe still needs a few details before you can take payments.
                  Finish them in your own Stripe dashboard — this page updates
                  when Stripe tells us you're done.
                </p>
              ))}

            <div className="mt-2 border-t border-subtle pt-2">
              {confirmDisconnect ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">
                    Stop sending payments to this account?
                  </span>
                  <button
                    onClick={disconnectStripe}
                    disabled={pending}
                    className="rounded-full bg-danger px-3 py-1.5 text-xs font-semibold text-offwhite disabled:opacity-60"
                  >
                    {pending ? "Disconnecting…" : "Yes, disconnect"}
                  </button>
                  <button
                    onClick={() => setConfirmDisconnect(false)}
                    className="rounded-full border border-subtle px-3 py-1.5 text-xs font-medium text-muted"
                  >
                    Keep it
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDisconnect(true)}
                  className="text-xs font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
                >
                  Disconnect this account
                </button>
              )}
              {/* Said plainly: money already taken is not affected, which is the
                  first thing anyone hesitating over this button worries about. */}
              <p className="mt-1.5 text-xs text-muted">
                New bookings fall back to paying in person. Payments already taken
                are unaffected.
              </p>
            </div>
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
            desc={`No online charge. Pay at the ${vocab.stationNoun}.`}
          />
          <ModeButton
            active={mode === "ahead"}
            onClick={() => ready && setMode("ahead")}
            disabled={!ready}
            title="Pay when booking"
            desc={ready ? "Card or Apple Pay, charged at booking." : "Connect Stripe first."}
          />
          <ModeButton
            active={mode === "deposit"}
            onClick={() => ready && setMode("deposit")}
            disabled={!ready}
            title="Deposit to book"
            desc={
              ready
                ? `A set amount now, the rest at the ${vocab.stationNoun}.`
                : "Connect Stripe first."
            }
          />
        </div>
        {mode === "deposit" && (
          <label className="mt-3 block max-w-56">
            <span className={labelCls}>Deposit amount</span>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-sm text-muted" aria-hidden="true">
                $
              </span>
              <input
                type="number"
                min={1}
                step="1"
                inputMode="decimal"
                className={field}
                value={depositDollars}
                onChange={(e) => setDepositDollars(e.target.value)}
                aria-label="Deposit amount in dollars"
              />
            </div>
            <span className="mt-1 block text-[11px] text-muted">
              Charged when they book. If a service costs less than this, we
              charge the service price instead — never more. A no-show keeps it;
              a cancellation follows your policy below.
            </span>
          </label>
        )}
        <p className="mt-3 text-xs text-muted">
          Pay-after (hold the card until the cut is done) is coming soon.
        </p>
      </Card>

      {/* Tips */}
      <Card className="p-5">
        <CardHeader
          title="Tips"
          subtitle="Tell customers whether the price they see already includes a tip. This is wording only — it never changes what you charge."
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
                { v: null, label: "Don’t say", hint: "Nothing about tips appears" },
                { v: "not_included" as const, label: "Tip not included", hint: "They can tip at the shop" },
                { v: "included" as const, label: "Tip included", hint: "Price covers everything" },
            ] as const
          ).map((o) => (
            <button
              key={String(o.v)}
              type="button"
              onClick={() => setTipPolicy(o.v)}
              aria-pressed={tipPolicy === o.v}
              className={cn(
                "rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                tipPolicy === o.v
                  ? "border-gold/60 bg-gold/10 text-offwhite"
                  : "border-subtle bg-charcoal-700 text-muted hover:text-offwhite",
              )}
            >
              <span className="block font-medium">{o.label}</span>
              <span className="block text-xs text-muted">{o.hint}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          Shown under the total on your booking page, and again on the payment
          screen if you collect online. Saved with the button below.
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
              onChange={(e) => setCancelHours(e.target.value)}
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
              onChange={(e) => setCancelFeePct(e.target.value)}
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
