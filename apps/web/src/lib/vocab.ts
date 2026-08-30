import { NEUTRAL_VOCABULARY, type BusinessVocabulary } from "@chairback/config";
import { getMe } from "./me";

/**
 * The active shop's vocabulary, for server components.
 *
 * This is the seam every dashboard surface resolves its wording through. It
 * reads `getMe()`, which is already wrapped in React `cache()`, so calling it
 * from a layout AND three components in the same render costs one round trip and
 * cannot leak one shop's words into another's request.
 *
 * 🔴 No module-level memo. `cache()` is per-render on purpose; a module-scoped
 * cache in a multi-tenant server would hand the next request the previous
 * shop's nouns.
 *
 * Falls back to NEUTRAL whenever the answer is unknown - a signed-out render, a
 * user with no shop, a web deploy running ahead of the API, or a shop that has
 * not chosen a type. Never blanks, and never barbershop words by default.
 */
export async function getVocabulary(): Promise<BusinessVocabulary> {
  const me = await getMe();
  if (!me.ok) return NEUTRAL_VOCABULARY;
  return me.data.businessType?.vocabulary ?? NEUTRAL_VOCABULARY;
}

/**
 * Whether an authorized human has chosen the active shop's business type.
 *
 * false is the cue to offer the one-time picker. It is deliberately NOT a reason
 * to block anything: a shop that has not answered keeps booking, texting and
 * taking payments exactly as before, just in neutral words.
 */
export async function hasChosenBusinessType(): Promise<boolean> {
  const me = await getMe();
  return me.ok ? me.data.businessType?.selected === true : false;
}

/** Sentence-case a vocabulary word for the start of a heading ("chair" -> "Chair"). */
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * "a chair" / "an appointment" - the indefinite article for a vocabulary word.
 *
 * Vowel-initial is the right test here because every noun in the registry is a
 * plain English word; this is not a general-purpose inflector.
 */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}
