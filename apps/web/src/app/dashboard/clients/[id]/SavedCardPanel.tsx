/**
 * "Card on file" on a client's profile: the card they asked the shop to keep
 * for their future appointments (billing/savedCard.ts).
 *
 * The owner: "in the client database they can also have their card on file
 * there so they don't have to keep adding it." It lives here, and every
 * appointment made for this client - by them online, or by the shop - carries
 * it, so it is charged where charges already happen: a no-show or a late
 * cancellation under the shop's policy, and the service at checkout when the
 * client allowed that on the booking. There is deliberately no free-form
 * "charge this card" button: the client agreed to those uses, not to any
 * amount at any time.
 *
 * Display facts only - brand, last four, expiry. Only the client can take it
 * off, from their appointment link.
 */

export interface SavedCardFacts {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  savedAt: string;
}

export function SavedCardPanel({ card, timezone }: { card: SavedCardFacts; timezone: string }) {
  const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : "Card";
  const expiry =
    card.expMonth && card.expYear ? `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}` : null;
  const saved = new Date(card.savedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  });
  return (
    <section className="rounded-2xl border border-subtle p-4" data-qa="client-saved-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Card on file</p>
      <p className="mt-1 text-sm font-medium text-offwhite">
        {brand}
        {card.last4 ? ` •••• ${card.last4}` : ""}
        {expiry ? <span className="font-normal text-muted"> · expires {expiry}</span> : null}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Saved by the client on {saved} for their future appointments - so they don&rsquo;t enter it again. Every
        booking for them carries it: a no-show or late cancellation is charged under your policy, and the service can
        be charged at checkout when they allowed it on that booking. Only the client can remove it, from their
        appointment link.
      </p>
    </section>
  );
}
