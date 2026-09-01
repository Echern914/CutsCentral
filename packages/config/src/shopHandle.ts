/**
 * Turning whatever a customer typed into the one handle it could mean.
 *
 * 🔴 FORGIVING ABOUT INPUT, EXACT ABOUT MATCHING. These are two different
 * things and conflating them is how a shop finder becomes a directory.
 *
 * Forgiving: someone hunting for their barber will type `drickcuttinup`, or
 * `@drickcuttinup`, or paste the whole link out of a text message, or capitalise
 * it because their phone did. All of those mean the same shop and all of them
 * resolve.
 *
 * Exact: `drick` is NOT `drickcuttinup`, and never resolves to it. No prefix
 * match, no contains, no fuzzy, no "did you mean", no listing. You can only
 * find a shop whose handle you already know, which is the same position you are
 * in holding a link — and it is the reason a customer cannot browse other
 * people's shops, or discover that a competitor exists, by typing letters.
 */

import { SLUG_REGEX } from "./constants.js";

/**
 * The handle a typed string refers to, or null if it cannot be one.
 *
 * Returning null for anything unusable means the caller never queries on
 * junk — and a caller that never queries cannot be timed to tell "no such
 * shop" apart from "not a handle".
 */
export function normalizeShopHandle(input: string): string | null {
  let value = input.trim();
  if (!value) return null;

  // A pasted link is the commonest "handle" a customer actually has, because
  // it is what the shop texted them. Take the last real path segment:
  // https://getchairback.com/s/drickcuttinup, /book/drickcuttinup, or a bare
  // getchairback.com/s/drickcuttinup with no scheme all end the same way.
  if (value.includes("/")) {
    const withoutQuery = value.split(/[?#]/)[0] ?? "";
    const segments = withoutQuery.split("/").filter(Boolean);
    // Drop a scheme's "https:" remnant and the host, keeping the last segment.
    value = segments[segments.length - 1] ?? "";
  }

  // Instagram habits: people write handles with an @ in front.
  value = value.replace(/^@+/, "");
  value = value.trim().toLowerCase();

  // 🔴 Validated against the SAME regex that governs what a slug may be, so
  // this can never ask the database about something no shop could be called.
  return SLUG_REGEX.test(value) ? value : null;
}
