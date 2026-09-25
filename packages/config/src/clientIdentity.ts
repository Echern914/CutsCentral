/**
 * "Can the shop tell this person apart?" - the one rule for a client who adds
 * THEMSELVES to a shop.
 *
 * 🔴 WHY. Drick: "people are only signing up with their first names and i
 * cant tell who is who". Three Mikes on the waitlist is three guesses. So any
 * form where a customer creates their own record (the waitlist, a group
 * booking, "Join shop" in the app) must carry a last name OR an Instagram
 * handle - at least one, either will do.
 *
 * Barber-created clients are NOT held to this: a quick add from the dashboard
 * often genuinely has a first name and nothing else, and the barber knows who
 * he meant. The rule lives here, not in any one route, because the web forms,
 * the app's Join screen and every API route that runs it must refuse exactly
 * the same things - a form looser than the server bounces the customer off an
 * error it could have caught, and a stricter one blocks people the server
 * would have taken.
 *
 * The public booking page does NOT run this rule: it has no Instagram field,
 * so it requires a last name on its own and holds it only to the
 * lastNameHasLetter floor (a lone initial still books there - refusing it with
 * no other way in would lock out a real one-letter surname).
 */

/** The sentence every surface shows when neither was given. */
export const TELL_APART_MESSAGE =
  "Add your last name or Instagram so the shop can tell you apart";

/** The sentence for a handle that cannot be an Instagram username. */
export const INVALID_INSTAGRAM_MESSAGE =
  "That doesn't look like an Instagram username. Use letters, numbers, dots and underscores.";

/** Instagram's own limit. */
export const INSTAGRAM_HANDLE_MAX = 30;

/** First path segments that are Instagram's pages, never a username. */
const INSTAGRAM_ROUTES = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "explore",
  "accounts",
  "direct",
  "about",
  "legal",
  "developer",
]);

/**
 * The floor every customer-typed last name must clear: at least one letter.
 * "." or "-" typed to get past a required field is not a name. The public
 * booking page applies this floor on its own (it has no Instagram way in, so it
 * cannot hold a stricter bar without locking out a real one-letter surname).
 */
export function lastNameHasLetter(s: string | null | undefined): boolean {
  return /\p{L}/u.test(s ?? "");
}

/**
 * A last name the shop can tell people apart by: two letters, or one letter
 * from a caseless script (Han, Hangul, Arabic...) where a single character is
 * a whole surname. "Isaiah C" - Drick's own example - does not clear it; "Ng",
 * "O'Neil" and "李" do. Anyone this refuses can give their Instagram instead.
 */
export function isMeaningfulLastName(s: string | null | undefined): boolean {
  const t = (s ?? "").trim();
  return (t.match(/\p{L}/gu) ?? []).length >= 2 || /\p{Lo}/u.test(t);
}

/**
 * Whatever the customer typed, as the bare username, or why it cannot be one.
 *
 * Forgiving about shape - `@Mike.Fades`, `mike.fades `, and a pasted
 * `https://www.instagram.com/mike.fades/?hl=en` all mean `mike.fades` - and
 * exact about the result: Instagram usernames are letters, digits, dots and
 * underscores, at most 30, case-insensitive (so stored lowercase). Blank is
 * `null`, which is not an error: the field is optional on its own.
 */
export function normalizeInstagramHandle(
  raw: string | null | undefined,
): { ok: true; handle: string | null } | { ok: false } {
  let s = (raw ?? "").trim();
  if (s === "") return { ok: true, handle: null };
  // A pasted link: the username is the first path segment after the domain -
  // except on Instagram's own routes. A story link and the /_u/ deep link put
  // the username second; a post, reel or video link carries no username at
  // all, and keeping its first segment would store "@p" or "@reel".
  const url = s.match(
    /^(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/([^/?#]*)(?:\/([^/?#]*))?/i,
  );
  if (url) {
    const first = (url[1] ?? "").toLowerCase();
    if (first === "stories" || first === "_u") s = url[2] ?? "";
    else if (INSTAGRAM_ROUTES.has(first)) return { ok: false };
    else s = url[1] ?? "";
  }
  s = s.replace(/^@+/, "").trim().toLowerCase();
  if (s === "") return { ok: false };
  if (s.length > INSTAGRAM_HANDLE_MAX || !/^[a-z0-9._]+$/.test(s)) return { ok: false };
  // Dots alone are not a person.
  if (!/[a-z0-9_]/.test(s)) return { ok: false };
  return { ok: true, handle: s };
}

/** The profile link for a stored (already normalized) handle. */
export function instagramUrl(handle: string): string {
  return `https://instagram.com/${encodeURIComponent(handle)}`;
}

export type TellApartCode = "NAME_OR_INSTAGRAM_REQUIRED" | "INVALID_INSTAGRAM";

export type TellApartResult =
  | { ok: true; lastName: string | null; instagram: string | null }
  | { ok: false; code: TellApartCode; message: string };

/**
 * The self-signup check: a meaningful last name (isMeaningfulLastName) or a
 * valid Instagram handle, at least one. Returns the cleaned values to store.
 * A handle that was typed but is not a handle is refused even when a last
 * name is present - silently dropping it would lose what the customer meant
 * to give the shop.
 */
export function checkTellApart(input: {
  lastName?: string | null;
  instagram?: string | null;
}): TellApartResult {
  // Punctuation is never stored as a surname; an initial is kept (it is what
  // the customer typed) but only counts alongside a handle.
  const typed = input.lastName?.trim() || null;
  const lastName = typed && lastNameHasLetter(typed) ? typed : null;
  const ig = normalizeInstagramHandle(input.instagram);
  if (!ig.ok) {
    return { ok: false, code: "INVALID_INSTAGRAM", message: INVALID_INSTAGRAM_MESSAGE };
  }
  if (!isMeaningfulLastName(lastName) && !ig.handle) {
    return { ok: false, code: "NAME_OR_INSTAGRAM_REQUIRED", message: TELL_APART_MESSAGE };
  }
  return { ok: true, lastName, instagram: ig.handle };
}

/** The API's refusal body, the same on every route: `error` is the stable code. */
export function tellApartRefusal(code: TellApartCode) {
  return code === "INVALID_INSTAGRAM"
    ? { error: "invalid_instagram", code, field: "instagram", message: INVALID_INSTAGRAM_MESSAGE }
    : { error: "name_or_instagram_required", code, field: "lastName", message: TELL_APART_MESSAGE };
}
