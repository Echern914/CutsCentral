import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

/**
 * The web deployment's self-report. Two properties: only an authenticated
 * caller gets it, and it never contains a value.
 */

const SECRET = "test-proxy-secret";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://web.test/api/ops/config", { headers });
}

beforeEach(() => {
  process.env.WEB_PROXY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_supersecret";
  delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
});

afterEach(() => {
  delete process.env.WEB_PROXY_SECRET;
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

describe("GET /api/ops/config", () => {
  it("🔴 answers 404, not 401, without the shared secret", async () => {
    // 404 on purpose: an unauthenticated caller should not learn that an
    // operational status endpoint exists here at all.
    expect((await GET(req())).status).toBe(404);
    expect((await GET(req({ "x-cb-proxy-secret": "wrong" }))).status).toBe(404);
  });

  it("404s when the secret is unset on this side, rather than opening up", async () => {
    delete process.env.WEB_PROXY_SECRET;
    expect((await GET(req({ "x-cb-proxy-secret": SECRET }))).status).toBe(404);
  });

  it("🔴 reports BOOLEANS and never the values", async () => {
    const res = await GET(req({ "x-cb-proxy-secret": SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.posthog).toBe(true);
    expect(body.metaPixel).toBe(false);
    // The key itself must never appear - this would be the easiest place in
    // the product to leak one.
    expect(JSON.stringify(body)).not.toMatch(/phc_/);
  });
});
