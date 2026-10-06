import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEnvCacheForTests } from "@chairback/config";

/**
 * SENTRY IS FLUSHED BEFORE THE PROCESS EXITS.
 *
 * Events go out in the background, so `process.exit` right after one is
 * raised can lose it. Railway sends SIGTERM on every deploy, and the
 * reconciler raises each contradiction only ONCE now (#464) - a lost event is
 * no longer repeated on the next pass. And the uncaught-exception handler
 * exited at once, dropping exactly the event that mattered most.
 */

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async (_timeout?: number) => true),
}));
vi.mock("@sentry/node", () => sdk);

const savedDsn = process.env.SENTRY_DSN;

beforeEach(() => {
  sdk.flush.mockReset();
  sdk.flush.mockResolvedValue(true);
});

afterAll(() => {
  if (savedDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = savedDsn;
  __resetEnvCacheForTests();
});

describe("flushSentry", () => {
  it("with Sentry off, does nothing and says so", async () => {
    const { flushSentry } = await import("./sentry.js");
    expect(await flushSentry()).toBe(false);
    expect(sdk.flush).not.toHaveBeenCalled();
  });

  it("with Sentry on, sends what is queued, bounded by the timeout - and never throws", async () => {
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/0";
    __resetEnvCacheForTests();
    const { initSentry, flushSentry } = await import("./sentry.js");
    initSentry();
    expect(await flushSentry(1234)).toBe(true);
    expect(sdk.flush).toHaveBeenCalledWith(1234);

    sdk.flush.mockRejectedValueOnce(new Error("network down"));
    expect(await flushSentry()).toBe(false);
  });
});

describe("🔴 every exit path flushes first (index.ts)", () => {
  // index.ts starts the server on import, so its handlers are pinned by source.
  const src = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");

  it("shutdown (SIGTERM on every deploy) awaits the flush before exiting", () => {
    const body = src.slice(src.indexOf("async function shutdown"), src.indexOf("process.on(\"SIGTERM\""));
    expect(body.indexOf("await flushSentry(")).toBeGreaterThan(-1);
    expect(body.indexOf("await flushSentry(")).toBeLessThan(body.indexOf("process.exit(0)"));
  });

  it("an uncaught exception exits only after the flush settles", () => {
    const start = src.indexOf("process.on(\"uncaughtException\"");
    const body = src.slice(start, src.indexOf("});", start));
    expect(body).toMatch(/flushSentry\(\)\.finally\(\(\) => process\.exit\(1\)\)/);
    // No bare exit that races the flush.
    expect(body.replace(/flushSentry\(\)\.finally\(\(\) => process\.exit\(1\)\)/, "")).not.toMatch(/process\.exit\(/);
  });
});
