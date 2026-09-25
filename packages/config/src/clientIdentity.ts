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
 * the app's Join screen and every public API route must refuse exactly the
 * same things - a form looser than the server bounces the customer off an
 * error it could have caught, and a stricter one blocks people the server
 * would have taken.
 */

/** The sentence every surface shows when neither was given. */
export const TELL_APART_MESSAGE =
  "Add your last name or Instagram so the shop can tell you apart";

/** The sentence for a handle that cannot be an Instagram username. */
export const INVALID_INSTAGRAM_MESSAGE =
  "That doesn't look like an Instagram username. Use letters, numbers, dots and underscores.";

/** Instagram's own limit. */
export const INSTAGRAM_HANDLE_MAX = 30;

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
  // A pasted profile link: keep the first path segment after the domain.
  const url = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/([^/?#]*)/i);
  if (url) s = url[1] ?? "";
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
 * The self-signup check: a last name or a valid Instagram handle, at least
 * one. Returns the cleaned values to store. A handle that was typed but is
 * not a handle is refused even when a last name is present - silently
 * dropping it would lose what the customer meant to give the shop.
 */
export function checkTellApart(input: {
  lastName?: string | null;
  instagram?: string | null;
}): TellApartResult {
  const lastName = input.lastName?.trim() || null;
  const ig = normalizeInstagramHandle(input.instagram);
  if (!ig.ok) {
    return { ok: false, code: "INVALID_INSTAGRAM", message: INVALID_INSTAGRAM_MESSAGE };
  }
  if (!lastName && !ig.handle) {
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
