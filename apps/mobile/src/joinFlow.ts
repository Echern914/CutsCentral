/**
 * The decisions behind "Join your shop", kept free of react-native imports so
 * they can be tested properly (see vitest.config.ts - screens stay thin wiring
 * over modules like this one).
 *
 * THE FLOW, in one place, because it crosses three processes:
 *
 *   app  ──1──> system authentication browser ──2──> web (signup + invitation)
 *                                                      │
 *   app  <──4── chairback://auth/callback  <──3────────┘  (one-time code)
 *
 *   1. the app makes a random `state` and a PKCE verifier, and opens
 *      /auth/mobile/start with the state + the verifier's sha256;
 *   2. the barber creates or signs into their account and accepts the
 *      invitation, entirely on the web;
 *   3. the web mints a two-minute, single-use code bound to that state and
 *      challenge, and sends the browser back to us with it;
 *   4. the app checks the state came back unchanged, then trades code +
 *      verifier for a session.
 *
 * The verifier never leaves the app, so a code intercepted anywhere in that
 * chain is worthless. The state is what makes a REPLAYED callback worthless -
 * it must match the attempt this app instance actually started.
 */

/**
 * An invitation token as `randomToken()` mints it: base64url, 32 bytes, so 43
 * characters. The bounds are loose around that so a future change of size
 * doesn't silently reject real invitations, but the CHARACTER SET is exact -
 * anything else is not a token and should not be sent anywhere.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * Pull the invitation token out of whatever the barber pasted.
 *
 * They will paste the whole link from their email far more often than the code
 * alone, and on a phone that link may arrive with a trailing space, a
 * "smart"-quoted wrapper, or as the chairback:// form if they long-pressed it
 * in the app. All of those are the same intent. Anything we cannot read as a
 * token returns null rather than being passed along hopefully - a malformed
 * value would otherwise travel all the way to a 410 that reads like a revoked
 * invitation.
 */
export function inviteTokenFrom(input: string): string | null {
  const trimmed = input.trim().replace(/^[<"'\s]+|[>"'\s.]+$/g, "");
  if (!trimmed) return null;

  // A bare token.
  if (TOKEN_SHAPE.test(trimmed)) return trimmed;

  // A link, in any of the shapes a phone produces.
  const query = trimmed.indexOf("?");
  if (query === -1) return null;
  const params = new URLSearchParams(trimmed.slice(query + 1));
  const token = params.get("token");
  return token && TOKEN_SHAPE.test(token) ? token : null;
}

/**
 * The URL the system authentication browser opens.
 *
 * `next` is the invitation itself: the web start route parks it, and every leg
 * after it (a password signup, a Google round trip, an Apple round trip) comes
 * back to it. Without that the barber creates an account and lands in the
 * shop-creation wizard, which is the exact bug this flow exists to end.
 */
export function buildJoinStartUrl(input: {
  webOrigin: string;
  token: string;
  state: string;
  codeChallenge: string;
}): string {
  return buildStartUrl({
    webOrigin: input.webOrigin,
    state: input.state,
    codeChallenge: input.codeChallenge,
    next: `/team/join?token=${encodeURIComponent(input.token)}`,
  });
}

/**
 * The URL for a NEW OWNER creating an account and a shop.
 *
 * Same three-legged flow as an invitation, aimed at `/onboarding` instead: the
 * web start route sends someone with no account to the signup form, whose own
 * default destination is already the shop-creation wizard, and parks
 * `/onboarding` so a Google or Apple round trip in the middle comes back to it.
 *
 * The code is minted only once the SHOP exists, not at signup. A session handed
 * back before then would drop the owner into shop creation inside the app
 * shell, which is the business registration Guideline 3.1.1 keeps out of it -
 * and the reason account creation happens in this browser at all.
 */
export function buildSignupStartUrl(input: {
  webOrigin: string;
  state: string;
  codeChallenge: string;
}): string {
  return buildStartUrl({ ...input, next: "/onboarding" });
}

function buildStartUrl(input: {
  webOrigin: string;
  state: string;
  codeChallenge: string;
  next: string;
}): string {
  const q = new URLSearchParams({
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    next: input.next,
  });
  return `${input.webOrigin}/auth/mobile/start?${q.toString()}`;
}

export interface CallbackParams {
  code: string;
  state: string;
}

/**
 * Read the code and state off the URL we were handed back, whether that came
 * from the authentication session closing (chairback://auth/callback) or from
 * the https universal link (a browser tab the barber finished in).
 *
 * Hand-parsed rather than fed to `new URL()`: React Native's URL polyfill has
 * historically been shaky on custom schemes, and this has to work for both
 * shapes.
 */
export function readCallbackParams(url: string): CallbackParams | null {
  const query = url.indexOf("?");
  if (query === -1) return null;
  const params = new URLSearchParams(url.slice(query + 1));
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return null;
  return { code, state };
}

/**
 * Does this callback belong to the attempt we started?
 *
 * The state is compared against the one THIS app instance generated. A callback
 * that fails this check is not an error to report and retry - it is a callback
 * for someone else's flow (a replay, a stale link tapped later, another app
 * poking our custom scheme), and the right response is to ignore it.
 */
export function callbackIsForThisAttempt(
  returned: CallbackParams,
  expectedState: string | null,
): boolean {
  return Boolean(expectedState) && returned.state === expectedState;
}

/** base64 (as expo-crypto returns a digest) to the base64url PKCE requires. */
export function base64ToBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random bytes to a base64url string, for the verifier and the state. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // btoa exists in the RN runtime (and in node 16+), and the input is
  // latin1-safe by construction above.
  return base64ToBase64Url(btoa(binary));
}
