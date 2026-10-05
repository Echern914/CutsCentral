"use client";

import { useState } from "react";
import { PaymentStep } from "../../[slug]/PaymentStep";
import { cardSavedAction } from "../../[slug]/actions";
import type { ManageData } from "./page";

/**
 * ADD A CARD to a booking that already stands.
 *
 * A card shop that books without a card confirms the client at Confirm and
 * asks for a card after, optionally. A client who skipped it can add one here,
 * from the booking's own link: the same card form (same SetupIntent), so a
 * card saved here is filed exactly as it would have been on the booking page.
 * Nothing about the booking depends on it, and the panel says so - the
 * opposite of FinishCheckout, which exists because a booking DID depend on it.
 */

/** ChairBack gold - this page has no shop accent to borrow. */
const ACCENT = "#D4AF37";

type AddCardOffer = NonNullable<ManageData["addCard"]>;

export function AddCard({
  token,
  offer,
  shopName,
  onSaved,
}: {
  token: string;
  offer: AddCardOffer;
  shopName: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"form" | "saving" | "saved">("form");

  async function saved() {
    setState("saving");
    // The server checks with Stripe and files it; the browser's word is not enough.
    await cardSavedAction(token).catch(() => null);
    setState("saved");
    onSaved();
  }

  if (state === "saved") {
    return (
      <p role="status" className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-muted">
        <span className="font-medium text-offwhite">Card saved.</span> {shopName} keeps it on file for this appointment.
      </p>
    );
  }
  if (state === "saving") {
    return (
      <p role="status" className="mt-4 text-center text-sm text-muted">
        Card received. Putting it on file&hellip;
      </p>
    );
  }

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4" data-qa="add-card">
      <h2 className="text-sm font-semibold text-offwhite">Add a card to keep on file</h2>
      <p className="mt-1 text-sm text-muted">
        You&rsquo;re booked either way. {shopName} asks for a card to keep on file - you aren&rsquo;t charged today
        {offer.serviceChargeConsent
          ? ", and as you agreed, it can be charged for your service once your appointment is finished."
          : ", and you pay at your visit."}
      </p>
      {open ? (
        <div className="mt-4">
          <PaymentStep
            clientSecret={offer.clientSecret}
            amountLabel={null}
            intent="setup"
            accent={ACCENT}
            returnUrl={typeof window !== "undefined" ? window.location.href : ""}
            onPaid={() => void saved()}
            onSkip={() => setOpen(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 w-full rounded-xl border border-gold/40 py-3 text-center text-sm font-semibold text-offwhite transition-colors duration-200 ease-out hover:bg-gold/10"
        >
          Add a card
        </button>
      )}
    </section>
  );
}
