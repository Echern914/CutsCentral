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
import * as Notifications from "expo-notifications";
import { useFocusEffect } from "expo-router";
import { API_ORIGIN, STORAGE } from "@/src/config";
import { getExpoPushToken } from "@/src/push";
import { ApiError, createApiClient, type ApiClient } from "./api";
import { clearCustomerSession, loadCustomerSession, pushDeviceMemory, saveCustomerSession } from "./sessionStore";
import { createDeviceRegistrar, type DeviceRegistrar } from "./deviceRegistration";
import { createDeviceRelease, releaseSender, type DeviceRelease } from "./deviceRelease";
import { connectResourceWake, resourceWake, shouldRefetchOnWake } from "./resourceWake";

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
  // Read by the 401 handler, which is created once and would see a stale state.
  const isDemoRef = useRef(false);
  isDemoRef.current = isDemo;
  const registrarRef = useRef<DeviceRegistrar | null>(null);

  // Taking the phone off an account's push, remembered across launches until
  // the server confirms it (deviceRelease.ts).
  const releaseRef = useRef<DeviceRelease | null>(null);
  if (!releaseRef.current) {
    releaseRef.current = createDeviceRelease({ ...pushDeviceMemory, send: releaseSender({ origin: API_ORIGIN }) });
  }
  const deviceRelease = releaseRef.current;
  // The removal in flight, if any. A registration waits for it: one landing
  // after the other's registration could take the live sign-in off.
  const releasing = useRef<Promise<unknown>>(Promise.resolve());

  /** Forget the session here. Answers the push token this phone may still be registered under. */
  const dropLocal = useCallback(async (): Promise<string | null> => {
    canRegister.current = false;
    const stopping = registrarRef.current?.stop() ?? Promise.resolve(null);
    const device = pushToken.current;
    token.current = null;
    pushToken.current = null;
    clearCache();
    setIsDemo(false);
    setStatus("signedOut");
    await clearCustomerSession();
    return (await stopping.catch(() => null)) ?? device;
  }, []);

  const api = useMemo(
    () =>
      createApiClient({
        origin: API_ORIGIN,
        token: () => token.current,
        onUnauthorized: () => {
          // A dead session (60 days old, or revoked) signs out on the spot -
          // and must not leave this phone hearing from that account. Its
          // token can no longer reach /api/me, but the release route takes it.
          const bearer = token.current;
          const demo = isDemoRef.current;
          const dropping = dropLocal();
          if (bearer && !demo) {
            const prior = releasing.current;
            releasing.current = (async () => {
              await prior.catch(() => {});
              const device = await dropping;
              await deviceRelease.release({ bearer, expoPushToken: device });
            })().catch(() => {});
          }
        },
      }),
    [deviceRelease, dropLocal],
  );

  if (!registrarRef.current) {
    registrarRef.current = createDeviceRegistrar({
      getToken: getExpoPushToken,
      register: async (expoPushToken) => {
        await releasing.current.catch(() => {});
        await api.send("POST", "/api/me/devices", { expoPushToken, platform: Platform.OS === "ios" ? "ios" : "android" });
        pushToken.current = expoPushToken;
        await deviceRelease.registered(expoPushToken);
      },
      canRegister: () => canRegister.current && token.current !== null,
    });
  }
  const registrar = registrarRef.current;

  // A removal an earlier launch could not send (offline, app killed) goes
  // first thing, before this launch registers anything.
  useEffect(() => {
    releasing.current = deviceRelease.retryPending().catch(() => {});
  }, [deviceRelease]);

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

  // Back from the background, or a push while open: the screens on show read
  // their data again (resourceWake.ts says why focus alone misses both - a
  // booking the barber moved stayed at the old time until a pull). One
  // listener for the whole app; signed out there is nothing to read.
  useEffect(() => {
    if (status !== "signedIn") return;
    return connectResourceWake(
      {
        onAppState: (listener) => AppState.addEventListener("change", listener),
        onNotificationReceived: (listener) =>
          Notifications.addNotificationReceivedListener((n) => listener(n.request.content.data)),
      },
      resourceWake,
    );
  }, [status]);

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
    const bearer = token.current;
    const device = (await registrar.stop()) ?? pushToken.current;
    if (bearer && !isDemo) {
      // Written down before it is sent, and retried next launch if it doesn't
      // land; with no token from this launch, the one remembered from an
      // earlier launch is removed.
      const job = deviceRelease.release({ bearer, expoPushToken: device });
      releasing.current = job.catch(() => {});
      await job.catch(() => {});
    }
    // The last shop link opened here is somebody's own record. Signing out is
    // "I'm done on this phone": the next person must not get it in one tap
    // from the sign-in screen.
    await AsyncStorage.removeItem(STORAGE.lastToken).catch(() => {});
    await dropLocal();
  }, [deviceRelease, dropLocal, isDemo, registrar]);

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
  // When this resource last STARTED a request, for the foreground throttle.
  const lastFetchAt = useRef<number | null>(null);

  const load = useCallback(
    async (mode: "focus" | "refresh") => {
      if (!path || status !== "signedIn" || inFlight.current) return;
      inFlight.current = true;
      lastFetchAt.current = Date.now();
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

  // Back from the background or a push while open (the provider's listener):
  // read again, quietly - the cached answer stays on screen until the fresh
  // one replaces it. Mounted screens only; the rest read on their next focus.
  const latestLoad = useRef(load);
  latestLoad.current = load;
  useEffect(
    () =>
      resourceWake.subscribe((reason) => {
        if (!shouldRefetchOnWake(reason, lastFetchAt.current, Date.now(), inFlight.current)) return;
        void latestLoad.current("focus");
      }),
    [],
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
