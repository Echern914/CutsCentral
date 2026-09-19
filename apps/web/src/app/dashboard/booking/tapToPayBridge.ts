/**
 * The page half of the Tap to Pay bridge.
 *
 * The dashboard runs inside the iOS app's WebView. The shell announces
 * `window.__cbNative.tapToPay` before this page's scripts run, posts nothing
 * otherwise, and answers a collection by calling `window.__cbTapToPay.resolve`.
 *
 * 🔴 EVERYTHING HERE IS A HINT, NOT A RECORD. The device reports what its SDK
 * told it; only the server knows what Stripe did. A `collected` outcome means
 * "ask the server now" - the caller's next move is always the settle action.
 */

export type TapToPayOutcome =
  | "collected"
  | "canceled"
  | "declined"
  | "unavailable"
  | "failed";

export interface TapToPayResult {
  requestId: string;
  outcome: TapToPayOutcome;
  message: string | null;
}

interface NativeWindow {
  __cbNative?: { tapToPay?: boolean };
  __cbTapToPay?: {
    resolve: (r: TapToPayResult) => void;
    provideToken: (nonce: string) => void;
  };
  ReactNativeWebView?: { postMessage: (s: string) => void };
}

function w(): NativeWindow {
  return window as unknown as NativeWindow;
}

/**
 * Can THIS device collect contactlessly?
 *
 * False on the web, on Android, in an older build and in a build whose Apple
 * entitlement was never granted. The server's own `tapToPay.available` is the
 * other half - the flag, Connect and an account for the money - and the screen
 * needs both.
 */
export function nativeTapToPayAvailable(): boolean {
  try {
    return w().__cbNative?.tapToPay === true && typeof w().ReactNativeWebView?.postMessage === "function";
  } catch {
    // A sandboxed or cross-origin frame: treat as "cannot", never as "can".
    return false;
  }
}

/** How long we wait for the shell before telling the barber ourselves. */
const REPLY_TIMEOUT_MS = 120_000;

/**
 * Hand a minted PaymentIntent to the phone and wait for it to report back.
 *
 * `fetchToken` is called when the SDK needs a connection token: the shell has
 * no session, so the page fetches on its behalf. It may be called more than
 * once.
 *
 * 🔴 ALWAYS SETTLES. If the shell never answers, this resolves `failed` rather
 * than leaving the screen waiting: the attempt is open on the server, every
 * other method is blocked behind it, and a barber needs to be told to look at
 * it rather than left holding a phone.
 */
export function collectWithPhone(
  request: {
    requestId: string;
    clientSecret: string;
    connectAccountId: string;
    locationId: string;
    amountCents: number;
  },
  fetchToken: () => Promise<string | null>,
): Promise<TapToPayResult> {
  return new Promise<TapToPayResult>((resolve) => {
    const nativeWindow = w();
    let done = false;

    const finish = (r: TapToPayResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Leave nothing behind that a later, unrelated collection could hit.
      delete nativeWindow.__cbTapToPay;
      resolve(r);
    };

    const timer = setTimeout(
      () =>
        finish({
          requestId: request.requestId,
          outcome: "failed",
          message: "the phone did not answer",
        }),
      REPLY_TIMEOUT_MS,
    );

    nativeWindow.__cbTapToPay = {
      resolve: (r: TapToPayResult) => {
        // A reply for a press we are no longer waiting on is dropped: it can
        // only be a stale answer, and resolving on it would show the barber
        // the wrong cut's outcome.
        if (!r || r.requestId !== request.requestId) return;
        finish(r);
      },
      provideToken: (nonce: string) => {
        void fetchToken()
          .then((secret) => post({ type: "cb:tap-to-pay-token", nonce, secret: secret ?? null }))
          // The shell must hear something, or its SDK hangs with no error.
          .catch(() => post({ type: "cb:tap-to-pay-token", nonce, secret: null }));
      },
    };

    function post(msg: unknown): void {
      try {
        nativeWindow.ReactNativeWebView?.postMessage(JSON.stringify(msg));
      } catch {
        /* the shell went away; the timeout above is the backstop */
      }
    }

    post({ type: "cb:tap-to-pay", ...request });
  });
}
