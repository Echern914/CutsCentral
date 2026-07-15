"use client";

import { useState } from "react";
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
 * stripeAccount option needed). On success the parent shows the confirmation.
 *
 * The publishable key is a build-time public env (NEXT_PUBLIC_*). When it's
 * absent we can't render the Element — the parent guards on that.
 */

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    stripePromise = key ? loadStripe(key) : Promise.resolve(null);
  }
  return stripePromise;
}

export function PaymentStep({
  clientSecret,
  amountLabel,
  accent,
  onPaid,
}: {
  clientSecret: string;
  amountLabel: string | null;
  accent: string;
  onPaid: () => void;
}) {
  return (
    <Elements
      stripe={getStripe()}
      options={{
        clientSecret,
        appearance: { theme: "night", variables: { colorPrimary: accent } },
      }}
    >
      <PaymentForm amountLabel={amountLabel} accent={accent} onPaid={onPaid} />
    </Elements>
  );
}

function PaymentForm({
  amountLabel,
  accent,
  onPaid,
}: {
  amountLabel: string | null;
  accent: string;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  async function pay() {
    if (!stripe || !elements) return;
    setError(null);
    setPaying(true);
    // No redirect: confirm in-place and let the parent advance on success. (A
    // payment method that REQUIRES a redirect will still redirect; on return the
    // PaymentIntent status is already terminal and the webhook has recorded it.)
    const { error: err, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });
    if (err) {
      setError(err.message ?? "Payment failed. Please try another card.");
      setPaying(false);
      return;
    }
    if (paymentIntent && (paymentIntent.status === "succeeded" || paymentIntent.status === "processing")) {
      onPaid();
      return;
    }
    setError("Payment didn't complete. Please try again.");
    setPaying(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={pay}
        disabled={!stripe || paying}
        aria-busy={paying}
        className="w-full rounded-xl py-3 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01] disabled:opacity-50"
        style={{ backgroundColor: accent, color: readableOn(accent) }}
      >
        {paying ? "Processing…" : amountLabel ? `Pay ${amountLabel}` : "Pay & confirm"}
      </button>
    </div>
  );
}
