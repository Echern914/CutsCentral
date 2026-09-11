import { afterAll, describe, expect, it } from "vitest";
import { __resetEnvCacheForTests, apiEnv } from "./env.js";

/**
 * THE UNSUBSCRIBE SECRET MUST BE ITS OWN, AND PRODUCTION MUST NOT BOOT WITHOUT IT.
 *
 * 🔴 WHAT THIS IS GUARDING. Unsubscribe tokens are derived from a key. Whatever
 * that key is decides how long a link in a three-week-old email keeps working.
 * Deriving them from SESSION_SECRET tied that to a value whose whole purpose is
 * to be rotated - and the breakage would not even show at rotation. It shows at
 * each client's NEXT broadcast, when their stored digest is overwritten under
 * the new key and every link already in their inbox quietly stops matching.
 *
 * A fallback is fine in development. A fallback nobody is told about, in
 * production, is how this becomes one secret again six months from now - so the
 * process refuses to start instead.
 */

const BASE: NodeJS.ProcessEnv = {
  APP_BASE_URL: "https://app.test",
  API_BASE_URL: "https://api.test",
  SESSION_SECRET: "a-session-secret-that-is-long-enough",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ADMIN_TOKEN: "admin-token",
  ACUITY_OAUTH_CLIENT_ID: "id",
  ACUITY_OAUTH_CLIENT_SECRET: "secret",
  ACUITY_OAUTH_REDIRECT_URI: "https://api.test/cb",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_FROM_NUMBER: "+15551234567",
  DATABASE_URL: "postgresql://u@localhost:5432/db",
};

/** `openssl rand -base64 32` - 32 random bytes, which is 44 characters. */
const GOOD_SECRET = Buffer.alloc(32, 3).toString("base64");

// These parse a synthetic environment into the module-level cache. Clear it so
// nothing downstream reads this file's fixture as the real environment.
afterAll(() => __resetEnvCacheForTests());

function parse(over: NodeJS.ProcessEnv): { ok: true; env: ReturnType<typeof apiEnv> } | { ok: false; message: string } {
  __resetEnvCacheForTests();
  try {
    return { ok: true, env: apiEnv({ ...BASE, ...over }) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

describe("UNSUBSCRIBE_TOKEN_SECRET", () => {
  it("🔴 production will not start without it", () => {
    const res = parse({ NODE_ENV: "production" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("UNSUBSCRIBE_TOKEN_SECRET");
    // The message has to be actionable at 2am, so it carries the command.
    expect(res.message).toContain("openssl rand -base64 32");
  });

  it("🔴 and will not accept the session key wearing its name", () => {
    // Setting them equal is the fallback written out by hand, with exactly the
    // same consequence: rotate sessions, break every outstanding link.
    const res = parse({
      NODE_ENV: "production",
      UNSUBSCRIBE_TOKEN_SECRET: BASE.SESSION_SECRET,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("must not be the same value as SESSION_SECRET");
  });

  it("refuses a short one - a guessable opt-out key is not an opt-out key", () => {
    const res = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: "too-short" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("32 bytes of entropy");
  });

  it("accepts 32 random bytes, base64", () => {
    const res = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: GOOD_SECRET });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.env.UNSUBSCRIBE_TOKEN_SECRET).toBe(GOOD_SECRET);
  });

  it("🔴 a BLANK value is unset, not malformed", () => {
    // `.env.example` ships this key empty so it is visible and obviously
    // required. Somebody copying that file must land in the development
    // fallback, not on a boot failure they then "fix" by deleting the line -
    // which is how the key ends up unset in production too.
    const res = parse({ NODE_ENV: "development", UNSUBSCRIBE_TOKEN_SECRET: "   " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.env.UNSUBSCRIBE_TOKEN_SECRET).toBeUndefined();

    // And blank is still refused in production, by the rule that refuses absence.
    const prod = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: "" });
    expect(prod.ok).toBe(false);
    if (prod.ok) return;
    expect(prod.message).toContain("required in production");
  });

  it("development still runs without one, so nobody has to set it to get started", () => {
    // The fallback is announced in the log rather than hidden - see
    // engines/unsubscribeToken.ts. What must NOT happen is a dev environment
    // that refuses to boot, which is how a guard gets commented out.
    const res = parse({ NODE_ENV: "development" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.env.UNSUBSCRIBE_TOKEN_SECRET).toBeUndefined();
  });
});
