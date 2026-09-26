/**
 * What the Join screen says when the shop needs a last name or an Instagram
 * handle to tell this customer apart.
 *
 * The RULE is the server's (packages/config clientIdentity.ts, which this app
 * does not depend on), and so is the decision: a customer the shop already
 * knows is never asked, so the screen cannot pre-check a blank last name
 * without turning away someone the server would take. It sends what was typed
 * and says what the API answered. These sentences are the config's own, word
 * for word - joinDetails.test.ts holds the two side by side.
 */

export const TELL_APART_MESSAGE = "Add your last name or Instagram so the shop can tell you apart";

export const INVALID_INSTAGRAM_MESSAGE =
  "That doesn't look like an Instagram username. Use letters, numbers, dots and underscores.";

/** The sentence for the API's refusal code, or null when it is some other refusal. */
export function joinDetailsMessage(code: string | null): string | null {
  if (code === "name_or_instagram_required") return TELL_APART_MESSAGE;
  if (code === "invalid_instagram") return INVALID_INSTAGRAM_MESSAGE;
  return null;
}
