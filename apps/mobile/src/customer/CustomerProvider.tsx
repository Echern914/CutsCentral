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
import { Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import { API_ORIGIN } from "@/src/config";
import { getExpoPushToken } from "@/src/push";
import { ApiError, createApiClient, type ApiClient } from "./api";
import { clearCustomerSession, loadCustomerSession, saveCustomerSession } from "./sessionStore";

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
}

const Ctx = createContext<CustomerContext | null>(null);

export function CustomerProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [isDemo, setIsDemo] = useState(false);
  const token = useRef<string | null>(null);
  const pushToken = useRef<string | null>(null);

  const dropLocal = useCallback(async () => {
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
    setStatus("signedIn");
  }, []);

  const signOut = useCallback(async () => {
    // Stop this phone hearing from any shop BEFORE the session goes.
    const device = pushToken.current;
    if (device && token.current && !isDemo) {
      await api.send("POST", "/api/me/devices/remove", { expoPushToken: device }).catch(() => {});
    }
    await dropLocal();
  }, [api, dropLocal, isDemo]);

  const value = useMemo<CustomerContext>(
    () => ({ status, isDemo, api, signIn, signOut, pushToken }),
    [status, isDemo, api, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCustomer(): CustomerContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCustomer outside CustomerProvider");
  return ctx;
}

/**
 * Register this phone for push from every linked shop - once per launch, after
 * the customer has reached their home (so the system prompt arrives when it
 * makes sense, not on a sign-in screen). Best-effort: a denied permission or a
 * failed call changes nothing else.
 */
export function useRegisterDevice(): void {
  const ctx = useCustomer();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || ctx.status !== "signedIn" || ctx.isDemo) return;
    done.current = true;
    (async () => {
      const expoPushToken = await getExpoPushToken();
      if (!expoPushToken) return;
      ctx.pushToken.current = expoPushToken;
      await ctx.api
        .send("POST", "/api/me/devices", { expoPushToken, platform: Platform.OS === "ios" ? "ios" : "android" })
        .catch(() => {});
    })();
  }, [ctx]);
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
  };
}
