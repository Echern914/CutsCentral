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

/**
 * Stands in for `openssl rand -base64 32`: 32 bytes, base64, 44 characters.
 *
 * 🔴 A FIXED FILLER BYTE, NEVER A REAL KEY. A test fixture is committed, read
 * in review, and copied by whoever needs an example - so it must be obviously
 * unusable rather than merely unused.
 */
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

  it("accepts 32 random bytes, base64 - what `openssl rand -base64 32` gives you", () => {
    const res = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: GOOD_SECRET });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.env.UNSUBSCRIBE_TOKEN_SECRET).toBe(GOOD_SECRET);
  });

  it("accepts the URL-safe alphabet too", () => {
    // What `randomBytes(32).toString("base64url")` emits. Refusing a perfectly
    // strong key over which of the two spellings somebody reached for is
    // pedantry with a real cost: an operator who cannot get the variable
    // accepted removes it.
    const res = parse({
      NODE_ENV: "production",
      UNSUBSCRIBE_TOKEN_SECRET: Buffer.alloc(32, 250).toString("base64url"),
    });
    expect(res.ok).toBe(true);
  });

  it("🔴 refuses a long string that is NOT base64", () => {
    // The defect the old `.min(43)` had: it counted CHARACTERS, so this - the
    // right length and none of the strength the length stood in for - sailed
    // through. Buffer.from is no help on its own; it silently discards what it
    // does not recognise and hands back a plausible-looking key.
    const junk = "please-do-not-use-this-key-in-production!!!!!!";
    expect(junk.length).toBeGreaterThan(43);
    const res = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: junk });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("base64 decoding to at least 32 bytes");
  });

  it("🔴 refuses valid base64 that decodes to fewer than 32 bytes", () => {
    // 24 bytes is 32 characters of base64 - long enough to look right, and a
    // third short of the entropy the key is supposed to carry.
    const short = Buffer.alloc(24, 9).toString("base64");
    const res = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: short });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("at least 32 bytes");
  });

  it("refuses a short one - a guessable opt-out key is not an opt-out key", () => {
    const res = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: "too-short" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("at least 32 bytes");
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
