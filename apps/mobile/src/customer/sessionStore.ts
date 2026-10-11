import * as SecureStore from "expo-secure-store";
import type { KeyValue } from "./deviceRelease";

/**
 * The My ChairBack session, in the KEYCHAIN.
 *
 * AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: never rides an iCloud keychain backup
 * onto another phone, and still readable when the app is woken in the
 * background after the phone has been unlocked once (a notification tap on a
 * locked screen must not look like a sign-out). The business session uses the
 * stricter WHEN_UNLOCKED because every barber action is a foreground one.
 *
 * Every call swallows a keychain failure into "no session": the worst case is
 * being asked to sign in again, never a crash or a hung launch.
 */

const KEY = "cb.customerSession";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function loadCustomerSession(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY, OPTIONS);
  } catch {
    return null;
  }
}

export async function saveCustomerSession(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, token, OPTIONS);
  } catch {
    /* the session still works for this launch; the next one asks again */
  }
}

export async function clearCustomerSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    /* nothing stored, or nothing we can do */
  }
}

/** One keychain value, failures swallowed like the session's. */
function keychainValue(key: string): KeyValue {
  return {
    async get() {
      try {
        return await SecureStore.getItemAsync(key, OPTIONS);
      } catch {
        return null;
      }
    },
    async set(value) {
      try {
        await SecureStore.setItemAsync(key, value, OPTIONS);
      } catch {
        /* best-effort, as every push step is */
      }
    },
    async clear() {
      try {
        await SecureStore.deleteItemAsync(key, OPTIONS);
      } catch {
        /* nothing stored */
      }
    },
  };
}

/**
 * What this phone remembers about its push registration across launches (see
 * deviceRelease.ts). In the keychain because a pending removal carries the
 * account's session token.
 */
export const pushDeviceMemory = {
  device: keychainValue("cb.customerPushDevice"),
  pending: keychainValue("cb.customerPushRelease"),
};
