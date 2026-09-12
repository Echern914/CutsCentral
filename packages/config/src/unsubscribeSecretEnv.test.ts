import { afterAll, describe, expect, it } from "vitest";
import { __resetEnvCacheForTests, apiEnv, marketingEmailConfigError } from "./env.js";

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
  it("🔴 THE API STILL BOOTS WITHOUT IT - marketing email is what switches off", () => {
    // 🔴 THIS USED TO BE A BOOT FAILURE, AND IT GROUNDED PRODUCTION. Main was
    // deployed without the variable and the API refused to start: no bookings,
    // no payments, no dashboards, for every shop, over a setting that belongs
    // to marketing email. A configuration guard must not be able to take down
    // more than the feature it guards.
    const res = parse({ NODE_ENV: "production" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // ...and the feature is refused, in a sentence somebody can act on at 2am.
    const problem = marketingEmailConfigError(res.env);
    expect(problem).not.toBeNull();
    expect(problem).toContain("UNSUBSCRIBE_TOKEN_SECRET");
    expect(problem).toContain("openssl rand -base64 32");
  });

  it("🔴 and refuses the session key wearing its name - still without grounding anything", () => {
    // Setting them equal is the fallback written out by hand, with exactly the
    // same consequence: rotate sessions, break every outstanding link.
    // Both set to the same well-formed key, so it is the EQUALITY that is
    // caught rather than the shape - the default fixture session secret is not
    // base64 and would be refused a step earlier for the wrong reason.
    const res = parse({
      NODE_ENV: "production",
      SESSION_SECRET: GOOD_SECRET,
      UNSUBSCRIBE_TOKEN_SECRET: GOOD_SECRET,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(marketingEmailConfigError(res.env)).toContain(
      "must not be the same value as SESSION_SECRET",
    );
  });

  it("a properly configured production deployment reports no problem", () => {
    const res = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: GOOD_SECRET });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(marketingEmailConfigError(res.env)).toBeNull();
  });

  it("development is never held to it - the fallback is announced, not enforced", () => {
    const res = parse({ NODE_ENV: "development" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(marketingEmailConfigError(res.env)).toBeNull();
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

  it("🔴 a malformed value is still refused AT THE SCHEMA", () => {
    // The shape of a value it WAS given is a different question from whether a
    // value was given at all. A key that cannot be what it claims to be is an
    // operator error worth failing on, and failing here does not depend on a
    // feature being reached.
    const res = parse({ NODE_ENV: "production", UNSUBSCRIBE_TOKEN_SECRET: "nonsense!!" });
    expect(res.ok).toBe(false);
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
    expect(prod.ok).toBe(true);
    if (!prod.ok) return;
    expect(prod.env.UNSUBSCRIBE_TOKEN_SECRET).toBeUndefined();
    // Blank means unset, and unset in production switches marketing email off.
    expect(marketingEmailConfigError(prod.env)).toContain("UNSUBSCRIBE_TOKEN_SECRET");
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
