import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { API_ORIGIN, STORAGE } from "./config";
import {
  base64ToBase64Url,
  bytesToBase64Url,
  callbackIsForThisAttempt,
  readCallbackParams,
} from "./joinFlow";
import { saveSession } from "./session";

/**
 * The runtime half of "Join your shop": generating the PKCE material, opening
 * the SYSTEM authentication browser, and trading the returned code for a
 * session. The decisions and their reasoning live in joinFlow.ts; this file is
 * the part that touches the device.
 *
 * WHY openAuthSessionAsync AND NOT A WEBVIEW. Three reasons, in order of how
 * badly each one bites:
 *  1. Google refuses OAuth inside an embedded WebView ("Access blocked"), so a
 *     WebView flow simply cannot offer Google sign-up.
 *  2. An embedded WebView is OUR process. The barber would be typing a password
 *     (or an Apple ID) into a window the app can read. ASWebAuthenticationSession
 *     is a separate process with the system's own cookie jar - we get back a
 *     callback URL and nothing else.
 *  3. It carries Safari's existing sign-in state, so a barber already signed
 *     into Google on their phone taps once instead of typing anything.
 */

/** The custom scheme that CLOSES the authentication session. See ReturnToApp. */
const RETURN_URL = "chairback://auth/callback";

/** Where a started attempt waits, so a cold start can still finish it. */
const ATTEMPT_KEY = "cb.joinAttempt";

/**
 * How long a started attempt stays redeemable on this device. Longer than the
 * server's two-minute code TTL on purpose: this is the window for FINISHING
 * signup (reading an email, picking a password), not for holding a credential.
 * The code itself is what expires quickly.
 */
const ATTEMPT_TTL_MS = 30 * 60 * 1000;

export interface JoinAttempt {
  state: string;
  verifier: string;
  challenge: string;
  startedAt: number;
}

/**
 * Start an attempt: a random state, a random PKCE verifier, and the verifier's
 * sha256 as the challenge.
 *
 * The verifier is the secret and it NEVER leaves the device - not in the start
 * URL, not in the callback. That is what makes the code in the callback URL
 * safe to hand to a browser: without this value it buys nothing.
 */
export async function createAttempt(): Promise<JoinAttempt> {
  const state = bytesToBase64Url(await Crypto.getRandomBytesAsync(32));
  const verifier = bytesToBase64Url(await Crypto.getRandomBytesAsync(32));
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  return {
    state,
    verifier,
    challenge: base64ToBase64Url(digest),
    startedAt: Date.now(),
  };
}

/**
 * Remember the attempt in the keychain (not AsyncStorage: the verifier is a
 * secret for as long as the flow is open) so the app can finish even if iOS
 * kills it while the browser sheet is up, or the barber finishes in ordinary
 * Safari and comes back through the universal link minutes later.
 */
export async function rememberAttempt(attempt: JoinAttempt): Promise<void> {
  try {
    await SecureStore.setItemAsync(ATTEMPT_KEY, JSON.stringify(attempt));
  } catch {
    // A device that can't write to the keychain can still complete the flow in
    // one go - the attempt is held in memory too. Only cold-start resumption
    // is lost, and that path just tells them to try again.
  }
}

/** The pending attempt, if there is one and it hasn't gone stale. */
export async function recallAttempt(): Promise<JoinAttempt | null> {
  try {
    const raw = await SecureStore.getItemAsync(ATTEMPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as JoinAttempt;
    if (
      typeof parsed?.state !== "string" ||
      typeof parsed?.verifier !== "string" ||
      typeof parsed?.startedAt !== "number" ||
      Date.now() - parsed.startedAt > ATTEMPT_TTL_MS
    ) {
      await forgetAttempt();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the attempt. Called on success, cancellation, and expiry alike. */
export async function forgetAttempt(): Promise<void> {
  await SecureStore.deleteItemAsync(ATTEMPT_KEY).catch(() => {});
}

export type JoinSessionResult =
  | { kind: "returned"; url: string }
  | { kind: "canceled" }
  | { kind: "failed" };

/**
 * Open the authentication browser and wait for it to hand back our callback.
 *
 * "cancel" and "dismiss" both mean the barber closed the sheet, and neither is
 * an error to apologize for - the screen just returns to its resting state.
 */
export async function openJoinSession(startUrl: string): Promise<JoinSessionResult> {
  try {
    const result = await WebBrowser.openAuthSessionAsync(startUrl, RETURN_URL, {
      // Keep the sheet's own cookie jar rather than a private one: the point is
      // to reuse the sign-in the phone already has.
      preferEphemeralSession: false,
    });
    if (result.type === "success" && result.url) {
      return { kind: "returned", url: result.url };
    }
    if (result.type === "cancel" || result.type === "dismiss") {
      return { kind: "canceled" };
    }
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

export type ExchangeResult =
  | { kind: "session"; token: string }
  | { kind: "expired" }
  | { kind: "offline" };

/**
 * Trade the one-time code for a session token.
 *
 * The API answers one generic failure for every reason a redeem can fail
 * (unknown, expired, already spent, wrong verifier), so this cannot and does
 * not try to explain WHICH - it separates only "that didn't work, start again"
 * from "we couldn't reach the server", because those need different buttons.
 */
export async function exchangeCode(input: {
  code: string;
  verifier: string;
  state: string;
}): Promise<ExchangeResult> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/auth/mobile/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        codeVerifier: input.verifier,
        state: input.state,
      }),
    });
    if (!res.ok) return { kind: "expired" };
    const { token } = (await res.json()) as { token?: string };
    return token ? { kind: "session", token } : { kind: "expired" };
  } catch {
    return { kind: "offline" };
  }
}

export type CompleteResult =
  | "joined"
  | "not_ours"
  | "expired"
  | "offline"
  | "no_attempt";

/**
 * Finish a flow from the URL we were handed back, wherever it arrived from:
 * the authentication sheet closing, or the https universal link opening the app
 * cold.
 *
 * Both entry points share this one function so the STATE CHECK can never be
 * implemented twice and drift. A callback whose state doesn't match the attempt
 * this device started is "not_ours" - not an error to show, because it isn't
 * about the person holding the phone. It means a replayed or foreign callback,
 * and the only correct response is to ignore it.
 */
export async function completeFromUrl(url: string): Promise<CompleteResult> {
  const params = readCallbackParams(url);
  if (!params) return "no_attempt";

  const attempt = await recallAttempt();
  if (!attempt) return "no_attempt";
  if (!callbackIsForThisAttempt(params, attempt.state)) return "not_ours";

  const exchanged = await exchangeCode({
    code: params.code,
    verifier: attempt.verifier,
    state: attempt.state,
  });
  if (exchanged.kind === "offline") return "offline";
  if (exchanged.kind === "expired") {
    // The code is spent or stale either way - a retry with the same attempt
    // cannot succeed, so don't leave it lying around looking redeemable.
    await forgetAttempt();
    return "expired";
  }

  await saveSession(exchanged.token);
  await forgetAttempt();
  // Remember which side of the app they belong to, so the next cold launch goes
  // straight to their calendar instead of the role picker.
  await AsyncStorage.setItem(STORAGE.mode, "barber").catch(() => {});
  // Warm the profile before we navigate. Not a gate: the token was just minted
  // by our own API, so a hiccup here is a network blip, not a bad session, and
  // /barber re-checks anyway.
  await fetch(`${API_ORIGIN}/api/auth/me`, {
    headers: { Authorization: `Bearer ${exchanged.token}` },
  }).catch(() => undefined);
  return "joined";
}
