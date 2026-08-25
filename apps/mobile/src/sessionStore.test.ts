import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_KEY,
  clearSession,
  loadSession,
  saveSession,
  type SessionBackends,
  type TokenBackend,
} from "./sessionStore";

/**
 * Moving the barber's session token into the keychain.
 *
 * The risk in this change was never the keychain - it was the upgrade. Barbers
 * already have a token sitting in AsyncStorage; a version that reads only the
 * new location silently signs every one of them out, and they find out at 9am
 * with a client in the chair. So the migration and the fallback are the tests
 * that matter, and both of them are about NOT losing a working session.
 */

function store(initial: Record<string, string> = {}): TokenBackend & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: async (key) => data[key] ?? null,
    setItem: async (key, value) => {
      data[key] = value;
    },
    deleteItem: async (key) => {
      delete data[key];
    },
  };
}

/** A keychain that refuses every write, as a device with no passcode would. */
function brokenStore(): TokenBackend {
  return {
    getItem: async () => {
      throw new Error("keychain unavailable");
    },
    setItem: async () => {
      throw new Error("keychain unavailable");
    },
    deleteItem: async () => {
      throw new Error("keychain unavailable");
    },
  };
}

let secure: ReturnType<typeof store>;
let legacy: ReturnType<typeof store>;
let backends: SessionBackends;

beforeEach(() => {
  secure = store();
  legacy = store();
  backends = { secure, legacy };
});

describe("upgrading a device that already has a token", () => {
  it("finds the old token, moves it to the keychain, and returns it", async () => {
    legacy.data[SESSION_KEY] = "existing-token";

    await expect(loadSession(backends)).resolves.toBe("existing-token");

    expect(secure.data[SESSION_KEY]).toBe("existing-token");
    // And the plaintext copy is gone: leaving it behind would mean the move
    // bought nothing.
    expect(legacy.data[SESSION_KEY]).toBeUndefined();
  });

  it("keeps working - and keeps the old copy - when the keychain refuses", async () => {
    legacy.data[SESSION_KEY] = "existing-token";

    await expect(
      loadSession({ secure: brokenStore(), legacy }),
    ).resolves.toBe("existing-token");

    // The legacy copy is now the ONLY copy, so it must survive. Less private
    // than intended beats a barber locked out of their own calendar.
    expect(legacy.data[SESSION_KEY]).toBe("existing-token");
  });

  it("prefers the keychain once the token lives there", async () => {
    secure.data[SESSION_KEY] = "new-token";
    legacy.data[SESSION_KEY] = "stale-token";
    await expect(loadSession(backends)).resolves.toBe("new-token");
  });

  it("returns null on a fresh install", async () => {
    await expect(loadSession(backends)).resolves.toBeNull();
  });
});

describe("storing a new session", () => {
  it("writes to the keychain and clears any plaintext leftover", async () => {
    legacy.data[SESSION_KEY] = "old";
    await saveSession(backends, "fresh-token");
    expect(secure.data[SESSION_KEY]).toBe("fresh-token");
    expect(legacy.data[SESSION_KEY]).toBeUndefined();
  });

  it("falls back rather than losing the sign-in when the keychain fails", async () => {
    await saveSession({ secure: brokenStore(), legacy }, "fresh-token");
    expect(legacy.data[SESSION_KEY]).toBe("fresh-token");
  });
});

describe("signing out", () => {
  it("clears both stores", async () => {
    secure.data[SESSION_KEY] = "a";
    legacy.data[SESSION_KEY] = "b";
    await clearSession(backends);
    expect(secure.data[SESSION_KEY]).toBeUndefined();
    expect(legacy.data[SESSION_KEY]).toBeUndefined();
  });

  it("still clears the reachable store when the other one throws", async () => {
    legacy.data[SESSION_KEY] = "b";
    await clearSession({ secure: brokenStore(), legacy });
    // A sign-out that leaves a usable token on a shared phone is the one
    // failure here that actually matters.
    expect(legacy.data[SESSION_KEY]).toBeUndefined();
  });
});
