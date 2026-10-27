/**
 * Which version of the Terms of Service and Privacy Policy a person agreed to.
 *
 * ONE key for both documents: they are revised and published together (see
 * PRIVACY_TERMS_UPDATED_DATE in apps/web/src/components/legal/Legal.tsx), and
 * the signup checkbox asks for both in one tick. The key is the "Last updated"
 * date of the revision, as YYYY-MM-DD.
 *
 * Bumping this asks EVERY signed-in barber to agree again, once, before the
 * dashboard opens (the "Before you continue" screen). Bump it only for a
 * revision people should re-accept, and move the web's "Last updated" date in
 * the same change.
 *
 * The API stamps User.termsAcceptedVersion / CustomerAccount.termsAcceptedVersion
 * with this value, and decides whether the gate shows; the web never compares
 * versions itself, so a web deploy ahead of the API cannot loop the gate.
 */
export const TERMS_VERSION = "2026-10-27";

/**
 * Must this person agree (again) before continuing? True when they have never
 * agreed, or agreed to any version other than the current one. A stored
 * version NEWER than ours (an API rolled back after a bump) also asks again:
 * we can only vouch for the text we are serving.
 */
export function termsAcceptanceRequired(
  acceptedVersion: string | null | undefined,
  currentVersion: string = TERMS_VERSION,
): boolean {
  return acceptedVersion !== currentVersion;
}
