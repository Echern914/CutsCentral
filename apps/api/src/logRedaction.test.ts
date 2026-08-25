import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { redactedReqSerializer } from "./app.js";
import { maskPathByPrefix, maskPathByRoute, maskUrl } from "./logRedaction.js";

/**
 * NO CREDENTIAL MAY REACH STDOUT.
 *
 * Four routes authenticate with a secret in the URL PATH. Whatever reads
 * stdout - a log drain, an alert webhook, someone's screenshot - reads those
 * secrets, and a log channel has no expiry and no way to un-send.
 *
 * Every case below fails against the previous redaction, which masked query
 * parameters and one hardcoded webhook path and let the identical secret
 * through when it appeared as a path segment.
 *
 * The end-to-end cases drive the REAL app and read what pino actually wrote,
 * because the bug was never in a helper - it was in which helper the log call
 * happened to use.
 */

const CLAIM = "CLAIMTOKENaaaa1111";
const MANAGE = "MANAGETOKENbbbb2222";
const MAGIC = "MAGICTOKENcccc3333";
const WAITLIST = "WAITLISTTOKENdddd4444";

describe("maskPathByRoute - the route pattern decides", () => {
  it("masks a parameter the route declares, whatever the value looks like", () => {
    expect(maskPathByRoute(`/api/book/offer/${CLAIM}/claim`, "/offer/:token/claim")).toBe(
      "/api/book/offer/[redacted]/claim",
    );
  });

  it("keeps ids that are worth reading in a log line", () => {
    // Masking everything would be safe and useless - a log line with no shop
    // in it cannot be acted on.
    expect(
      maskPathByRoute("/api/booking/appointments/appt_123/checkout", "/appointments/:id/checkout"),
    ).toBe("/api/booking/appointments/appt_123/checkout");
  });

  it("masks an UNKNOWN parameter name by default", () => {
    // The whole point: a route added tomorrow is masked because its parameter
    // is not on the safe list, not because someone remembered to register it.
    expect(maskPathByRoute("/api/thing/SECRETVALUE", "/thing/:somethingNew")).toBe(
      "/api/thing/[redacted]",
    );
  });

  it("aligns the pattern to the END of the path, since the mount prefix is gone", () => {
    // req.baseUrl is "" by the time an app-level handler runs, so the pattern
    // has to be matched against the tail rather than the head.
    expect(maskPathByRoute(`/deeply/nested/mount/offer/${CLAIM}`, "/offer/:token")).toBe(
      "/deeply/nested/mount/offer/[redacted]",
    );
  });

  it("leaves the path alone when the pattern cannot apply", () => {
    expect(maskPathByRoute("/short", "/a/b/c/:token")).toBe("/short");
  });
});

describe("maskPathByPrefix - the fallback when no route matched", () => {
  it("covers all four token shapes without a route", () => {
    expect(maskPathByPrefix(`/api/book/offer/${CLAIM}/claim`)).toBe(
      "/api/book/offer/[redacted]/claim",
    );
    expect(maskPathByPrefix(`/api/book/manage/${MANAGE}/cancel`)).toBe(
      "/api/book/manage/[redacted]/cancel",
    );
    expect(maskPathByPrefix(`/api/rewards/${MAGIC}/opt-out`)).toBe("/api/rewards/[redacted]/opt-out");
    expect(maskPathByPrefix(`/api/shops/shop_1/waitlist/cancel/${WAITLIST}`)).toBe(
      "/api/shops/shop_1/waitlist/cancel/[redacted]",
    );
  });

  it("still masks the Acuity webhook secret, which is that route's only auth", () => {
    expect(maskPathByPrefix("/webhooks/acuity/SUPERSECRET")).toBe("/webhooks/acuity/[redacted]");
  });

  it("leaves ordinary paths untouched", () => {
    expect(maskPathByPrefix("/api/booking/appointments")).toBe("/api/booking/appointments");
  });
});

describe("maskUrl - query and fragment", () => {
  it("masks a path secret and a query secret in the same URL", () => {
    expect(maskUrl(`/api/book/offer/${CLAIM}/claim?token=OTHER&utm=x`, "/offer/:token/claim")).toBe(
      "/api/book/offer/[redacted]/claim?token=[redacted]&utm=x",
    );
  });

  it("does not let a query string shift the path alignment", () => {
    // Naively splitting on "/" across the whole URL would count "claim?token=x"
    // as the last segment and mask the wrong position.
    expect(maskUrl(`/api/book/manage/${MANAGE}/slots?day=2026-09-01`, "/manage/:token/slots")).toBe(
      "/api/book/manage/[redacted]/slots?day=2026-09-01",
    );
  });
});

//  THE ACTUAL LOG CALLS
//
// 🔴 An earlier version of this file spied on `process.stdout.write` and
// asserted the token was absent. Every case passed - against stdout that was
// EMPTY, because pino binds file descriptor 1 directly and never goes through
// `process.stdout.write` under vitest. Nine green tests proving nothing.
//
// So these assert at the boundary where the bug actually lived: what the
// serializer returns, and what the error handler passes to the logger.

