/**
 * The shop name's rule, as the API states it (PATCH /api/shops/me:
 * name z.string().min(1).max(120)), worded for people. Shared by the editor
 * (which blocks Save before a doomed request) and the save action (which
 * rewords the API's own refusal), so both say the same thing.
 */
export const SHOP_NAME_MAX = 120;
export const SHOP_NAME_EMPTY = "Your shop needs a name.";
export const SHOP_NAME_TOO_LONG = "Keep the shop name under 120 characters.";

/** The message for a name the API would refuse, or null when it is fine. Checks the trimmed name: that is what saves. */
export function shopNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return SHOP_NAME_EMPTY;
  if (trimmed.length > SHOP_NAME_MAX) return SHOP_NAME_TOO_LONG;
  return null;
}
