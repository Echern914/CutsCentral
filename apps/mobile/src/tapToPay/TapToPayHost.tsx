import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import {
  StripeTerminalProvider,
  useStripeTerminal,
  type Reader,
} from "@stripe/stripe-terminal-react-native";
import { TokenRelay } from "./tokenRelay";
import { collectTapToPay, type TerminalLike } from "./collect";
import {
  capabilityScript,
  parseTapToPayMessage,
  resultScript,
  tokenRequestScript,
} from "./protocol";

/**
 * Wires the dashboard WebView to the Tap to Pay hardware.
 *
 * 🔴 UNPROVEN. Every line below that touches the SDK has been typechecked
 * against its published types and run by nobody: there is no entitlement on
 * this account yet, and a simulator cannot take a contactless payment. The
 * decisions are tested in `collect.test.ts` and `tokenRelay.test.ts` against
 * fakes; the hardware path is not, and the real-device script in
 * `docs/service-checkout.md` is the only thing that may be called proof.
 *
 * WHAT IT DOES. The page posts "collect this intent"; this drives the reader
 * and injects the outcome back. It never reports money to the server and never
 * decides an amount - see protocol.ts for why the page owns both.
 */

/** How long a single collection may run before we give the barber an answer. */
const COLLECT_TIMEOUT_MS = 90_000;

function TapToPayInner({
  inject,
  relay,
  children,
}: {
  inject: (js: string) => void;
  relay: TokenRelay;
  children: (api: { handleMessage: (raw: string) => boolean }) => ReactElement;
}): ReactElement {
  // Discovery reports through a callback rather than resolving the promise, so
  // the first batch of readers is handed to whoever is waiting for one.
  const waitingForReader = useRef<((r: Reader.Type | null) => void) | null>(null);
  const busy = useRef(false);
  const initialized = useRef(false);

  const {
    initialize,
    discoverReaders,
    connectReader,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
  } = useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      const resolve = waitingForReader.current;
      if (!resolve) return;
      waitingForReader.current = null;
      resolve(readers[0] ?? null);
    },
  });

  useEffect(() => {
    return () => relay.dispose();
  }, [relay]);

  const terminal = useMemo<TerminalLike>(
    () => ({
      async discoverTapToPayReader() {
        if (!initialized.current) {
          const init = await initialize();
          if (init.error) return { error: init.error.message };
          initialized.current = true;
        }
        const reader = await new Promise<Reader.Type | null>((resolve) => {
          waitingForReader.current = resolve;
          // If discovery itself refuses (no entitlement, unsupported device),
          // answer immediately rather than leaving the barber on a spinner.
          void discoverReaders({ discoveryMethod: "tapToPay" }).then((res) => {
            if (res.error && waitingForReader.current) {
              waitingForReader.current = null;
              resolve(null);
            }
          });
        });
        return reader ? { reader } : { error: "no Tap to Pay reader on this device" };
      },
      async connect({ reader, locationId, onBehalfOf }) {
        const res = await connectReader({
          discoveryMethod: "tapToPay",
          reader: reader as Reader.Type,
          locationId,
          onBehalfOf,
          // Stripe requires the connected account to have accepted the Tap to
          // Pay terms. Permitting acceptance here lets the barber do it on the
          // device the first time instead of being refused with nothing to do.
          tosAcceptancePermitted: true,
        });
        return res.error ? { error: res.error.message } : { ok: true };
      },
      async retrieve(clientSecret) {
        const res = await retrievePaymentIntent(clientSecret);
        return res.error || !res.paymentIntent
          ? { error: res.error?.message ?? "intent not found" }
          : { paymentIntent: res.paymentIntent };
      },
      async collect(paymentIntent) {
        const res = await collectPaymentMethod({
          paymentIntent: paymentIntent as Parameters<
            typeof collectPaymentMethod
          >[0]["paymentIntent"],
        });
        return res.error || !res.paymentIntent
          ? { error: res.error?.message ?? "collection failed", code: res.error?.code }
          : { paymentIntent: res.paymentIntent };
      },
      async confirm(paymentIntent) {
        const res = await confirmPaymentIntent({
          paymentIntent: paymentIntent as Parameters<
            typeof confirmPaymentIntent
          >[0]["paymentIntent"],
        });
        if (res.error || !res.paymentIntent) {
          return { error: res.error?.message ?? "confirmation failed", code: res.error?.code };
        }
        // 🔴 The SDK types `status` as possibly undefined. An intent that came
        // back without one is not a success - it is an answer we do not
        // understand, and the only safe reading of "I don't know" on a payment
        // is to let the server decide.
        const status = res.paymentIntent.status;
        return status
          ? { status: String(status) }
          : { error: "the reader returned no payment status" };
      },
    }),
    [initialize, discoverReaders, connectReader, retrievePaymentIntent, collectPaymentMethod, confirmPaymentIntent],
  );

  const handleMessage = useCallback(
    (raw: string): boolean => {
      const msg = parseTapToPayMessage(raw);
      if (!msg) return false;

      if (msg.kind === "token") {
        relay.settle(msg.reply.nonce, msg.reply.secret);
        return true;
      }

      const { requestId } = msg.request;
      // 🔴 ONE COLLECTION AT A TIME. The server already refuses a second live
      // attempt, but a second reader session on one device is its own mess -
      // and the barber would have no idea which tap belonged to which cut.
      if (busy.current) {
        inject(resultScript(requestId, "failed", "a collection is already running"));
        return true;
      }
      busy.current = true;

      // 🔴 ALWAYS ANSWERS. A promise that never settles leaves the checkout
      // screen waiting on a tap that will never be reported, with the attempt
      // still open on the server and every other method blocked behind it.
      const timeout = setTimeout(() => {
        if (!busy.current) return;
        busy.current = false;
        inject(resultScript(requestId, "failed", "the reader did not answer"));
      }, COLLECT_TIMEOUT_MS);

      void collectTapToPay(terminal, msg.request)
        .then((res) => {
          if (!busy.current) return;
          clearTimeout(timeout);
          busy.current = false;
          inject(resultScript(requestId, res.outcome, res.message));
        })
        .catch((err: unknown) => {
          if (!busy.current) return;
          clearTimeout(timeout);
          busy.current = false;
          inject(resultScript(requestId, "failed", err instanceof Error ? err.message : "unknown"));
        });
      return true;
    },
    [inject, relay, terminal],
  );

  return children({ handleMessage });
}

/**
 * Wraps the dashboard in the Terminal SDK provider.
 *
 * `announceScript` is injected into the page on load so the checkout screen
 * knows a contactless collection is possible HERE. On the web, on Android, in
 * an older build, or in a build whose entitlement was never granted, nothing is
 * announced and the screen reads "Not set up on this device yet".
 */
export function TapToPayHost({
  inject,
  children,
}: {
  inject: (js: string) => void;
  children: (api: { handleMessage: (raw: string) => boolean }) => ReactElement;
}): ReactElement {
  const relay = useMemo(() => new TokenRelay((nonce) => inject(tokenRequestScript(nonce))), [inject]);
  return (
    <StripeTerminalProvider tokenProvider={relay.request} logLevel="none">
      <TapToPayInner inject={inject} relay={relay}>
        {children}
      </TapToPayInner>
    </StripeTerminalProvider>
  );
}

export const announceScript = capabilityScript(true);
