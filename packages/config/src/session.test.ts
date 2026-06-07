import { describe, expect, it } from "vitest";
import { createSession, verifySession } from "./session.js";

const SECRET = "test-secret-at-least-16-chars-long";
const NOW = 1_700_000_000; // fixed epoch seconds

describe("session sign/verify", () => {
  it("round-trips a valid session", () => {
    const token = createSession("user_1", SECRET, NOW);
    const payload = verifySession(token, SECRET, NOW + 10);
    expect(payload?.userId).toBe("user_1");
  });

  it("returns null for a tampered payload", () => {
    const token = createSession("user_1", SECRET, NOW);
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ userId: "attacker", iat: NOW, exp: NOW + 9999 })).toString("base64url")}.${sig}`;
    expect(verifySession(forged, SECRET, NOW + 10)).toBeNull();
  });

  it("returns null for a wrong secret", () => {
    const token = createSession("user_1", SECRET, NOW);
    expect(verifySession(token, "different-secret-xxxxxxxx", NOW + 10)).toBeNull();
  });

  it("returns null for an expired token", () => {
    const token = createSession("user_1", SECRET, NOW, 100);
    expect(verifySession(token, SECRET, NOW + 101)).toBeNull();
  });

  it("returns null for missing/garbage tokens", () => {
    expect(verifySession(undefined, SECRET, NOW)).toBeNull();
    expect(verifySession("", SECRET, NOW)).toBeNull();
    expect(verifySession("no-dot", SECRET, NOW)).toBeNull();
    expect(verifySession(".onlysig", SECRET, NOW)).toBeNull();
  });
});
