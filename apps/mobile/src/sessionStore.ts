/**
 * Where the barber's session token lives on the device, and how it got there.
 *
 * IT USED TO LIVE IN ASYNCSTORAGE, which on iOS is an unencrypted file in the
 * app container and on Android an unencrypted SQLite row. That was acceptable
 * when the only way to get a token was to type a password into this app. It is
 * less acceptable now that "Join your shop" mints one automatically at the end
 * of a browser flow, and it was never right for a 30-day credential to a
 * business's calendar and client list.
 *
 * So the token moves to the keychain (expo-secure-store). Three things make
 * that safe to do to an app that is already installed on people's phones:
 *
 *  1. MIGRATION, not a reset. On first read we look in the keychain, and if
 *     it's empty we look in the old place, copy what we find, and delete the
 *     original. Nobody is signed out by upgrading.
 *  2. FALLBACK, not a crash. SecureStore can genuinely fail - a device with no
 *     passcode on older iOS, an Android keystore that has lost its keys after a
 *     restore. If it does, we keep working out of AsyncStorage rather than
 *     locking the barber out of their own calendar. Less secure than we wanted
 *     beats unusable.
 *  3. It is all in these pure functions, so the behavior above is TESTED rather
 *     than asserted - the concrete backends are wired up in session.ts.
 */

/** The minimum of a key/value store, which both backends already satisfy. */
export interface TokenBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface SessionBackends {
  /** The keychain. May throw or be unavailable; every call site tolerates it. */
  secure: TokenBackend;
  /** AsyncStorage: the pre-keychain home, kept as migration source + fallback. */
  legacy: TokenBackend;
}

/** Key used in BOTH stores, so a migration is a move, not a rename. */
export const SESSION_KEY = "cb.session";

async function tryGet(backend: TokenBackend, key: string): Promise<string | null> {
  try {
    return await backend.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The current session token, migrating it out of the old store on the way if
 * that is where it still is.
 *
 * The migration deliberately deletes the legacy copy only AFTER the secure
 * write succeeds. If the process dies between the two, the worst case is a
 * duplicate - not a barber signed out with their token gone.
 */
export async function loadSession(
  backends: SessionBackends,
): Promise<string | null> {
  const secure = await tryGet(backends.secure, SESSION_KEY);
  if (secure) return secure;

  const legacy = await tryGet(backends.legacy, SESSION_KEY);
  if (!legacy) return null;

  try {
    await backends.secure.setItem(SESSION_KEY, legacy);
    await backends.legacy.deleteItem(SESSION_KEY).catch(() => {});
  } catch {
    // Keychain unavailable on this device: leave the legacy copy exactly where
    // it is, since it is now the only copy.
  }
  return legacy;
}

/**
 * Store a freshly minted session.
 *
 * On success the legacy copy is cleared, so an upgraded device stops carrying a
 * plaintext duplicate of a live credential. If the keychain write fails we fall
 * back to the old store rather than losing the sign-in.
 */
export async function saveSession(
  backends: SessionBackends,
  token: string,
): Promise<void> {
  try {
    await backends.secure.setItem(SESSION_KEY, token);
    await backends.legacy.deleteItem(SESSION_KEY).catch(() => {});
  } catch {
    await backends.legacy.setItem(SESSION_KEY, token);
  }
}

/**
 * Sign out. BOTH stores are cleared unconditionally, including when one throws:
 * a "sign out" that leaves a usable token behind on a shared or sold phone is
 * the one failure here that actually matters.
 */
export async function clearSession(backends: SessionBackends): Promise<void> {
  await backends.secure.deleteItem(SESSION_KEY).catch(() => {});
  await backends.legacy.deleteItem(SESSION_KEY).catch(() => {});
}
