"use client";

import { useState } from "react";
import Link from "next/link";
import { PaymentStep } from "../../[slug]/PaymentStep";
import { bookingStatusAction, cardSavedAction } from "../../[slug]/actions";
import type { ManageData } from "./page";

/**
 * Finish a booking that is still waiting on its card - from the booking's own
 * link, after the customer left the card screen.
 *
 * The SAME card step the booking page showed (same intent, same Element), so a
 * card saved here promotes the hold exactly as it would have there: we ask the
 * server to check with Stripe (card-saved), then read the real status. Stripe
 * telling the browser "saved" is not a booking; only the server's BOOKED is.
 */

/** ChairBack gold - this page has no shop accent to borrow. */
const ACCENT = "#D4AF37";

type Finish = NonNullable<ManageData["finish"]>;

export function FinishCheckout({
  token,
  finish,
  shopName,
  shopSlug,
  until,
  onBooked,
}: {
  token: string;
  finish: Finish;
  shopName: string;
  shopSlug: string | null;
  /** "1:04 PM", in the shop's time. */
  until: string;
  onBooked: () => void;
}) {
  const [state, setState] = useState<"form" | "checking" | "slow" | "gone">("form");

  async function confirm() {
    setState("checking");
    // Card on file: have the server verify with Stripe rather than wait on a
    // webhook - the hold is on a ten-minute fuse.
    if (finish.kind === "setup") await cardSavedAction(token);
    const deadline = Date.now() + 25_000;
    for (;;) {
      const res = await bookingStatusAction(token);
      if (res.ok && res.status === "BOOKED") {
        onBooked();
        return;
      }
      if (res.ok && (res.status === "CANCELED" || res.status === "NO_SHOW")) {
        setState("gone");
        return;
      }
      if (Date.now() >= deadline) {
        setState("slow");
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  if (state === "checking") {
    return (
      <p role="status" className="mt-6 text-center text-sm text-muted">
        Received. Confirming your booking&hellip;
      </p>
    );
  }
  if (state === "slow") {
    return (
      <p role="status" className="mt-6 rounded-xl border border-subtle p-4 text-sm text-muted">
        <span className="font-medium text-offwhite">That went through.</span> We&rsquo;re still confirming with{" "}
        {shopName} - refresh this page in a minute to see your booking.
      </p>
    );
  }
  if (state === "gone") {
    return (
      <div role="alert" className="mt-6 rounded-xl border border-gold/40 bg-gold/10 p-4 text-sm">
        <p className="font-medium text-offwhite">That time was released before it went through.</p>
        <p className="mt-1 text-muted">
          You have not been charged - anything taken is refunded in full, and the card has been let go.
        </p>
        {shopSlug && (
          <Link href={`/book/${shopSlug}`} className="mt-2 inline-block font-semibold text-offwhite underline">
            Book a new time
          </Link>
        )}
      </div>
    );
  }

  const heading =
    finish.kind === "setup"
      ? "Save a card to book this time"
      : finish.isDeposit
        ? "Pay the deposit to book this time"
        : "Pay to book this time";
  const amountLabel = finish.kind === "setup" ? null : `$${(finish.amountCents / 100).toFixed(0)}`;

  return (
    <section className="mt-6 rounded-xl border border-gold/40 bg-gold/10 p-4" data-qa="finish-checkout">
      <p className="text-xs font-semibold uppercase tracking-wide text-gold">Not booked yet</p>
      <h2 className="mt-1 text-base font-semibold text-offwhite">{heading}</h2>
      <p className="mt-1 text-sm text-muted">
        We&rsquo;re holding it for you until <span className="font-medium text-offwhite">{until}</span>. After
        that it goes back on sale.
        {finish.kind === "setup" ? (
          finish.serviceChargeConsent ? (
            <>
              {" "}
              You aren&rsquo;t charged today. As you agreed, {shopName} can charge this card for your service once
              your appointment is finished.
            </>
          ) : (
            <> You aren&rsquo;t charged today - you pay at your visit.</>
          )
        ) : finish.isDeposit && finish.balanceDueCents > 0 ? (
          <> The remaining ${(finish.balanceDueCents / 100).toFixed(0)} is due at {shopName}.</>
        ) : null}
      </p>
      <div className="mt-4">
        <PaymentStep
          clientSecret={finish.clientSecret}
          amountLabel={amountLabel}
          intent={finish.kind}
          accent={ACCENT}
          returnUrl={typeof window !== "undefined" ? window.location.href : ""}
          onPaid={() => void confirm()}
        />
      </div>
    </section>
  );
}
