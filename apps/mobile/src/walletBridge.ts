/**
 * The page -> shell bridge for "add this appointment to Apple Wallet". Pure,
 * so the rules are testable without a WebView or a real pass.
 *
 * WHY THIS EXISTS. On the web, Add to Apple Wallet is a plain navigation to a
 * .pkpass and Safari presents the add sheet. A WKWebView cannot do that, which
 * is why components/AddToWallet.tsx renders nothing inside the app. The
 * supported path in an app is PassKit's own PKAddPassesViewController
 * (modules/wallet-pass), and the page has no way to reach it - so the page
 * asks, and the shell does it.
 *
 * 🔴 THE PAGE SENDS A MANAGE TOKEN, NEVER A URL, and that is the whole design.
 * The obvious shape - `{type, url}` - makes a web page able to name any host it
 * likes and have the app fetch it. Taking only the token and building the URL
 * here means the ONLY thing a message can ever point at is this build's own web
 * origin, on the one path that streams a pass. A compromised or mistaken page
 * cannot widen that.
 *
 * It is also what binds a pass to ONE appointment: the token IS the
 * appointment, so a message naming appointment A can never produce the pass for
 * appointment B.
 */

export interface AddWalletPassRequest {
  /** The manage token, which names exactly one appointment. */
  manageToken: string;
  /** Absolute URL on OUR web origin that streams that appointment's .pkpass. */
  url: string;
}

/**
 * base64url, which is what `randomToken()` produces for every manage token.
 * The length bound is deliberately generous at both ends: it is a sanity check
 * on the shape of the thing, not a second implementation of the token format.
 */
const MANAGE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function parseAddWalletPassRequest(
  raw: string,
  origins: { webOrigin: string },
): AddWalletPassRequest | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "cb:add-wallet-pass") return null;
  const { manageToken } = m;
  if (typeof manageToken !== "string") return null;
  if (!MANAGE_TOKEN.test(manageToken)) return null;
  return {
    manageToken,
    // Built here, from this build's own origin. Nothing in the message
    // contributes to the host or the path - only to the one token segment,
    // which has already been constrained to a charset with no "/", "?" or ":".
    url: passUrl(origins.webOrigin, manageToken),
  };
}

/** The one URL shape the app ever hands PassKit: OUR origin, the pass path. */
function passUrl(webOrigin: string, manageToken: string): string {
  return `${webOrigin}/book/manage/${manageToken}/wallet-pass`;
}

/**
 * The details screen's path to the same pass. There is no web page here: the
 * screen asks the API (GET /api/me/appointments/:id/wallet-pass, which checks
 * the appointment is this customer's own, BOOKED and ahead) and gets back the
 * URL that streams it.
 *
 * 🔴 THE SAME RULE AS THE PAGE BRIDGE, applied to the API's answer: the URL is
 * accepted only in the exact shape this build would have built itself, on its
 * own web origin, and is then REBUILT from the token rather than passed on. A
 * wrong or tampered reply makes PassKit fetch nothing, never some other host.
 */
export function walletPassUrlFromApi(
  url: unknown,
  origins: { webOrigin: string },
): string | null {
  if (typeof url !== "string") return null;
  const prefix = `${origins.webOrigin}/book/manage/`;
  const suffix = "/wallet-pass";
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) return null;
  const manageToken = url.slice(prefix.length, url.length - suffix.length);
  if (!MANAGE_TOKEN.test(manageToken)) return null;
  return passUrl(origins.webOrigin, manageToken);
}

/**
 * Whether the details screen draws "Add to Apple Wallet". Every condition is a
 * different reason the tap could not work, and the badge appears only when
 * none of them applies - a badge that does nothing is worse than no badge:
 *
 *  - `offered`: the API says THIS appointment can have a pass (the server can
 *    sign one, and it is a BOOKED ChairBack booking still ahead - whoever made
 *    it). Absent on an older API = false.
 *  - iOS only: Wallet is Apple's. (No Google Wallet pass exists to offer.)
 *  - `nativeCanAdd`: the app has the PassKit half (builds before it do not) and
 *    the device can hold passes (some managed phones cannot).
 */
export function showAddToWallet(input: {
  offered: boolean | undefined;
  platform: string;
  nativeCanAdd: boolean;
}): boolean {
  return input.offered === true && input.platform === "ios" && input.nativeCanAdd;
}
