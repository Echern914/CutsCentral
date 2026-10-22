import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetEnvCacheForTests, decrypt, encrypt } from "@chairback/config";
import { openToken, openTokenNoting, openingKeys, purposeKeys, sealToken, tokenKeys } from "./tokenKey.js";
import { claimDigest, claimDigestMatches, previousClaimDigest } from "./customerIdentity.js";
import { publicIpKey } from "../middleware/rateLimit.js";

/**
 * Rotating TOKEN_ENCRYPTION_KEY must not cost a single Acuity/Square shop its
 * sync or a single customer a claimed record. These pin the reading side; the
 * moving of stored rows is engines/tokenRekey.test.ts.
 */

const NEW = randomBytes(32).toString("base64");
const OLD = randomBytes(32).toString("base64");
const saved = {
  key: process.env.TOKEN_ENCRYPTION_KEY,
  prev: process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS,
  proxy: process.env.WEB_PROXY_SECRET,
  proxyPrev: process.env.WEB_PROXY_SECRET_PREVIOUS,
};

function setKeys(current: string, previous?: string): void {
  process.env.TOKEN_ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  else process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = previous;
  __resetEnvCacheForTests();
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("TOKEN_ENCRYPTION_KEY", saved.key);
  restore("TOKEN_ENCRYPTION_KEY_PREVIOUS", saved.prev);
  restore("WEB_PROXY_SECRET", saved.proxy);
  restore("WEB_PROXY_SECRET_PREVIOUS", saved.proxyPrev);
  __resetEnvCacheForTests();
});

describe("sealing and opening across a rotation", () => {
  beforeEach(() => setKeys(NEW, OLD));

  it("seals with the NEW key only", () => {
    const sealed = sealToken("acuity-token");
    expect(decrypt(sealed, NEW)).toBe("acuity-token");
    expect(() => decrypt(sealed, OLD)).toThrow();
  });

  it("opens a value sealed under the OLD key, and flags it stale", () => {
    const old = encrypt("square-refresh", OLD);
    expect(openToken(old)).toBe("square-refresh");
    expect(openTokenNoting(old)).toEqual({ plaintext: "square-refresh", stale: true });
    expect(openTokenNoting(sealToken("x"))).toEqual({ plaintext: "x", stale: false });
  });

  it("purpose keys are newest first", () => {
    expect(purposeKeys("p")).toEqual([`${NEW}:p`, `${OLD}:p`]);
  });
});

describe("with no rotation underway", () => {
  it("an old-key value does NOT open - the previous key is the only bridge", () => {
    setKeys(NEW);
    expect(openingKeys()).toEqual([NEW]);
    expect(() => openToken(encrypt("t", OLD))).toThrow();
  });

  it("PREVIOUS equal to the current key is no rotation", () => {
    setKeys(NEW, NEW);
    expect(tokenKeys().previous).toBeNull();
  });

  it("a blank PREVIOUS is unset (an emptied Railway variable)", () => {
    setKeys(NEW, "  ");
    expect(tokenKeys().previous).toBeNull();
  });

  it("a MALFORMED previous key is ignored, not a crash - boot must survive a typo", () => {
    setKeys(NEW, "not-a-32-byte-key");
    expect(() => tokenKeys()).not.toThrow();
    expect(tokenKeys()).toEqual({ current: NEW, previous: null });
  });
});

describe("claimed records survive the key change", () => {
  const magicToken = randomBytes(24).toString("base64url");

  it("a digest written under the OLD key still matches mid-rotation", () => {
    setKeys(OLD);
    const writtenBefore = claimDigest(magicToken);
    setKeys(NEW, OLD);
    expect(claimDigestMatches(writtenBefore, magicToken)).toBe(true);
    expect(previousClaimDigest(magicToken)).toBe(writtenBefore);
    // ...and new writes are under the new key.
    expect(claimDigest(magicToken)).not.toBe(writtenBefore);
  });

  it("without PREVIOUS the same digest is 'credential_rotated' - why the variable must be set", () => {
    setKeys(OLD);
    const writtenBefore = claimDigest(magicToken);
    setKeys(NEW);
    expect(claimDigestMatches(writtenBefore, magicToken)).toBe(false);
  });

  it("a rotated REWARDS LINK still fails under either key", () => {
    setKeys(NEW, OLD);
    const stored = claimDigest(magicToken);
    expect(claimDigestMatches(stored, randomBytes(24).toString("base64url"))).toBe(false);
    expect(claimDigestMatches(null, magicToken)).toBe(false);
  });
});

describe("web proxy secret rotation", () => {
  const req = (secret: string) =>
    ({
      header: (h: string) =>
        h === "x-cb-proxy-secret" ? secret : h === "x-cb-client-ip" ? "203.0.113.7" : undefined,
      ip: "10.0.0.1",
    }) as unknown as Parameters<typeof publicIpKey>[0];

  it("accepts the current and the previous secret, and nothing else", () => {
    process.env.WEB_PROXY_SECRET = "new-proxy-secret";
    process.env.WEB_PROXY_SECRET_PREVIOUS = "old-proxy-secret";
    expect(publicIpKey(req("new-proxy-secret"))).toBe("fwd:203.0.113.7");
    expect(publicIpKey(req("old-proxy-secret"))).toBe("fwd:203.0.113.7");
    expect(publicIpKey(req("guess"))).toBe("10.0.0.1");
  });

  it("a blank PREVIOUS never matches a blank header", () => {
    process.env.WEB_PROXY_SECRET = "new-proxy-secret";
    process.env.WEB_PROXY_SECRET_PREVIOUS = "";
    expect(publicIpKey(req(""))).toBe("10.0.0.1");
  });
});
