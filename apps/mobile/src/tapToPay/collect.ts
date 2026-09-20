import type { TapToPayOutcome, TapToPayRequest } from "./protocol";

/**
 * One contactless collection, as a sequence of SDK calls.
 *
 * 🔴 NOTHING HERE HAS EVER TAKEN A PAYMENT. It cannot be run without the Apple
 * entitlement, a supported iPhone and a real card, none of which exist in CI or
 * on a simulator. What IS tested is the decision-making below, against a fake
 * terminal - the order of the steps, what happens when one of them fails, and
 * the rule that this function never decides a payment succeeded. Treat the
 * whole file as unproven until the real-device script in
 * `docs/service-checkout.md` has been run and ticked.
 *
 * WHY THE SDK IS BEHIND AN INTERFACE. Not for purity: the real
 * `useStripeTerminal` hook can only run inside a React tree on a device with
 * the native module linked, so without this seam there is no way to exercise
 * the sequence at all, and the failure paths - which are the ones that matter
 * for money - would ship entirely unexamined.
 */

export interface TerminalLike {
  /** Find the built-in NFC reader. On iPhone this is the phone itself. */
  discoverTapToPayReader(): Promise<{ reader: unknown } | { error: string }>;
  connect(params: {
    reader: unknown;
    locationId: string;
    onBehalfOf: string;
  }): Promise<{ ok: true } | { error: string }>;
  retrieve(clientSecret: string): Promise<{ paymentIntent: unknown } | { error: string }>;
  /** Waits for the customer to present a card. */
  collect(paymentIntent: unknown): Promise<{ paymentIntent: unknown } | { error: string; code?: string }>;
  confirm(paymentIntent: unknown): Promise<{ status: string } | { error: string; code?: string }>;
}

export interface CollectResult {
  outcome: TapToPayOutcome;
  message?: string;
}

/** Error codes the SDK reports that mean "the barber or customer stopped". */
const CANCELLATION_CODES = new Set(["Canceled", "CommandCancelled", "canceled", "cancelled"]);
/** …and the ones that mean a card was read and refused. */
const DECLINE_CODES = new Set(["DeclinedByStripeAPI", "DeclinedByReader", "card_declined"]);

function classify(err: { error: string; code?: string }): CollectResult {
  if (err.code && CANCELLATION_CODES.has(err.code)) return { outcome: "canceled", message: err.error };
  if (err.code && DECLINE_CODES.has(err.code)) return { outcome: "declined", message: err.error };
  return { outcome: "failed", message: err.error };
}

/**
 * Drive one collection to a conclusion.
 *
 * 🔴 THIS FUNCTION DOES NOT DECIDE THAT MONEY ARRIVED, and the shape of the
 * return value is the reason it cannot. `collected` means "the SDK says the
 * intent confirmed, go and ask the server" - the page's next move is always to
 * call /tap-to-pay-settle, which reads Stripe itself. A device reporting
 * success is a client reporting success, and the entire checkout design refuses
 * to record money on a client's word.
 *
 * The consequence that matters: every failure path below is safe to report
 * honestly, because none of them writes anything. The attempt stays open on the
 * server until the server itself concludes it.
 */
export async function collectTapToPay(
  terminal: TerminalLike,
  request: TapToPayRequest,
): Promise<CollectResult> {
  const discovered = await terminal.discoverTapToPayReader();
  if ("error" in discovered) {
    // No reader means this device cannot do it at all - an older iPhone, a
    // build without the entitlement, a region where Tap to Pay is not offered.
    // "Unavailable" so the screen can say so instead of implying a card failed.
    return { outcome: "unavailable", message: discovered.error };
  }

  const connected = await terminal.connect({
    reader: discovered.reader,
    locationId: request.locationId,
    // 🔴 DESTINATION CHARGES. The reader connects on the PLATFORM account and
    // the money is destined for the barber's, so the connected account rides
    // on the connection as `onBehalfOf` - never a Stripe-Account header. This
    // must match the intent's own on_behalf_of or Stripe refuses the confirm.
    onBehalfOf: request.connectAccountId,
  });
  if ("error" in connected) return { outcome: "unavailable", message: connected.error };

  const retrieved = await terminal.retrieve(request.clientSecret);
  if ("error" in retrieved) return { outcome: "failed", message: retrieved.error };

  // The customer presents a card. This is where the barber is holding the phone
  // out and the only thing that should end it is a tap or a cancel.
  const collected = await terminal.collect(retrieved.paymentIntent);
  if ("error" in collected) return classify(collected);

  const confirmed = await terminal.confirm(collected.paymentIntent);
  if ("error" in confirmed) return classify(confirmed);

  // Even here the answer is "ask the server", not "paid".
  return confirmed.status === "succeeded"
    ? { outcome: "collected" }
    : { outcome: "failed", message: `intent ${confirmed.status}` };
}
