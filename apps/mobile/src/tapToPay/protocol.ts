/**
 * The page <-> shell protocol for Tap to Pay. Pure, so the part that can be
 * got wrong is testable without an iPhone, a reader or a card.
 *
 * 🔴 WHO DECIDES THE MONEY, AND WHY IT IS NOT THIS FILE. The dashboard runs in
 * a WebView and holds the barber's session; the native shell holds none. So the
 * PAGE calls /tap-to-pay-intent, where the server checks the amount against the
 * balance it computed, and passes down only a client secret. The shell drives
 * the reader with that secret and reports what happened.
 *
 * That ordering is deliberate. A protocol in which the shell named an amount
 * would be a client naming a price with extra steps, and the whole checkout
 * design refuses that. Nothing crossing this boundary can change what is
 * charged: the amount is already fixed inside the intent before the shell hears
 * about it, and `amountCents` below is carried ONLY so the native sheet can
 * show the barber the same figure the screen did.
 *
 * A connection token cannot be fetched by the shell either, for the same
 * reason - the API wants a session - so the SDK's request for one is relayed
 * back to the page and answered by it.
 */

/** Collect this payment. Page -> shell. */
export interface TapToPayRequest {
  /** Correlates the reply. One press, one id - the same one the server saw. */
  requestId: string;
  /** The PaymentIntent to collect against. Its amount is already fixed. */
  clientSecret: string;
  /** Destination-charge account, which Tap to Pay needs to configure itself. */
  connectAccountId: string;
  /** The shop's Terminal Location. A reader cannot connect without one. */
  locationId: string;
  /** Display only. The intent, not this number, decides what is charged. */
  amountCents: number;
}

/** A connection token the SDK asked for, fetched by the page. Page -> shell. */
export interface TapToPayTokenReply {
  nonce: string;
  secret: string | null;
}

export type PageMessage =
  | { kind: "collect"; request: TapToPayRequest }
  | { kind: "token"; reply: TapToPayTokenReply }
  /**
   * Show Apple's required "How to Tap" education, if this device has not seen
   * it. Sent when the barber first CHOOSES Tap to Pay - the "enabling" moment
   * Apple's requirement describes - and deliberately not when they collect:
   * Apple's overlay has no dismissal callback, so presenting it during a
   * collection would put an instructional sheet over a live payment.
   */
  | { kind: "education"; requestId: string };

/** What the shell tells the page when a collection ends. */
export type TapToPayOutcome =
  /** The card was read and Stripe confirmed. The SERVER still verifies this. */
  | "collected"
  /** The barber backed out, or the customer never presented a card. */
  | "canceled"
  /** The reader read a card and it was refused. */
  | "declined"
  /** This device cannot do it: no entitlement, no hardware, not signed in. */
  | "unavailable"
  /** Anything else. The server is the one that decides what really happened. */
  | "failed";

const MAX_ID = 64;

/** Only this shape, from our own page, starts a collection. */
export function parseTapToPayMessage(raw: string): PageMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;

  if (m.type === "cb:tap-to-pay-token") {
    const { nonce, secret } = m;
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > MAX_ID) return null;
    if (secret !== null && typeof secret !== "string") return null;
    return { kind: "token", reply: { nonce, secret: secret === null ? null : secret } };
  }

  if (m.type === "cb:tap-to-pay-education") {
    const { requestId } = m;
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_ID) {
      return null;
    }
    return { kind: "education", requestId };
  }

  if (m.type !== "cb:tap-to-pay") return null;
  const { requestId, clientSecret, connectAccountId, locationId, amountCents } = m;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_ID) {
    return null;
  }
  // A client secret is the authority to collect against one intent; anything
  // that is not shaped like one is dropped rather than handed to the SDK.
  if (typeof clientSecret !== "string" || !/^pi_[A-Za-z0-9_]+_secret_[A-Za-z0-9_-]+$/.test(clientSecret)) {
    return null;
  }
  if (typeof connectAccountId !== "string" || !/^acct_[A-Za-z0-9]+$/.test(connectAccountId)) {
    return null;
  }
  if (typeof locationId !== "string" || !/^tml_[A-Za-z0-9]+$/.test(locationId)) return null;
  // Display only, but a nonsense figure means a nonsense message.
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
    return null;
  }
  return {
    kind: "collect",
    request: { requestId, clientSecret, connectAccountId, locationId, amountCents },
  };
}

/**
 * The JavaScript the shell injects to answer a collection.
 *
 * 🔴 The page must treat this as a HINT and re-read the server, never as the
 * record of what happened. The device knows what the SDK told it; only the
 * server knows what Stripe did. `collected` here means "ask the server now",
 * not "money received".
 */
export function resultScript(requestId: string, outcome: TapToPayOutcome, message?: string): string {
  const payload = JSON.stringify({ requestId, outcome, message: message ?? null });
  return `(function(){try{window.__cbTapToPay&&window.__cbTapToPay.resolve(${payload});}catch(e){}})();true;`;
}

/**
 * The shell's answer to an education request.
 *
 * 🔴 `failed` MUST reach the page, because on iOS 18+ Apple's overlay is the
 * requirement and a barber whose device could not show it has not been
 * educated. The page keeps Tap to Pay unavailable rather than proceeding, which
 * is the only honest reading of "the required education did not happen".
 */
export function educationResultScript(
  requestId: string,
  outcome: "native" | "fallback" | "already" | "failed",
  reason?: string,
): string {
  const payload = JSON.stringify({ requestId, outcome, reason: reason ?? null });
  return `(function(){try{window.__cbTapToPay&&window.__cbTapToPay.education(${payload});}catch(e){}})();true;`;
}

/** The JavaScript the shell injects when the SDK needs a connection token. */
export function tokenRequestScript(nonce: string): string {
  return `(function(){try{window.__cbTapToPay&&window.__cbTapToPay.provideToken(${JSON.stringify(
    nonce,
  )});}catch(e){}})();true;`;
}

/**
 * Announced to the page on load so the checkout screen knows a contactless
 * collection is possible HERE. Absent on the web, on Android, on an older
 * build, and on a build whose entitlement was never granted - in every one of
 * those the screen shows "Not set up on this device yet" rather than a button
 * that cannot work.
 */
export function capabilityScript(available: boolean): string {
  return `(function(){try{window.__cbNative=Object.assign(window.__cbNative||{},{tapToPay:${
    available ? "true" : "false"
  }});}catch(e){}})();true;`;
}
