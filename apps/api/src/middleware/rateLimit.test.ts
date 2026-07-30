import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { publicIpKey } from "./rateLimit.js";

/**
 * publicIpKey decides which bucket a PUBLIC request lands in. The stakes:
 * key on the forwarded visitor IP only when the web app proves itself with
 * the shared secret — otherwise anyone hitting the API directly could rotate
 * `x-cb-client-ip` to mint fresh buckets and bypass per-IP limits entirely.
 */
function reqWith(headers: Record<string, string>, ip = "203.0.113.9"): Request {
  return {
    ip,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

const SECRET = "test-proxy-secret-0123456789abcdef";

afterEach(() => {
  delete process.env.WEB_PROXY_SECRET;
});

describe("publicIpKey", () => {
  it("keys on req.ip when no secret is configured (headers ignored)", () => {
    expect(
      publicIpKey(reqWith({ "x-cb-client-ip": "10.0.0.1", "x-cb-proxy-secret": "x" })),
    ).toBe("203.0.113.9");
  });

  it("keys on the forwarded IP when the secret matches", () => {
    process.env.WEB_PROXY_SECRET = SECRET;
    expect(
      publicIpKey(
        reqWith({ "x-cb-client-ip": "198.51.100.7", "x-cb-proxy-secret": SECRET }),
      ),
    ).toBe("fwd:198.51.100.7");
  });

  it("falls back to req.ip on a WRONG secret (spoof attempt)", () => {
    process.env.WEB_PROXY_SECRET = SECRET;
    expect(
      publicIpKey(
        reqWith({ "x-cb-client-ip": "198.51.100.7", "x-cb-proxy-secret": "guess" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("falls back to req.ip when the forwarded header is missing", () => {
    process.env.WEB_PROXY_SECRET = SECRET;
    expect(publicIpKey(reqWith({ "x-cb-proxy-secret": SECRET }))).toBe("203.0.113.9");
  });

  it("bounds attacker-controlled key length", () => {
    process.env.WEB_PROXY_SECRET = SECRET;
    const key = publicIpKey(
      reqWith({ "x-cb-client-ip": "a".repeat(500), "x-cb-proxy-secret": SECRET }),
    );
    expect(key.length).toBeLessThanOrEqual(68);
  });
});
