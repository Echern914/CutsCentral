import { apiEnv, decryptWithAny, encrypt } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * THE AT-REST KEY, AND HOW IT IS CHANGED WITHOUT LOSING WHAT IT SEALED.
 *
 * `TOKEN_ENCRYPTION_KEY` seals the Acuity and Square OAuth tokens (and a few
 * short-lived rows), and is the root several purpose-tagged HMACs are derived
 * from - most importantly `claimDigest`, the stored proof that links a My
 * ChairBack account to a record it claimed. Swapping the key outright would
 * therefore disconnect every Acuity and Square shop (their tokens no longer
 * open) AND detach every claimed record at the customer's next read (its
 * digest no longer matches). That made a leaked key impossible to retire.
 *
 * So rotation is two variables, set together:
 *
 *   TOKEN_ENCRYPTION_KEY           = the NEW key  (everything is sealed with it)
 *   TOKEN_ENCRYPTION_KEY_PREVIOUS  = the OLD key  (only ever used to OPEN)
 *
 * Reads try the new key, then the old. At boot, engines/tokenRekey.ts reseals
 * every stored token and recomputes every claim digest under the new key, and
 * logs when nothing is left on the old one - which is when PREVIOUS can be
 * removed. docs/runbook/secret-rotation.md has the operator's steps.
 *
 * 🔴 A MALFORMED PREVIOUS KEY IS IGNORED, NOT A BOOT FAILURE. It is set at the
 * one moment the platform is already mid-change, and a guard that refuses to
 * boot then takes down every shop to protect the few with an integration (the
 * UNSUBSCRIBE_TOKEN_SECRET outage, env.ts). It is named loudly in the log
 * instead, and the boot re-key reports every row it could not open.
 */

export interface TokenKeys {
  current: string;
  previous: string | null;
}

let warnedAboutPrevious = false;

function decodes32(keyB64: string): boolean {
  return Buffer.from(keyB64, "base64").length === 32;
}

export function tokenKeys(): TokenKeys {
  const env = apiEnv();
  const current = env.TOKEN_ENCRYPTION_KEY;
  const previous = env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (!previous || previous === current) return { current, previous: null };
  if (!decodes32(previous)) {
    if (!warnedAboutPrevious) {
      warnedAboutPrevious = true;
      logger.error(
        { reason: "token_encryption_key_previous_malformed" },
        "TOKEN_ENCRYPTION_KEY_PREVIOUS does not decode to 32 bytes (base64), so it is being IGNORED - anything sealed under the old key will not open. Paste the old TOKEN_ENCRYPTION_KEY value exactly.",
      );
    }
    return { current, previous: null };
  }
  return { current, previous };
}

/** Every key that may open a sealed value, newest first. */
export function openingKeys(): string[] {
  const { current, previous } = tokenKeys();
  return previous ? [current, previous] : [current];
}

/** Seal a secret for storage. Always the current key. */
export function sealToken(plaintext: string): string {
  return encrypt(plaintext, tokenKeys().current);
}

/** Open a stored secret sealed under the current key or the previous one. */
export function openToken(sealed: string): string {
  return decryptWithAny(sealed, openingKeys()).plaintext;
}

/** Open, and say whether the value is still on the previous key. */
export function openTokenNoting(sealed: string): { plaintext: string; stale: boolean } {
  const { plaintext, keyIndex } = decryptWithAny(sealed, openingKeys());
  return { plaintext, stale: keyIndex > 0 };
}

/**
 * The purpose-tagged derivations of each opening key, newest first. A digest
 * WRITTEN uses the first; a digest CHECKED may match any.
 */
export function purposeKeys(purpose: string): string[] {
  return openingKeys().map((k) => `${k}:${purpose}`);
}
