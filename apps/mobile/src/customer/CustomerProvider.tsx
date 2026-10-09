import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "expo-router";
import { API_ORIGIN, STORAGE } from "@/src/config";
import { getExpoPushToken } from "@/src/push";
import { ApiError, createApiClient, type ApiClient } from "./api";
import { clearCustomerSession, loadCustomerSession, saveCustomerSession } from "./sessionStore";
import { createDeviceRegistrar, type DeviceRegistrar } from "./deviceRegistration";

/**
 * Who is signed in to My ChairBack, and the API client that speaks for them.
 *
 * `status` drives the gate in app/customer/_layout.tsx: "loading" while the
 * keychain answers (a quiet screen, never a spinner that can hang), then
 * "signedIn" or "signedOut". A 401 from ANY call signs the customer out on the
 * spot - an expired or deleted session must land on sign-in, not on a screen
 * that can only fail.
 *
 * A demo session is held in memory only: a relaunch returns to the real sign-in
 * screen, and it never registers the phone for push.
 */

type Status = "loading" | "signedOut" | "signedIn";

interface CustomerContext {
  status: Status;
  isDemo: boolean;
  api: ApiClient;
  signIn: (token: string, opts?: { demo?: boolean }) => Promise<void>;
  signOut: () => Promise<void>;
  /** The push token this phone registered, so sign-out can unregister it. */
  pushToken: MutableRefObject<string | null>;
  /** Registers this phone for push; see deviceRegistration.ts. */
  registrar: DeviceRegistrar;
}

const Ctx = createContext<CustomerContext | null>(null);

export function CustomerProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [isDemo, setIsDemo] = useState(false);
  const token = useRef<string | null>(null);
  const pushToken = useRef<string | null>(null);
  // Read by the registrar between awaits, so it sees a sign-out that happens
  // while iOS is still answering - state would be a stale closure.
  const canRegister = useRef(false);
  canRegister.current = status === "signedIn" && !isDemo;
  const registrarRef = useRef<DeviceRegistrar | null>(null);

  const dropLocal = useCallback(async () => {
    canRegister.current = false;
    void registrarRef.current?.stop();
    token.current = null;
    pushToken.current = null;
    clearCache();
    setIsDemo(false);
    setStatus("signedOut");
    await clearCustomerSession();
  }, []);

  const api = useMemo(
    () =>
      createApiClient({
        origin: API_ORIGIN,
        token: () => token.current,
        onUnauthorized: () => {
          void dropLocal();
        },
      }),
    [dropLocal],
  );

  if (!registrarRef.current) {
    registrarRef.current = createDeviceRegistrar({
      getToken: getExpoPushToken,
      register: async (expoPushToken) => {
        await api.send("POST", "/api/me/devices", { expoPushToken, platform: Platform.OS === "ios" ? "ios" : "android" });
        pushToken.current = expoPushToken;
      },
      canRegister: () => canRegister.current && token.current !== null,
    });
  }
  const registrar = registrarRef.current;

  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await loadCustomerSession();
      if (!alive) return;
      token.current = saved;
      setStatus(saved ? "signedIn" : "signedOut");
    })();
    return () => {
      alive = false;
    };
  }, []);

  const signIn = useCallback(async (next: string, opts: { demo?: boolean } = {}) => {
    token.current = next;
    clearCache();
    setIsDemo(opts.demo === true);
    if (!opts.demo) await saveCustomerSession(next);
    registrar.resume();
    setStatus("signedIn");
  }, [registrar]);

  const signOut = useCallback(async () => {
    // Stop this phone hearing from any shop BEFORE the session goes. stop()
    // first: no new registration starts, and one already in flight is waited
    // for, so it can't land after this and leave the phone registered.
    canRegister.current = false;
    const device = (await registrar.stop()) ?? pushToken.current;
    if (device && token.current && !isDemo) {
      await api.send("POST", "/api/me/devices/remove", { expoPushToken: device }).catch(() => {});
    }
    // The last shop link opened here is somebody's own record. Signing out is
    // "I'm done on this phone": the next person must not get it in one tap
    // from the sign-in screen.
    await AsyncStorage.removeItem(STORAGE.lastToken).catch(() => {});
    await dropLocal();
  }, [api, dropLocal, isDemo, registrar]);

  const value = useMemo<CustomerContext>(
    () => ({ status, isDemo, api, signIn, signOut, pushToken, registrar }),
    [status, isDemo, api, signIn, signOut, registrar],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCustomer(): CustomerContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCustomer outside CustomerProvider");
  return ctx;
}

/**
 * Register this phone for push from every linked shop - once the customer has
 * reached their home (so the system prompt arrives when it makes sense, not on
 * a sign-in screen), and again on every return to the foreground until the
 * server has confirmed it: a customer who turns notifications on in Settings
 * is registered when they come back, not on the next cold launch. See
 * deviceRegistration.ts for the rules. Best-effort: nothing else depends on it.
 */
export function useRegisterDevice(): void {
  const { status, isDemo, registrar } = useCustomer();
  useEffect(() => {
    if (status !== "signedIn" || isDemo) return;
    void registrar.attempt();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void registrar.attempt();
    });
    return () => sub.remove();
  }, [status, isDemo, registrar]);
}

// ---------------------------------------------------------------------------
// Resources: last good answer first, then fresh
// ---------------------------------------------------------------------------

const cache = new Map<string, unknown>();

export function clearCache(): void {
  cache.clear();
}

/** Forget cached answers under a path prefix, so the next focus refetches. */
export function invalidate(prefix: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  /** No data yet and a request is in flight - show the skeleton. */
  loading: boolean;
  /** Pull-to-refresh in flight. */
  refreshing: boolean;
  /** Showing cached data because the latest request failed offline. */
  stale: boolean;
  refresh: () => Promise<void>;
  /** Refetch quietly - no pull-to-refresh spinner - as a focus does. */
  reload: () => Promise<void>;
}

export function useResource<T>(path: string | null): Resource<T> {
  const { api, status } = useCustomer();
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T | undefined) : undefined));
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(path !== null && !cache.has(path));
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(
    async (mode: "focus" | "refresh") => {
      if (!path || status !== "signedIn" || inFlight.current) return;
      inFlight.current = true;
      if (mode === "refresh") setRefreshing(true);
      else if (!cache.has(path)) setLoading(true);
      try {
        const fresh = await api.get<T>(path);
        cache.set(path, fresh);
        setData(fresh);
        setError(null);
      } catch (err) {
        setError(err);
        // Keep whatever we last had on screen; the banner says it's stale.
      } finally {
        inFlight.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api, path, status],
  );

  useFocusEffect(
    useCallback(() => {
      const cached = path ? (cache.get(path) as T | undefined) : undefined;
      if (cached !== undefined) setData(cached);
      void load("focus");
    }, [load, path]),
  );

  return {
    data,
    error,
    loading,
    refreshing,
    stale: data !== undefined && error instanceof ApiError && error.kind === "offline",
    refresh: () => load("refresh"),
    reload: () => load("focus"),
  };
}
