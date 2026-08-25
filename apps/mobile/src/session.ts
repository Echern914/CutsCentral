import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import {
  clearSession as clearIn,
  loadSession as loadFrom,
  saveSession as saveIn,
  type SessionBackends,
} from "./sessionStore";

/**
 * The concrete wiring for sessionStore.ts: keychain first, AsyncStorage as the
 * migration source and the fallback. All of the reasoning lives there; this
 * file only adapts two SDK shapes to one interface.
 *
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY is the deliberate choice for accessibility:
 * the token must not ride an iCloud keychain backup onto a second device, and
 * nothing here needs to be readable while the phone is locked (every use is a
 * foreground action by the barber).
 */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const backends: SessionBackends = {
  secure: {
    getItem: (key) => SecureStore.getItemAsync(key, SECURE_OPTIONS),
    setItem: (key, value) => SecureStore.setItemAsync(key, value, SECURE_OPTIONS),
    deleteItem: (key) => SecureStore.deleteItemAsync(key, SECURE_OPTIONS),
  },
  legacy: {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    deleteItem: (key) => AsyncStorage.removeItem(key),
  },
};

/** The stored session token, migrated out of AsyncStorage if needed. */
export function loadSession(): Promise<string | null> {
  return loadFrom(backends);
}

/** Persist a session token to the keychain. */
export function saveSession(token: string): Promise<void> {
  return saveIn(backends, token);
}

/** Remove the session from every store on the device. */
export function clearSession(): Promise<void> {
  return clearIn(backends);
}