describe("redactedReqSerializer - the line written on EVERY request", () => {
  it("masks a claim token on a SUCCESSFUL request", () => {
    // This is the big one. The leak was never mainly about 500s: pino-http
    // logs every completed request, so a claim that WORKED logged its own
    // still-live token.
    const out = redactedReqSerializer({
      method: "POST",
      url: `/api/book/offer/${CLAIM}/claim`,
      route: { path: "/offer/:token/claim" },
    });
    expect(out.url).toBe("/api/book/offer/[redacted]/claim");
    expect(out.url).not.toContain(CLAIM);
  });

  it("masks all four token shapes", () => {
    const cases: [string, string, string][] = [
      [`/api/book/offer/${CLAIM}`, "/offer/:token", CLAIM],
      [`/api/book/manage/${MANAGE}/cancel`, "/manage/:token/cancel", MANAGE],
      [`/api/rewards/${MAGIC}/opt-out`, "/:magicToken/opt-out", MAGIC],
      [`/api/shops/s1/waitlist/cancel/${WAITLIST}`, "/waitlist/cancel/:token", WAITLIST],
    ];
    for (const [url, routePath, secret] of cases) {
      const out = redactedReqSerializer({ method: "POST", url, route: { path: routePath } });
      expect(out.url).not.toContain(secret);
      expect(out.url).toContain("[redacted]");
    }
  });

  it("masks even with NO route attached", () => {
    const out = redactedReqSerializer({ method: "GET", url: `/api/rewards/${MAGIC}` });
    expect(out.url).not.toContain(MAGIC);
  });

  it("emits method and url and nothing else - no headers, no cookies, no body", () => {
    const out = redactedReqSerializer({
      method: "GET",
      url: "/api/booking/appointments",
      headers: { cookie: "session=SECRETCOOKIE", authorization: "Bearer SECRETBEARER" },
      body: { password: "hunter2" },
    } as never);
    expect(Object.keys(out).sort()).toEqual(["method", "url"]);
    expect(JSON.stringify(out)).not.toContain("SECRETCOOKIE");
    expect(JSON.stringify(out)).not.toContain("SECRETBEARER");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });
});

describe("the error handler's own log call", () => {
  it("masks the token when a malformed body aborts BEFORE routing", async () => {
    // Real request, real handler. The body parser throws entity.parse.failed,
    // so req.route is undefined and only the prefix fallback can save it.
    const { logger } = await import("./logger.js");
    const { createApp } = await import("./app.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      await request(createApp())
        .post(`/api/book/manage/${MANAGE}/cancel`)
        .set("Content-Type", "application/json")
        .send("{not json");
      const call = warn.mock.calls.find((c) => String(c[1]).includes("unreadable request body"));
      expect(call, "expected the unreadable-body warning").toBeTruthy();
      const fields = call![0] as { path?: string };
      expect(fields.path).toBe("/api/book/manage/[redacted]/cancel");
      expect(JSON.stringify(fields)).not.toContain(MANAGE);
    } finally {
      warn.mockRestore();
    }
  });

  it("routes BOTH the log and the Sentry capture through the same masked value", () => {
    // 194 and 195 must not drift: one masked and one not is the same bug again.
    // 🔴 Scanned RAW, on purpose. A previous version stripped comments first
    // with a lazy /* */ regex, which swallowed two thirds of the file - 12664
    // characters down to 4686 - and made the assertions fail against code that
    // was plainly there. Stripping is not worth it: the patterns below are
    // specific enough that no prose matches them.
    const code = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
    expect(code).toMatch(/const safePath = maskUrl\(req\.path, req\.route\?\.path\);/);
    expect(code).toMatch(/logger\.error\(\{ err, path: safePath/);
    expect(code).toMatch(/captureError\(err, \{ path: safePath/);
    // And the unmasked value must never be handed to a log call again.
    expect(code).not.toMatch(/(?:logger\.(?:error|warn)|captureError)\([^)]*path: req\.path/);
  });
});

describe("the Acuity subscription error body", () => {
  it("does not republish the per-shop webhook secret", async () => {
    // Found by sweeping for what ELSE reaches stdout. We POST {event, target}
    // to Acuity, target ends in the shop's webhook secret, and Acuity's 4xx
    // bodies quote the request back - so logging the response verbatim
    // published that route's only authenticator.
    const { __redactSecretForTests } = await import("./acuity/webhookSubscription.js");
    const secret = "SHOPWEBHOOKSECRET1234";
    const echoed = `{"error":"bad target","target":"https://api.example/webhooks/acuity/${secret}"}`;
    const out = __redactSecretForTests(echoed, secret);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("also catches the URL-encoded form", async () => {
    const { __redactSecretForTests } = await import("./acuity/webhookSubscription.js");
    const secret = "a+b/c=";
    const out = __redactSecretForTests(`target=${encodeURIComponent(secret)}`, secret);
    expect(out).not.toContain(encodeURIComponent(secret));
  });
});
