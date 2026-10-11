import { describe, expect, it, vi } from "vitest";
import { createDeviceRelease, releaseSender, type KeyValue, type PendingRelease, type SendOutcome } from "./deviceRelease";

/** A keychain value that survives "relaunches" (new createDeviceRelease calls). */
function memory(initial: string | null = null): KeyValue & { value: string | null } {
  const kv = {
    value: initial,
    async get() {
      return kv.value;
    },
    async set(v: string) {
      kv.value = v;
    },
    async clear() {
      kv.value = null;
    },
  };
  return kv;
}

function phone() {
  return { device: memory(), pending: memory() };
}

function launch(store: ReturnType<typeof phone>, send: (r: PendingRelease) => Promise<SendOutcome>) {
  return createDeviceRelease({ ...store, send });
}

const T = "ExponentPushToken[abc123]";

describe("a signed-out phone stops hearing from the account", () => {
  it("🔴 a release that failed is retried on the NEXT launch, until it lands", async () => {
    const store = phone();
    const offline = vi.fn(async () => "retry" as const);
    const first = launch(store, offline);
    await first.registered(T);
    expect(await first.release({ bearer: "session-1", expoPushToken: T })).toBe("retry");
    expect(offline).toHaveBeenCalledWith({ expoPushToken: T, bearer: "session-1" });

    // Relaunch, still offline: still remembered.
    expect(await launch(store, offline).retryPending()).toBe("retry");

    // Relaunch, online: sent, and crossed off.
    const online = vi.fn(async () => "done" as const);
    expect(await launch(store, online).retryPending()).toBe("done");
    expect(online).toHaveBeenCalledWith({ expoPushToken: T, bearer: "session-1" });
    expect(await launch(store, online).retryPending()).toBe("nothing");
    expect(online).toHaveBeenCalledTimes(1);
  });

  it("🔴 the token registered on an EARLIER launch is released when this launch registered none", async () => {
    const store = phone();
    await launch(store, async () => "done").registered(T);
    // Relaunch, and sign out (or a 401) before Home registered again.
    const send = vi.fn(async () => "done" as const);
    expect(await launch(store, send).release({ bearer: "session-1", expoPushToken: null })).toBe("done");
    expect(send).toHaveBeenCalledWith({ expoPushToken: T, bearer: "session-1" });
  });

  it("the removal is written down BEFORE it is sent - an app killed mid-request still retries", async () => {
    const store = phone();
    let seen: string | null = null;
    const killed = launch(store, async () => {
      seen = store.pending.value;
      throw new Error("app killed");
    });
    expect(await killed.release({ bearer: "session-1", expoPushToken: T })).toBe("retry");
    expect(JSON.parse(seen!)).toEqual({ expoPushToken: T, bearer: "session-1" });
  });

  it("🔴 signing in again on this phone cancels an old removal of the same token", async () => {
    const store = phone();
    await launch(store, async () => "retry").release({ bearer: "session-1", expoPushToken: T });
    // Back online, signed in again, and the server confirmed this phone.
    const send = vi.fn(async () => "done" as const);
    const next = launch(store, send);
    await next.registered(T);
    // The old removal would only take the live sign-in off: it is gone.
    expect(await next.retryPending()).toBe("nothing");
    expect(send).not.toHaveBeenCalled();
  });

  it("nothing to release: no token known, or no session to speak for", async () => {
    const send = vi.fn(async () => "done" as const);
    const r = launch(phone(), send);
    expect(await r.release({ bearer: "session-1", expoPushToken: null })).toBe("nothing");
    expect(await r.release({ bearer: "", expoPushToken: T })).toBe("nothing");
    expect(send).not.toHaveBeenCalled();
  });

  it("a newer removal written while an older one was in flight is not crossed off", async () => {
    const store = phone();
    let release!: () => void;
    const r = launch(store, (job) =>
      job.bearer === "session-1"
        ? new Promise<SendOutcome>((res) => (release = () => res("done")))
        : Promise.resolve("retry"),
    );
    const older = r.release({ bearer: "session-1", expoPushToken: T });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await r.release({ bearer: "session-2", expoPushToken: "ExponentPushToken[other]" });
    release();
    expect(await older).toBe("done");
    expect(JSON.parse(store.pending.value!)).toEqual({ expoPushToken: "ExponentPushToken[other]", bearer: "session-2" });
  });
});

describe("the release request", () => {
  const ORIGIN = "https://api.example.test";
  const job = { expoPushToken: T, bearer: "dead-session" };
  const answer = (status: number) => async () =>
    new Response(JSON.stringify(status < 300 ? { ok: true } : { error: "x" }), { status });

  it("sends the push token, with the (possibly dead) session as the bearer", async () => {
    const fetchImpl = vi.fn(answer(200));
    expect(await releaseSender({ origin: ORIGIN, fetchImpl })(job)).toBe("done");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/customer-auth/devices/release`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dead-session");
    expect(JSON.parse(init.body as string)).toEqual({ expoPushToken: T });
  });

  it("offline, a server error or a rate limit: try again later", async () => {
    const offline = async () => {
      throw new TypeError("Network request failed");
    };
    expect(await releaseSender({ origin: ORIGIN, fetchImpl: offline })(job)).toBe("retry");
    expect(await releaseSender({ origin: ORIGIN, fetchImpl: answer(503) })(job)).toBe("retry");
    expect(await releaseSender({ origin: ORIGIN, fetchImpl: answer(429) })(job)).toBe("retry");
  });

  it("any other refusal is final - asking again would not change it", async () => {
    expect(await releaseSender({ origin: ORIGIN, fetchImpl: answer(401) })(job)).toBe("done");
    expect(await releaseSender({ origin: ORIGIN, fetchImpl: answer(404) })(job)).toBe("done");
    expect(await releaseSender({ origin: ORIGIN, fetchImpl: answer(400) })(job)).toBe("done");
  });
});
