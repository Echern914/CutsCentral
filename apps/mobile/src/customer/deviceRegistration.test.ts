import { describe, expect, it, vi } from "vitest";
import { createDeviceRegistrar } from "./deviceRegistration";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("registering this phone for push", () => {
  it("🔴 permission turned on later: the next foreground registers it (was: done for the launch)", async () => {
    let permitted = false;
    const register = vi.fn(async () => {});
    const r = createDeviceRegistrar({
      getToken: async () => (permitted ? "ExponentPushToken[a]" : null),
      register,
      canRegister: () => true,
    });
    expect(await r.attempt()).toBe("no_token");
    permitted = true; // Settings -> Notifications -> On, then back to the app
    expect(await r.attempt()).toBe("registered");
    expect(register).toHaveBeenCalledWith("ExponentPushToken[a]");
  });

  it("🔴 a failed POST is retried on the next foreground, and once confirmed is not re-sent", async () => {
    const register = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const r = createDeviceRegistrar({ getToken: async () => "T", register, canRegister: () => true });
    expect(await r.attempt()).toBe("failed");
    expect(await r.attempt()).toBe("registered");
    expect(await r.attempt()).toBe("already");
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("🔴 never two at once: a foreground during an attempt joins it", async () => {
    const gate = deferred();
    const register = vi.fn(() => gate.promise);
    const r = createDeviceRegistrar({ getToken: async () => "T", register, canRegister: () => true });
    const first = r.attempt();
    const second = r.attempt();
    await Promise.resolve();
    gate.resolve();
    expect(await first).toBe("registered");
    expect(await second).toBe("registered");
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("never registers a signed-out or demo session", async () => {
    const register = vi.fn(async () => {});
    const r = createDeviceRegistrar({ getToken: async () => "T", register, canRegister: () => false });
    expect(await r.attempt()).toBe("skipped");
    expect(register).not.toHaveBeenCalled();
  });

  it("🔴 sign-out while iOS is still answering: nothing is sent", async () => {
    const token = deferred<string | null>();
    const register = vi.fn(async () => {});
    const r = createDeviceRegistrar({ getToken: () => token.promise, register, canRegister: () => true });
    const pending = r.attempt();
    const stopping = r.stop();
    token.resolve("T");
    expect(await pending).toBe("skipped");
    expect(await stopping).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it("🔴 sign-out waits for a registration in flight and hands back its token to remove, even if its answer is lost", async () => {
    const post = deferred();
    const r = createDeviceRegistrar({ getToken: async () => "T", register: () => post.promise, canRegister: () => true });
    const pending = r.attempt();
    await Promise.resolve();
    await Promise.resolve();
    let stoppedWith: string | null | undefined;
    const stopping = r.stop().then((t) => (stoppedWith = t));
    await Promise.resolve();
    expect(stoppedWith).toBeUndefined(); // still waiting on the POST
    post.reject(new Error("timeout")); // the server may have stored it anyway
    expect(await pending).toBe("failed");
    await stopping;
    expect(stoppedWith).toBe("T");
    // And nothing more runs until the next sign-in.
    expect(await r.attempt()).toBe("skipped");
  });

  it("a new sign-in registers again, for the new account", async () => {
    const register = vi.fn(async () => {});
    const r = createDeviceRegistrar({ getToken: async () => "T", register, canRegister: () => true });
    await r.attempt();
    expect(await r.stop()).toBe("T");
    r.resume();
    expect(await r.attempt()).toBe("registered");
    expect(register).toHaveBeenCalledTimes(2);
  });
});
