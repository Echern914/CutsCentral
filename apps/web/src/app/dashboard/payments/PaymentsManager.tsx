"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { APP_NAME } from "@chairback/config/constants";
import { useEffect, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import type { PaymentStatus } from "./actions";
import {
  disconnectStripeAction,
  openStripeDashboardAction,
  savePaymentSettingsAction,
  savePayDirectAction,
  setOnlineTipsAction,
  startStripeConnectHandoffAction,
} from "./actions";

/**
 * The native shell's bridge, when the page runs inside the app. `__cbNative`
 * is injected by app builds that can open a system authentication browser
 * (apps/mobile/src/AppWebView.tsx); an older build has the postMessage bridge
 * but not that flag, and must be told to connect from a browser instead.
 */
interface NativeBridge {
  ReactNativeWebView?: { postMessage: (m: string) => void };
  __cbNative?: { openAuth?: boolean };
}

/**
 * What Stripe's OAuth round-trip says when it lands the barber back here
 * (?connect=…). Without this the page said NOTHING after a redirect, so a
 * refused link looked exactly like a broken button.
 */
const CONNECT_RESULT: Record<string, { text: string; tone: "success" | "error" }> = {
  linked: { text: "Your Stripe account is connected. Payments land there from now on.", tone: "success" },
  already: {
    text: "This shop already has a working Stripe account. Disconnect it first to switch.",
    tone: "error",
  },
  cancelled: { text: "No changes — you left Stripe without authorizing.", tone: "error" },
  taken: { text: "That Stripe account is already connected to another shop.", tone: "error" },
  unavailable: { text: "Connecting a Stripe account isn't available right now.", tone: "error" },
  error: { text: "Stripe didn't complete the connection. Please try again.", tone: "error" },
};

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";

/** What the API accepts for a Venmo username or a $cashtag (payments.dashboard.ts). */
const PAY_HANDLE = /^[A-Za-z0-9._-]*$/;

/**
 * A handle as the barber pasted it, made into what the API stores: a pasted
 * profile link keeps only its last part, and the leading @ or $ goes.
 */
export function payHandle(raw: string | null | undefined, sigil: RegExp): string {
  const v = (raw ?? "").trim();
  const lastPart = /^(https?:\/\/)?(www\.)?(venmo\.com|account\.venmo\.com|cash\.app)\//i.test(v)
    ? (v.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "")
    : v;
  return lastPart.replace(sigil, "");
}

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
  const inApp = useIsNativeApp();
  // Shown when this app build cannot open Stripe's sign-in properly (see
  // linkExistingStripe): the honest alternative, not a blank page.
  const [browserHelp, setBrowserHelp] = useState(false);
  const [mode, setMode] = useState(initial.paymentsMode);
  // card_on_file: the fee switch. Separate from the mode on purpose - keeping
  // a card is not, by itself, a decision to charge anyone.
  const [chargeFees, setChargeFees] = useState(initial.chargeCardOnFileFees ?? false);
  // card_on_file: is the card a condition of the booking? Off (the default):
  // Confirm books them and the card step is optional.
  const [requireCard, setRequireCard] = useState(initial.requireCardToBook ?? false);
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
  // Deposit mode: is the deposit kept when a CLIENT cancels? Off by default -
  // the cancellation policy below decides, as it always has.
  const [depositNonRefundable, setDepositNonRefundable] = useState(
    initial.depositNonRefundable ?? false,
  );

  // Whether shown prices already include a tip. THREE states, not two: null
  // means the barber has not said, and the booking page then says nothing.
  // There is no safe default here - claiming “included” wrongly costs their
  // staff money, and claiming “not included” invents a policy they never set.
  const [tipPolicy, setTipPolicy] = useState(initial.tipPolicy);
  // Online tips after the visit: saved the moment it is switched (its own
  // route), with the outcome said right here.
  const [onlineTips, setOnlineTips] = useState(initial.onlineTipsEnabled ?? false);
  const [tipsSaving, setTipsSaving] = useState(false);
  const [tipsNotice, setTipsNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  async function switchOnlineTips(next: boolean) {
    if (tipsSaving) return;
    setTipsSaving(true);
    setTipsNotice(null);
    try {
      const r = await setOnlineTipsAction(next).catch(() => ({ ok: false, error: "network_error" }));
      if (r.ok) {
        setOnlineTips(next);
        setTipsNotice({
          tone: "good",
          text: next
            ? "On. Clients can tip from their appointment page after a finished visit."
            : "Off. Clients are no longer offered a tip.",
        });
      } else {
        setTipsNotice({
          tone: "bad",
          text:
            r.error === "connect_not_ready"
              ? "Finish connecting Stripe first - tips need an account that can take payments."
              : "Couldn't save. Nothing changed - try again.",
        });
      }
    } finally {
      setTipsSaving(false);
    }
  }

  // Fee-free pay-direct (Zelle/Venmo/Cash App) — independent of Stripe Connect.
  const [pd, setPd] = useState(initial.payDirect);
  function setPdField<K extends keyof typeof pd>(k: K, v: (typeof pd)[K]) {
    setPd((prev) => ({ ...prev, [k]: v }));
  }
  function savePayDirect() {
    // The API's own rules, checked here so the barber is told WHICH box to fix
    // (a pasted profile link or a space used to get a bare "Couldn't save").
    const venmo = payHandle(pd.venmo, /^@/);
    const cashApp = payHandle(pd.cashApp, /^\$/);
    const problem =
      !PAY_HANDLE.test(venmo) || venmo.length > 60
        ? "Venmo: just your username, with letters, numbers, . _ or - (no spaces or links)."
        : !PAY_HANDLE.test(cashApp) || cashApp.length > 60
          ? "Cash App: just your $cashtag, with letters, numbers, . _ or - (no spaces or links)."
          : (pd.zelle ?? "").trim().length > 120
            ? "Zelle: an email or phone number, under 120 characters."
            : (pd.note ?? "").trim().length > 280
              ? "Note: keep it under 280 characters."
              : null;
    if (problem) {
      toast(problem, "error");
      return;
    }
    start(async () => {
      const r = await savePayDirectAction({
        enabled: pd.enabled,
        zelle: pd.zelle ?? "",
        venmo,
        cashApp,
        note: pd.note ?? "",
      });
      if (r.ok) {
        setPd((prev) => ({ ...prev, venmo, cashApp }));
        toast("Pay-direct settings saved", "success");
      } else toast("Couldn't save. Check the handles and try again.", "error");
    });
  }

  const { connect, connectAvailable } = initial;
  const ready = connect.chargesEnabled;
  // An account made by the retired Express door. Working ones (money inside)
  // keep working; an unfinished one is only in the way.
  const isExpress = connect.connected && initial.connectAccountType !== "standard";
  const unfinishedExpress = isExpress && !ready;

  // Say what the OAuth round-trip concluded, once, then clean the URL so a
  // reload doesn't repeat it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("connect");
    if (!outcome) return;
    const msg = CONNECT_RESULT[outcome];
    if (msg) toast(msg.text, msg.tone);
    params.delete("connect");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Where the money is. An account set up through ChairBack is an Express
   * account, which has NO login at stripe.com - a barber who goes looking there
   * finds nothing and assumes the payment never arrived (FadesByMikey,
   * 2026-09-02, while a collected deposit sat in his balance). The only way in
   * is a one-time link the platform mints, so this button IS the door.
   */
  function openStripeDashboard() {
    start(async () => {
      const r = await openStripeDashboardAction();
      if (r.ok && r.url) {
        window.location.href = r.url;
      } else {
        toast("Couldn't open your Stripe dashboard", "error");
      }
    });
  }

  /**
   * THE door (since 2026-09-02): the barber logs in at Stripe and authorises an
   * account they own. A full-page navigation, not a fetch — it is an OAuth
   * redirect chain, exactly like the Acuity/Square connect buttons. Express
   * (a Stripe-managed account behind a separate login) is no longer offered:
   * it is where "nothing is showing in my Stripe" came from.
   */
  function linkExistingStripe() {
    if (inApp) {
      // 🔴 Stripe's sign-in dead-ends inside an embedded WebView (a blank page
      // after "Continue with email"). Inside the app the connection runs in
      // the SYSTEM authentication browser instead: ask the API for a
      // ready-made authorize URL and hand it to the shell, which reloads this
      // page with ?connect=… when the sheet closes. An app build without that
      // capability gets told to use a browser rather than sent into the wall.
      const bridge = window as unknown as NativeBridge;
      if (!bridge.__cbNative?.openAuth || !bridge.ReactNativeWebView) {
        setBrowserHelp(true);
        return;
      }
      start(async () => {
        const r = await startStripeConnectHandoffAction();
        if (r.ok && r.url) {
          bridge.ReactNativeWebView!.postMessage(
            JSON.stringify({
              type: "cb:open-auth",
              url: r.url,
              returnUrl: "chairback://stripe/connected",
              resumePath: "/dashboard/payments",
            }),
          );
        } else {
          toast(
            r.error === "already"
              ? CONNECT_RESULT.already!.text
              : "Couldn't start the Stripe connection. Please try again.",
            "error",
          );
        }
      });
      return;
    }
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
    // 🔴 OUT OF RANGE IS REFUSED, NEVER QUIETLY CHANGED. These used to clamp:
    // a $1,500 deposit saved as $1,000 (and $0.50 as $1) under "Payment
    // settings saved", while the box still showed what was typed. An empty
    // box still means 0 for the fee and the cutoff, as before.
    const feePct = cancelFeePct.trim() === "" ? 0 : Number(cancelFeePct);
    const hoursRaw = cancelHours.trim() === "" ? 0 : Number(cancelHours);
    const depositRaw = Number(depositDollars);
    const problem =
      !Number.isFinite(feePct) || feePct < 0 || feePct > 100
        ? "The cancellation fee must be 0 to 100%."
        : !Number.isFinite(hoursRaw) || hoursRaw < 0 || hoursRaw > 720
          ? "The cancellation cutoff must be 0 to 720 hours."
          : mode === "deposit" && !(Number.isFinite(depositRaw) && depositRaw >= 1 && depositRaw <= 1000)
            ? "The deposit must be $1 to $1,000."
            : null;
    if (problem) {
      toast(problem, "error");
      return;
    }
    const hours = Math.round(hoursRaw);
    const depositCents = Math.round(depositRaw * 100);
    start(async () => {
      const r = await savePaymentSettingsAction({
        // 🔴 Stripe can't charge (disconnected, or the account slipped): the
        // stored mode is inert - bookings pay in person - and re-sending it got
        // the WHOLE save refused with "Finish connecting Stripe", even to change
        // a cancellation policy. Leave it out; everything else still saves.
        ...(ready || mode === "off" ? { paymentsMode: mode } : {}),
        cancelWindowHours: hours,
        cancelFeeBps: Math.round(feePct * 100),
        ...(mode === "deposit" ? { depositAmountCents: depositCents, depositNonRefundable } : {}),
        ...(mode === "card_on_file" ? { chargeCardOnFileFees: chargeFees, requireCardToBook: requireCard } : {}),
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
        {browserHelp && (
          <div className="mt-3 rounded-xl border border-gold/30 bg-gold/5 px-3.5 py-3 text-sm">
            <p className="text-offwhite">
              Stripe&apos;s sign-in needs a full browser, and this version of the
              app can&apos;t open one for it yet.
            </p>
            <p className="mt-1 text-xs text-muted">
              Open <span className="text-offwhite">getchairback.com</span> in
              Safari or Chrome, sign in, go to Payments, and tap{" "}
              <span className="text-offwhite">Connect your Stripe account</span>.
              It takes about two minutes, and this page updates on its own once
              it&apos;s done.
            </p>
          </div>
        )}
        {!connect.connected ? (
          <div className="mt-3">
            <p className="text-sm text-muted">
              Your money lands in your own Stripe account and pays out to your
              own bank. Stripe handles your details and payouts — ChairBack never
              sees your card or bank info.
            </p>
            {/* 🔴 ONE DOOR. The barber's own Stripe account, linked by logging in
                at stripe.com and authorizing. No Stripe-managed (Express)
                account is created any more: those live behind a separate login,
                which is exactly how a collected deposit came to look "missing". */}
            {initial.standardAvailable ? (
              <>
                <button
                  onClick={linkExistingStripe}
                  disabled={pending}
                  className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
                >
                  {pending ? "Opening…" : "Connect your Stripe account"}
                </button>
                <p className="mt-2 text-xs text-muted">
                  You&apos;ll log in at Stripe and approve {APP_NAME}. No Stripe
                  account yet? Create one free at stripe.com first, then come
                  back and tap this — it takes a few minutes.
                </p>
              </>
            ) : (
              <p className="mt-3 rounded-xl border border-subtle bg-charcoal-700/50 px-3.5 py-2.5 text-xs text-muted">
                Connecting a Stripe account isn&apos;t switched on for this
                platform yet — the Stripe Connect client ID is missing on the
                server. Nothing to do on your side.
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

            {unfinishedExpress ? (
              /* 🔴 THE STUCK STATE. An Express account the retired door started
                 and nobody finished. Every button used to lead back into
                 "Sign in to Express"; now the one button here replaces it with
                 the barber's own account (the API allows the swap only for an
                 Express account that has never been able to charge). */
              <div className="mt-1 rounded-xl border border-gold/30 bg-gold/5 px-3.5 py-3">
                <p className="text-sm text-offwhite">
                  This is a Stripe Express setup that was started through {APP_NAME}{" "}
                  and never finished. It holds no money.
                </p>
                <p className="mt-1 text-xs text-muted">
                  Connect your own Stripe account instead — it replaces this one
                  in one step, and payments land where you can see them.
                </p>
                {initial.standardAvailable ? (
                  <button
                    onClick={linkExistingStripe}
                    disabled={pending}
                    className="mt-3 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
                  >
                    {pending ? "Opening…" : "Connect your Stripe account"}
                  </button>
                ) : (
                  <p className="mt-2 text-xs text-muted">
                    Connecting a Stripe account isn&apos;t switched on for this
                    platform yet.
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* 🔴 THE DOOR TO THE MONEY. Every payment ChairBack takes lands
                    in THIS account. For an Express account this button is the
                    only way to see its balance and payouts — stripe.com will not
                    show it. For a Standard one it is simply their dashboard. */}
                <div className="mt-1 flex flex-col gap-1">
                  <button
                    onClick={openStripeDashboard}
                    disabled={pending}
                    className="self-start rounded-xl bg-gold px-4 py-2 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
                  >
                    {pending ? "Opening…" : "See your balance & payouts in Stripe"}
                  </button>
                  <p className="text-xs text-muted">
                    Every card payment and deposit taken through {APP_NAME} lands
                    here. New money shows as <em>pending</em> for two business days,
                    then pays out to your bank on Stripe&apos;s schedule.
                  </p>
                </div>
                {!ready && (
                  <p className="mt-1 text-xs text-muted">
                    Stripe still needs a few details before you can take payments.
                    Finish them in your Stripe dashboard — this page updates when
                    Stripe tells us you&apos;re done.
                  </p>
                )}
                {isExpress && ready && (
                  <p className="mt-1 text-xs text-muted">
                    This account was set up through {APP_NAME} and lives behind
                    Stripe&apos;s Express login (the button above). Prefer your
                    own Stripe account? Once its pending payouts have cleared,
                    disconnect it below and connect yours.
                  </p>
                )}
              </>
            )}

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
          <ModeButton
            active={mode === "card_on_file"}
            onClick={() => ready && setMode("card_on_file")}
            disabled={!ready}
            title="Card on file"
            desc={
              ready
                ? `No charge at booking. They pay at the ${vocab.stationNoun}; the card is kept in case of a no-show.`
                : "Connect Stripe first."
            }
          />
        </div>
        {mode === "card_on_file" && (
          <div className="mt-3 rounded-xl border border-subtle p-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={chargeFees}
                onChange={(e) => setChargeFees(e.target.checked)}
                aria-label="Charge the card on file for no-shows and late cancellations"
              />
              <span>
                <span className="block text-sm font-medium">
                  Charge the card for no-shows and late cancellations
                </span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  Off by default: the card is only ever kept. On: when you mark a
                  no-show, or a customer cancels inside your free-cancel cutoff, the
                  fee below is charged to the card they saved. Nothing else is ever
                  charged to it.
                </span>
              </span>
            </label>
            <label className="mt-3 flex items-start gap-3 border-t border-subtle pt-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={requireCard}
                onChange={(e) => setRequireCard(e.target.checked)}
                aria-label="Require a saved card to book"
              />
              <span>
                <span className="block text-sm font-medium">Require a saved card to book</span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  Off (recommended): Confirm books them, and the card step after it is optional, so
                  nobody who skips it loses their time. On: the time is held for 10 minutes while they
                  save a card, and goes back on sale if they don&rsquo;t.
                  {chargeFees && !requireCard && " A booking made without a card can't be charged a no-show fee."}
                </span>
              </span>
            </label>
          </div>
        )}
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
              {depositNonRefundable
                ? " so does a client's cancellation (Deposit refunds, below)."
                : " a cancellation follows your policy below."}
            </span>
          </label>
        )}
        <p className="mt-3 text-xs text-muted">
          Pay-after (hold the card until the cut is done) is coming soon.
        </p>
      </Card>

      {/* Tips. `id` is the registry's deep link (FEATURE_INDEX "tips"). */}
      <Card id="tips" className="p-5">
        <CardHeader
          title="Tips"
          subtitle="Let clients tip online after a visit, and say whether your prices already include a tip."
        />

        {/* Online tips: a real money switch, saved the moment it is flipped. */}
        <div className="mt-3 rounded-xl border border-subtle p-3" data-qa="online-tips">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-offwhite">Online tips after the visit</p>
              <p className="mt-0.5 text-xs text-muted">
                Once a visit is done, clients can leave 15, 20 or 25% or their own amount from their
                appointment page, and about an hour after a visit you finish they get one email with a
                Leave a tip link. Stripe&rsquo;s card fee comes out of each tip, as at any card reader;
                {" "}{APP_NAME} keeps none of it.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={onlineTips}
              aria-label="Online tips after the visit"
              // Turning tips OFF always works; ON needs a Stripe account that can take payments.
              disabled={tipsSaving || (!onlineTips && !ready)}
              onClick={() => void switchOnlineTips(!onlineTips)}
              className={cn(
                "shrink-0 rounded-full border px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-50",
                onlineTips
                  ? "border-gold/60 bg-gold/15 text-offwhite"
                  : "border-subtle bg-charcoal-700 text-muted hover:text-offwhite",
              )}
            >
              {tipsSaving ? "Saving…" : onlineTips ? "On" : "Off"}
            </button>
          </div>
          {!ready && !onlineTips && (
            <p className="mt-2 text-xs text-muted">Connect Stripe first.</p>
          )}
          {onlineTips && tipPolicy === "included" && (
            <p className="mt-2 text-xs text-muted">
              Your prices say they include a tip, so clients aren&rsquo;t offered one.
            </p>
          )}
          {tipsNotice && (
            <p
              role="status"
              className={cn("mt-2 text-xs", tipsNotice.tone === "good" ? "text-emerald-soft" : "text-danger-soft")}
            >
              {tipsNotice.text}
            </p>
          )}
        </div>

        <p className="mt-4 text-xs font-medium text-offwhite">Do your prices include a tip?</p>
        <div className="mt-2 flex flex-wrap gap-2">
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
          Wording only - it never changes what you charge. Shown under the total
          on your booking page, and again on the payment screen if you collect
          online. Saved with the button below.
        </p>
      </Card>

      {/* Deposit refunds - deposit mode only, next to Tips as Eric asked. */}
      {mode === "deposit" && (
        <Card id="deposit-refunds" className="p-5">
          <CardHeader
            title="Deposit refunds"
            subtitle="What happens to the deposit when a client cancels. If you cancel a booking, the deposit is always refunded in full."
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                { v: false, label: "Follow my cancellation policy", hint: "Refunded, less any fee below" },
                { v: true, label: "Non-refundable", hint: "Kept when a client cancels" },
              ] as const
            ).map((o) => (
              <button
                key={String(o.v)}
                type="button"
                onClick={() => setDepositNonRefundable(o.v)}
                aria-pressed={depositNonRefundable === o.v}
                className={cn(
                  "rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                  depositNonRefundable === o.v
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
            Applies to bookings made after you save. Bookings already made keep the
            terms they were booked on. Your booking page tells clients before they
            pay. You can still give a kept deposit back from that appointment on
            your calendar. Saved with the button below.
          </p>
        </Card>
      )}

      {/* Cancellation policy */}
      <Card className="p-5">
        <CardHeader
          title="Cancellation policy"
          subtitle="Customers can always cancel; you decide the cutoff + fee."
        />
        {mode === "deposit" && depositNonRefundable && (
          <p className="mt-3 text-xs text-gold">
            Your deposit is non-refundable, so when a client cancels it is kept
            whatever the cutoff. The cutoff and fee below apply to bookings made
            before you switched it on.
          </p>
        )}
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
