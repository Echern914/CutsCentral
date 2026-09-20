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
    url: `${origins.webOrigin}/book/manage/${manageToken}/wallet-pass`,
  };
}
