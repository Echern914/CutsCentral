/**
 * THE ONE PLACE A CONTACT HANDOFF IS BUILT — `tel:`, `sms:`, `mailto:`.
 *
 * Tapping one of these hands the device off to another app: Phone, Messages,
 * Mail. ChairBack sends NOTHING. That distinction is the whole reason this
 * module exists and it decides every rule below:
 *
 *   - The scheme is never an input. Callers pass a phone or an email and get
 *     back a URI or null; there is no code path that puts a caller-supplied
 *     string in front of the colon. A stored value that turned out to be
 *     `javascript:alert(1)` yields null here, not a scheme we hand to iOS.
 *   - A value we cannot dial is null, never a best-effort string. A `tel:`
 *     built from "call me!!" is a button that fails in the barber's hand;
 *     the caller is expected to hide or disable the action instead.
 *
 * 🔴 NORMALISING IS NOT REFORMATTING. `normalizePhone` exists to make a
 * DIALABLE string; what the barber READS stays exactly as it was stored. The
 * sheet shows "(845) 555-1212" and links "+18455551212" — never the reverse.
 */

/**
 * The characters a phone number may be WRITTEN with: digits, the punctuation
 * people separate groups with, and one leading "+".
 *
 * 🔴 THIS IS TESTED BEFORE ANYTHING IS STRIPPED, and that is the whole point.
 * Strip first and "abc8455551212" and "8455551212hello" each leave ten clean
 * digits behind — so junk, a name, or an extension silently becomes a number
 * we would hand to the dialer. A value with a letter in it is not a phone
 * number we got slightly wrong; it is not a phone number.
 */
const DIALABLE = /^\+?[\s0-9().-]+$/;

/**
 * A stored phone in any of the shapes a barber, an import or Acuity produces,
 * turned into the E.164 string a device will dial:
 *
 *   "(845) 555-1212"    -> "+18455551212"
 *   "845-555-1212"      -> "+18455551212"
 *   "+1 845 555 1212"   -> "+18455551212"
 *   "+44 20 7123 4567"  -> "+442071234567"
 *
 * Spaces, parentheses, periods and hyphens are how people write numbers, so
 * they are all accepted. Letters are not — see DIALABLE.
 *
 * US is the default country because that is the only market ChairBack sells
 * in; anything already carrying "+" is trusted to name its own country and is
 * only length-checked against E.164 (max 15 digits, and a plausible floor of
 * 8 so a typo'd fragment is refused rather than dialed).
 *
 * Everything else — an extension, a 7-digit local number, a note someone typed
 * into the phone field, anything carrying a letter — returns null. We would
 * rather the action disappear than dial a stranger.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!DIALABLE.test(value)) return null;
  const plus = value.startsWith("+");
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * A single address, conservatively validated. Deliberately stricter than the
 * RFC: no quoted local parts, no spaces, and no CR/LF — a newline in a
 * `mailto:` is header injection, which is how a "contact" link becomes a way
 * to bcc someone.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.length > 254) return null;
  if (/[\s<>(),;:"\[\]]/.test(value)) return null;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(value) ? value : null;
}

/** `tel:+15551234567`, or null when there is nothing dialable. */
export function telUri(phone: string | null | undefined): string | null {
  const e164 = normalizePhone(phone);
  return e164 ? `tel:${e164}` : null;
}

/**
 * `sms:+15551234567`, or null when there is nothing textable.
 *
 * 🔴 NO BODY, EVER — and no `smsto:`/`imessage:` special-casing. An empty
 * compose is the point: iOS decides for itself whether that thread is iMessage
 * or SMS, and the barber writes their own words. A prefilled body is a message
 * ChairBack put in someone's mouth.
 */
export function smsUri(phone: string | null | undefined): string | null {
  const e164 = normalizePhone(phone);
  return e164 ? `sms:${e164}` : null;
}

/**
 * `mailto:someone@example.com`, or null when there is nothing to mail.
 *
 * Percent-encoded, then the "@" put back: encodeURIComponent is what stops a
 * "?" or "&" in an address from being read as the start of mailto headers, and
 * "@" is the one character it escapes that every mail client expects raw.
 */
export function mailtoUri(email: string | null | undefined): string | null {
  const address = normalizeEmail(email);
  return address ? `mailto:${encodeURIComponent(address).replace(/%40/g, "@")}` : null;
}

/**
 * Put text on the clipboard, with a fallback for the places
 * `navigator.clipboard` is missing or refused — an insecure origin, an older
 * WKWebView, a browser that gates it behind a permission the user denied.
 *
 * Returns whether it worked so the caller can say something true; it never
 * throws, because a copy that failed is a toast, not a crash.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path rather than giving up on the first no.
  }
  // 🔴 THE SCRATCH NODE IS REMOVED IN `finally`, NOT ON THE WAY OUT.
  // `select`, `setSelectionRange` and `execCommand` can all throw — a
  // sandboxed frame, a clipboard permission the browser denies, a WebView that
  // implements none of it. Removing the node only on the success path leaves an
  // invisible textarea in the document after every failure, one per attempt,
  // each still holding the phone number it was asked to copy.
  let el: HTMLTextAreaElement | null = null;
  try {
    el = document.createElement("textarea");
    el.value = value;
    // Off-screen but focusable: execCommand copies the SELECTION, so the node
    // has to be in the document and selectable. `readOnly` stops iOS opening
    // the keyboard on the way past.
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-1000px";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // Safe whether or not it ever made it into the document.
    el?.remove();
  }
}
