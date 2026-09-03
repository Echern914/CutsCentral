"use client";

import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { readableOn } from "@/lib/contrast";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";

/**
 * The card / Apple Pay step. Mounts Stripe's Payment Element against the
 * PaymentIntent client secret returned from the booking create call. On confirm,
 * the charge settles to the barber's connected account (a destination charge
 * created platform-side, so the customer uses the PLATFORM publishable key — no
 * stripeAccount option needed).
 *
 * 🔴 THIS COMPONENT DOES NOT DECIDE THAT THE BOOKING IS CONFIRMED. Stripe
 * telling the browser the payment succeeded is a different fact from ChairBack
 * having a booking: the appointment is a HOLD until `payment_intent.succeeded`
 * reaches the webhook and promotes it. So `onPaid` means "the money is away,
 * go and ask the server" — the parent polls, and only the server's answer puts
 * "You're booked!" on the screen.
 *
 * WALLETS. Apple Pay / Google Pay / Link appear as tabs in the Payment Element
 * when three things line up: the API enabled `automatic_payment_methods`, the
 * page's domain is registered with Stripe (billing/paymentMethodDomains.ts
 * re-asserts that every boot), and the browser supports the wallet. Nothing is
 * configured here, deliberately — a hand-written wallet list is one more copy
 * to drift, and the Element already knows better than we do what this device
 * can actually pay with.
 *
 * Inside the iOS shell the WebView injects a bridge script, and WebKit disables
 * Apple Pay on any page that has been touched by injected JavaScript. Card
 * still works and the tab is simply absent; nothing here needs to know.
 */

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    stripePromise = key ? loadStripe(key) : Promise.resolve(null);
  }
  return stripePromise;
}

/** Is the browser able to pay at all? False only when the build has no key. */
const STRIPE_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

export function PaymentStep({
  clientSecret,
  amountLabel,
  accent,
  returnUrl,
  onPaid,
  intent = "payment",
}: {
  clientSecret: string;
  amountLabel: string | null;
  accent: string;
  /**
   * Where a redirect-based method sends the customer back to. REQUIRED by
   * Stripe the moment a payment method needs to leave the page, and its
   * absence used to be an unrecoverable dead end mid-hold: the Element offers
   * whatever the barber's account supports, and several of those redirect.
   */
  returnUrl: string;
  /** The money is away. The PARENT confirms with the server. */
  onPaid: () => void;
  /**
   * "payment" confirms a PaymentIntent (money moves). "setup" confirms a
   * SetupIntent: the card is saved and NOTHING is charged - card on file.
   * Same Element, same wallets, same hand-off; only the Stripe call differs.
   */
  intent?: "payment" | "setup";
}) {
  // A missing publishable key is a deployment fault, not a customer error, and
  // the old screen expressed it as an inert "Pay $20" button over a chair that
  // was already being held. Say what is true and give them the way out.
  if (!STRIPE_CONFIGURED) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200"
      >
        <p className="font-medium">Card payment isn&rsquo;t available right now.</p>
        <p className="mt-1 text-amber-200/80">
          Nothing has been charged. Please call the shop to finish booking this time.
        </p>
      </div>
    );
  }
  return (
    <Elements
      stripe={getStripe()}
      options={{
        clientSecret,
        appearance: { theme: "night", variables: { colorPrimary: accent } },
      }}
    >
      <PaymentForm
        amountLabel={amountLabel}
        accent={accent}
        returnUrl={returnUrl}
        onPaid={onPaid}
        intent={intent}
      />
    </Elements>
  );
}

function PaymentForm({
  amountLabel,
  accent,
  returnUrl,
  onPaid,
  intent = "payment",
}: {
  amountLabel: string | null;
  accent: string;
  returnUrl: string;
  onPaid: () => void;
  intent?: "payment" | "setup";
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  // The Element mounts asynchronously in a cross-origin iframe. Until it is
  // ready there is nothing to type into, and a live "Pay" button over an empty
  // box reads as broken.
  const [ready, setReady] = useState(false);
  // Stripe.js itself can fail to load (an offline moment, a blocked CDN). The
  // promise resolves null and `stripe` stays null forever, so the button would
  // sit disabled with no explanation at all.
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  useEffect(() => {
    if (ready) return;
    const t = window.setTimeout(() => setLoadTimedOut(true), 12_000);
    return () => window.clearTimeout(t);
  }, [ready]);

  async function pay() {
    if (!stripe || !elements) return;
    setError(null);
    setPaying(true);
    // `if_required` keeps the common card path on-page; a method that MUST
    // redirect (and several the Element offers do) leaves and comes back to
    // return_url, where the confirmation screen picks the booking up by its
    // manage token.
    // Both calls answer { error } or the intent; only the Stripe object differs.
    let err: { message?: string } | undefined;
    let paymentIntent: { status: string } | undefined;
    if (intent === "setup") {
      const r = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
        confirmParams: { return_url: returnUrl },
      });
      err = r.error;
      paymentIntent = r.setupIntent;
    } else {
      const r = await stripe.confirmPayment({
        elements,
        redirect: "if_required",
        confirmParams: { return_url: returnUrl },
      });
      err = r.error;
      paymentIntent = r.paymentIntent;
    }
    if (err) {
      setError(
        err.message ??
          (intent === "setup" ? "We couldn't save that card. Please try another." : "Payment failed. Please try another card."),
      );
      setPaying(false);
      return;
    }
    // 🔴 `processing` is NOT `succeeded`. It used to be treated as one, which
    // is how a customer whose payment later failed ended up holding a
    // confirmation page for an appointment the sweep had already cancelled.
    // Both go to the parent, which asks the server what actually happened —
    // the difference is that `processing` may legitimately take a while, and
    // only the server can tell us when it lands.
    if (
      paymentIntent &&
      (paymentIntent.status === "succeeded" || paymentIntent.status === "processing")
    ) {
      onPaid();
      return;
    }
    setError("Payment didn't complete. Please try again.");
    setPaying(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {!ready && !loadTimedOut && (
        <p className="text-xs text-muted" role="status">
          Loading secure payment…
        </p>
      )}
      {loadTimedOut && !ready && (
        <p role="alert" className="text-xs text-amber-300">
          The payment form is taking longer than usual. Check your connection —
          nothing has been charged.
        </p>
      )}
      <PaymentElement options={{ layout: "tabs" }} onReady={() => setReady(true)} />
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={pay}
        disabled={!stripe || !ready || paying}
        aria-busy={paying}
        className="w-full rounded-xl py-3 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01] disabled:opacity-50"
        style={{ backgroundColor: accent, color: readableOn(accent) }}
      >
        {paying
          ? "Processing…"
          : intent === "setup"
            ? "Save card & confirm"
            : amountLabel
              ? `Pay ${amountLabel}`
              : "Pay & confirm"}
      </button>
    </div>
  );
}
