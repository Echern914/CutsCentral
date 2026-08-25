import { describe, expect, it } from "vitest";
import { redactSecret } from "./webhookSubscription.js";

/**
 * The per-shop webhook secret must not come back out through a LOG.
 *
 * `/webhooks/acuity/:secret` is authenticated by its URL alone, so that value
 * is a bearer credential. We send it to Acuity inside the subscription
 * request's `target`, and Acuity's error responses quote the request back - so
 * logging the response body verbatim republished the secret to stdout.
 *
 * logRedaction masks it in a request URL. Nothing masked it arriving back
 * inside a response body, which is what this covers.
 */
describe("redactSecret", () => {
  it("removes the webhook secret from an echoed error body", () => {
    const secret = "SHOPWEBHOOKSECRET1234";
    const echoed = `{"error":"invalid target","target":"https://api.example/webhooks/acuity/${secret}"}`;
    const out = redactSecret(echoed, secret);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
    // Still says what went wrong.
    expect(out).toContain("invalid target");
  });

  it("catches the URL-encoded form too", () => {
    // An echoed request body may have escaped it.
    const secret = "a+b/c=d";
    const out = redactSecret(`target=${encodeURIComponent(secret)}`, secret);
    expect(out).not.toContain(encodeURIComponent(secret));
    expect(out).toContain("[redacted]");
  });

  it("removes EVERY occurrence, not just the first", () => {
    const secret = "SEC123";
    expect(redactSecret(`${secret} and ${secret}`, secret)).toBe("[redacted] and [redacted]");
  });

  it("leaves an unrelated body untouched", () => {
    expect(redactSecret('{"error":"rate limited"}', "SEC123")).toBe('{"error":"rate limited"}');
  });

  it("is safe with empty input", () => {
    expect(redactSecret("", "SEC")).toBe("");
    expect(redactSecret("body", "")).toBe("body");
  });
});
