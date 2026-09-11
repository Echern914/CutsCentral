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
 *
 * What counts as "knowing it" is the part that was wrong. A customer holding
 * nothing but the shop's NAME knows it exactly - that name is what minted the
 * handle - and typing it used to fail, because a space is not a dash. It now
 * goes through the same transform that created the handle, and separators are
 * compared loosely (see shopHandleKey), so where the spaces fall no longer
 * decides whether someone finds their barber. None of that weakens the rule
 * above: every letter is still required, in order.
 */

import { SLUG_REGEX } from "./constants.js";

/**
 * The handle a NAME becomes. The one definition, used both when a shop is
 * created and when somebody types its name looking for it.
 *
 * 🔴 IT HAS TO BE SHARED, AND IT WAS NOT. Shop creation turned "United
 * Barbershop" into `united-barbershop`; the finder lowercased what was typed
 * and then validated it against SLUG_REGEX, which rejects a space outright. So
 * the one string guaranteed to be right - the shop's own name, exactly as it
 * prints it on its door - was the one string that could never resolve. Every
 * shop on the platform was unfindable by name: "United Barbershop" 404'd while
 * `united-barbershop` worked.
 *
 * Accents fold to ASCII rather than becoming separators, so "Beauté" reads as
 * `beaute` and not `beaut`.
 */
export function shopSlugFromName(name: string): string {
  return (
    name
      .normalize("NFD")
      // Strip combining marks: é -> e, ñ -> n. Done BEFORE the collapse below,
      // or the mark itself becomes a dash and eats the letter it sat on.
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

/**
 * The same handle with every separator removed - `united-barbershop` and
 * `unitedbarbershop` share one key.
 *
 * 🔴 THIS IS STILL EXACT MATCHING. Every letter, in order, is required; the
 * only thing forgiven is WHERE THE SPACES GO, which nobody remembers and which
 * the shop itself is inconsistent about ("FadesByMikey Barbershop" is one
 * word then two). It buys no prefix, no contains, and no enumeration: knowing
 * `unitedbarbershop` is knowing `united-barbershop`.
 */
export function shopHandleKey(handle: string): string {
  return handle.replace(/-/g, "");
}

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

  // 🔴 THE SAME TRANSFORM THAT MINTED THE HANDLE IN THE FIRST PLACE. A name,
  // a handle, and a name with the spaces in odd places are the same knowledge
  // wearing different clothes - "United Barbershop", "united barbershop" and
  // `united-barbershop` all mean the one shop, and before this they did not
  // all resolve. Still exact: nothing here shortens, guesses or completes.
  value = shopSlugFromName(value);

  // 🔴 Validated against the SAME regex that governs what a slug may be, so
  // this can never ask the database about something no shop could be called.
  return SLUG_REGEX.test(value) ? value : null;
}
