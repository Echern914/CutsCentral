import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AFFILIATE_CLAIM_KEY_VERSION,
  AFFILIATE_CLAIM_TTL_SECONDS,
  createAffiliateClaim,
  normalizeAffiliateCode,
  verifyAffiliateClaim,
} from "./affiliateAttribution.js";
import { createSession, verifySession } from "./session.js";

/**
 * The claim is the only thing standing between a hostile browser and a free
 * affiliate attribution, so every rejection path is pinned here: forged and
 * tampered signatures, the wrong key, a retired key, expiry, a stretched
 * window, and cross-token replay in BOTH directions.
 */

const SECRET = "test-secret-at-least-16-chars";
const OTHER = "a-completely-different-secret-!!";
const KEYRING = { [AFFILIATE_CLAIM_KEY_VERSION]: SECRET };
const NOW = 1_800_000_000;
const CODE = "Ab3d-Ef_h1jK";

function mint(over: Partial<Parameters<typeof createAffiliateClaim>[0]> = {}) {
  return createAffiliateClaim({
    code: CODE,
    source: "link",
    secret: SECRET,
    nowSeconds: NOW,
    ...over,
  });
}

describe("affiliate claim: the happy path", () => {
  it("round-trips code, source and window", () => {
    const claim = mint();
    const payload = verifyAffiliateClaim(claim, KEYRING, NOW + 60);
    expect(payload).not.toBeNull();
    expect(payload!.code).toBe(CODE);
    expect(payload!.src).toBe("link");
    expect(payload!.exp - payload!.iat).toBe(AFFILIATE_CLAIM_TTL_SECONDS);
  });

  it("carries no internal identifier or personal data - only the public code", () => {
    const claim = mint({ source: "explicit_code" });
    const decoded = JSON.parse(
      Buffer.from(claim.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(
      ["code", "exp", "iat", "k", "purpose", "src"].sort(),
    );
    // No id-shaped, email-shaped or phone-shaped value anywhere in the claim.
    expect(claim).not.toMatch(/@/);
    expect(JSON.stringify(decoded)).not.toMatch(/\bc[a-z0-9]{20,}\b/);
  });

  it("still verifies one second before expiry and fails one second after", () => {
    const claim = mint();
    const exp = NOW + AFFILIATE_CLAIM_TTL_SECONDS;
    expect(verifyAffiliateClaim(claim, KEYRING, exp - 1)).not.toBeNull();
    expect(verifyAffiliateClaim(claim, KEYRING, exp)).toBeNull();
    expect(verifyAffiliateClaim(claim, KEYRING, exp + 86_400)).toBeNull();
  });
});

describe("affiliate claim: rejection", () => {
  it("rejects a tampered payload, a tampered signature and a swapped code", () => {
    const claim = mint();
    const [payloadB64, sig] = claim.split(".") as [string, string];

    // Re-encode the payload with a different code, keeping the old signature.
    const decoded = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    decoded.code = "zzzzzzzzzzzz";
    const forgedPayload = Buffer.from(JSON.stringify(decoded), "utf8").toString(
      "base64url",
    );
    expect(verifyAffiliateClaim(`${forgedPayload}.${sig}`, KEYRING, NOW)).toBeNull();

    // Flip a signature character.
    const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(verifyAffiliateClaim(`${payloadB64}.${flipped}`, KEYRING, NOW)).toBeNull();

    // Signed with a secret we do not hold.
    const foreign = createAffiliateClaim({
      code: CODE,
      source: "link",
      secret: OTHER,
      nowSeconds: NOW,
    });
    expect(verifyAffiliateClaim(foreign, KEYRING, NOW)).toBeNull();
  });

  it("rejects malformed input of every shape without throwing", () => {
    for (const bad of [
      undefined,
      null,
      "",
      ".",
      "..",
      "no-dot-at-all",
      "a.",
      ".b",
      "%%%.%%%",
      Buffer.from("{not json").toString("base64url") + ".sig",
      "x".repeat(600),
      `${Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url")}.sig`,
    ]) {
      expect(verifyAffiliateClaim(bad as string | null, KEYRING, NOW)).toBeNull();
    }
  });

  it("rejects an unknown or retired key version - rotation fails closed", () => {
    const v2 = createAffiliateClaim({
      code: CODE,
      source: "link",
      secret: OTHER,
      nowSeconds: NOW,
      keyVersion: 2,
    });
    // v2 is not in the keyring at all.
    expect(verifyAffiliateClaim(v2, KEYRING, NOW)).toBeNull();
    // Add it and the same claim verifies - that IS the rotation path.
    expect(
      verifyAffiliateClaim(v2, { ...KEYRING, 2: OTHER }, NOW),
    ).not.toBeNull();
    // Retire v1: claims minted under it stop verifying immediately.
    expect(verifyAffiliateClaim(mint(), { 2: OTHER }, NOW)).toBeNull();
  });

  it("rejects a claim whose window was stretched beyond policy", () => {
    const stretched = createAffiliateClaim({
      code: CODE,
      source: "link",
      secret: SECRET,
      nowSeconds: NOW,
      ttlSeconds: AFFILIATE_CLAIM_TTL_SECONDS * 2,
    });
    // Signature is OURS and it has not expired - it is refused purely because
    // 120 days is not a window this program issues.
    expect(verifyAffiliateClaim(stretched, KEYRING, NOW + 60)).toBeNull();
  });

  it("rejects an off-vocabulary source and a bad code shape", () => {
    for (const patch of [{ src: "smuggled" }, { code: "has spaces" }, { code: "" }]) {
      const payload = {
        purpose: "affiliate-attribution",
        k: AFFILIATE_CLAIM_KEY_VERSION,
        code: CODE,
        src: "link",
        iat: NOW,
        exp: NOW + 100,
        ...patch,
      };
      const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      // Signed with OUR secret: these are refused on shape alone, not signature.
      const sig = createHmac("sha256", SECRET).update(b64).digest("base64url");
      expect(verifyAffiliateClaim(`${b64}.${sig}`, KEYRING, NOW)).toBeNull();
    }
  });
});

describe("affiliate claim: cross-token replay is refused both ways", () => {
  it("a session token is not a claim, and a claim is not a session", () => {
    const session = createSession("user_123", SECRET, NOW);
    expect(verifyAffiliateClaim(session, KEYRING, NOW)).toBeNull();

    const claim = mint();
    expect(verifySession(claim, SECRET, NOW)).toBeNull();
  });
});

describe("normalizeAffiliateCode", () => {
  it("accepts a real code, trims whitespace, and preserves case", () => {
    expect(normalizeAffiliateCode(`  ${CODE}  `)).toBe(CODE);
    expect(normalizeAffiliateCode(CODE.toLowerCase())).toBe(CODE.toLowerCase());
  });

  it("refuses hostile and empty input rather than sanitizing it into something", () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      [],
      "",
      "   ",
      "has spaces",
      "semi;colon",
      "<script>",
      "../../etc/passwd",
      "x".repeat(65),
      "short",
    ]) {
      expect(normalizeAffiliateCode(bad)).toBeNull();
    }
  });
});
