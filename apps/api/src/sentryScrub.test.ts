import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const captureError = vi.hoisted(() => vi.fn());
vi.mock("./sentry.js", async (orig) => {
  // Partial mock: the real scrubber under test, a spy where the app reports.
  const actual = await orig<typeof import("./sentry.js")>();
  return { ...actual, captureError };
});

import { scrubSentryEvent } from "./sentry.js";
import { createApp } from "./app.js";

/**
 * SENTRY IS A SINK, EXACTLY LIKE STDOUT.
 *
 * #297/#298 taught the log stream not to carry credentials. Sentry's SDK
 * attaches the incoming request to an event on its own - URL, query string,
 * headers, sometimes the body - so without a scrubber, turning the DSN on
 * would re-open every leak those two PRs closed, into a sink with a longer
 * memory. scrubSentryEvent runs as beforeSend and reuses logRedaction's
 * patterns, so there is one redaction rule for both sinks.
 */

const SECRET = "SUPERSECRETTOKENVALUE";

describe("scrubSentryEvent", () => {
  it("🔴 redacts a tokenized request URL with the same rule as the log stream", () => {
    const event = scrubSentryEvent({
      request: { url: `https://api.chairback.app/api/book/offer/${SECRET}/claim` },
    });
    expect(event.request!.url).not.toContain(SECRET);
    expect(event.request!.url).toContain("/api/book/offer/[redacted]/claim");
  });

  it("masks the query string, which travels as its own field", () => {
    const event = scrubSentryEvent({
      request: { url: "/api/team/join/preview", query_string: `token=${SECRET}&x=1` },
    });
    expect(String(event.request!.query_string)).not.toContain(SECRET);
    expect(String(event.request!.query_string)).toContain("x=1");
  });

  it("drops a query string it cannot read rather than guessing", () => {
    const event = scrubSentryEvent({
      request: { url: "/x", query_string: [["token", SECRET]] },
    });
    expect(event.request).not.toHaveProperty("query_string");
  });

  it("🔴 deletes the body outright - a login body is a password", () => {
    const event = scrubSentryEvent({
      request: { url: "/api/auth/login", data: '{"email":"a@b.co","password":"hunter2"}' },
    });
    expect(event.request).not.toHaveProperty("data");
  });

  it("deletes cookies and the credential headers, case-insensitively; ordinary headers survive", () => {
    const event = scrubSentryEvent({
      request: {
        url: "/x",
        cookies: { cb_session: SECRET },
        headers: {
          Cookie: `cb_session=${SECRET}`,
          Authorization: "Bearer ABC",
          "content-type": "application/json",
          "user-agent": "test",
        },
      },
    });
    expect(event.request).not.toHaveProperty("cookies");
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(JSON.stringify(event)).not.toContain("Bearer ABC");
    expect(event.request!.headers).toHaveProperty("content-type");
    expect(event.request!.headers).toHaveProperty("user-agent");
  });

  it("redacts breadcrumb URLs - outgoing calls get the same rule", () => {
    const event = scrubSentryEvent({
      breadcrumbs: [
        { data: { url: `https://api.chairback.app/api/rewards/${SECRET}` } },
        { data: { method: "GET" } },
        {},
      ],
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(event.breadcrumbs![0]!.data!.url).toContain("/api/rewards/[redacted]");
  });

  it("an event with no request and no breadcrumbs passes through untouched", () => {
    const event: { message: string; request?: { url?: string } } = { message: "hello" };
    expect(scrubSentryEvent(event)).toBe(event);
    expect(event).toEqual({ message: "hello" });
  });
});

describe("🔴 the silent failure paths report, not just log", () => {
  it("receptionist tool-throw and scheduler job-failure both call captureError", () => {
    // Structural, like the sink guards in logRedaction.test.ts: these two
    // catches are the ONLY visibility their failures have - no request, no
    // 500, no user-facing error. The unmapped-chair outage lived in the
    // first one for exactly that reason. A captureError that quietly
    // disappears in a refactor recreates it.
    const agent = readFileSync(new URL("./receptionist/agent.ts", import.meta.url), "utf8");
    expect(agent).toMatch(/receptionist tool threw[\s\S]{0,400}captureError\(err, \{ tool: call\.name \}\)/);
    const scheduler = readFileSync(new URL("./scheduler.ts", import.meta.url), "utf8");
    expect(scheduler).toMatch(/logger\.error\(\{ err \}, job\.failMsg\);\s*\n\s*captureError\(err, \{ job: job\.name \}\)/);
  });

  it("initSentry wires the scrubber as beforeSend and pins sendDefaultPii off", () => {
    const src = readFileSync(new URL("./sentry.ts", import.meta.url), "utf8");
    expect(src).toMatch(/beforeSend: \(event\) => scrubSentryEvent\(event\)/);
    expect(src).toMatch(/sendDefaultPii: false/);
  });
});

describe("the on-demand Sentry probe", () => {
  it("🔴 GET /api/book/%zz is a harmless, reliable 500 that reaches captureError", async () => {
    // The way to confirm Sentry is receiving WITHOUT a debug route: a
    // malformed percent-encoding dies in Express's route-param decoding -
    // before any handler, any auth, any database work - and lands in the
    // final error handler, which reports. Nothing is read, nothing is
    // written, nobody's data is involved. If this test's contract ever
    // breaks (an Express upgrade answering 400 itself), the production
    // probe recipe breaks with it, and this is what says so.
    captureError.mockClear();
    const res = await request(createApp()).get("/api/book/%zz");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal" });
    expect(captureError).toHaveBeenCalledTimes(1);
    // And what it reports carries the redacted path shape, not a secret.
    const extra = captureError.mock.calls[0]![1] as { path: string };
    expect(extra.path).toContain("/api/book/");
  });
});
