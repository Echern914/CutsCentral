import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { bearerToken, credentialKey } from "../mcp/bearer.js";
import { logger } from "../logger.js";

/**
 * THE OUTER RATE LIMIT on the MCP endpoint.
 *
 * WHAT THIS FILE IS DEFENDING. As merged in #315, `/mcp` was limited only by a
 * key derived from the caller's own `Authorization` header - so a new header
 * value was a new bucket. Measured against the merged build: 300 unauthenticated
 * requests from ONE address with a rotating header produced ZERO 429s and 300
 * served requests, each performing a SHA-256 and an indexed database lookup. The
 * only limiter on a public, internet-facing endpoint provided no protection
 * against any adversary who varied one header.
 *
 * 🔴 THESE TESTS SET THEIR OWN LIMITS. `make()` in middleware/rateLimit.ts
 * raises every limit to 100000 under VITEST so suites are not throttled, which
 * would make a rate-limit test vacuous. Each case below therefore builds its own
 * limiter with a real limit rather than trusting the shared instances.
 */

const { publicIpKeyFor, rateLimitedHandler } = await import("../middleware/rateLimit.js").then(
  async (m) => ({
    publicIpKeyFor: (m as unknown as { publicIpKey: (r: unknown) => string }).publicIpKey,
    rateLimitedHandler: m.rateLimitedHandler,
  }),
);

/** A limiter with a REAL limit, built the way the app builds its own. */
async function limiterWithLimit(limit: number, keyGenerator: (req: never) => string) {
  const { default: rateLimit } = await import("express-rate-limit");
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyGenerator as never,
    handler: rateLimitedHandler("mcp-ip-test"),
  });
}

/** A minimal app with the SAME middleware ORDER the real app mounts. */
async function appWithOuterLimit(limit: number) {
  const { default: express } = await import("express");
  const { requireMcpAuth } = await import("../middleware/mcpAuth.js");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/mcp", await limiterWithLimit(limit, publicIpKeyFor as never), requireMcpAuth, (_req, res) =>
    res.json({ ok: true }),
  );
  return app;
}

/** Inferred rather than annotated: the Prisma delegate's signature is generic. */
const spyOnTokenLookup = () => vi.spyOn(prisma.mcpAccessToken, "findUnique");
/**
 * An app whose limiter uses the PRODUCTION credential key.
 *
 * 🔴 `credentialKey` is imported, never reimplemented. An earlier version of
 * this file hashed locally, which meant the tests would have stayed green if
 * production reverted to keying on the plaintext header - the exact regression
 * they exist to catch.
 */
async function appWithCredentialLimit(limit: number) {
  const { default: express } = await import("express");
  const { requireMcpAuth } = await import("../middleware/mcpAuth.js");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(
    "/mcp",
    await limiterWithLimit(limit, ((req: { header: (n: string) => string | undefined; ip?: string }) =>
      credentialKey(req.header("Authorization"), req.ip ?? "anon")) as never),
    requireMcpAuth,
    (_req, res) => res.json({ ok: true }),
  );
  return app;
}

let lookups: ReturnType<typeof spyOnTokenLookup>;

beforeAll(() => {
  // The spy is the point of case 2: a request the outer limiter rejects must
  // never reach the token store.
  lookups = spyOnTokenLookup();
});

afterEach(() => lookups.mockClear());
afterAll(() => {
  lookups.mockRestore();
});

describe("🔴 the outer IP limit actually bounds /mcp", () => {
  it("rotating the Authorization header does NOT create fresh buckets", async () => {
    const app = await appWithOuterLimit(10);
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await request(app)
        .post("/mcp")
        // A different credential every single request - the exact bypass.
        .set("Authorization", `Bearer rotating-${i}-${"a".repeat(30)}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      codes.push(res.status);
    }
    const limited = codes.filter((c) => c === 429).length;
    // Before the fix this was 0/25. The first 10 are answered (401, no token),
    // every one after is refused.
    expect(limited, `only ${limited} of 25 were limited`).toBe(15);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
  });

  it("🔴 a request the outer limiter rejects performs NO token lookup", async () => {
    const app = await appWithOuterLimit(3);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/mcp")
        .set("Authorization", `Bearer under-${i}-${"a".repeat(30)}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    }
    const afterAllowed = lookups.mock.calls.length;
    expect(afterAllowed, "allowed requests should reach the store").toBe(3);

    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/mcp")
        .set("Authorization", `Bearer over-${i}-${"a".repeat(30)}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.status).toBe(429);
    }
    // 🔴 THE ORDERING PROOF: ten rejected requests added zero lookups. The limit
    // runs before bearer hashing and before the database is touched.
    expect(lookups.mock.calls.length).toBe(afterAllowed);
  });

  it("the per-connection limiter still bounds a FIXED credential", async () => {
    const app = await appWithCredentialLimit(5);

    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post("/mcp")
        .set("Authorization", `Bearer fixed-credential-${"a".repeat(30)}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 429).length).toBe(7);
  });

  it("🔴 a forged forwarded header cannot mint fresh buckets", async () => {
    const app = await appWithOuterLimit(6);
    const codes: number[] = [];
    // PRODUCTION TOPOLOGY. `trust proxy: 1` means Express takes the LAST
    // X-Forwarded-For entry - the one appended by the single trusted hop in
    // front of the API - and ignores anything the caller prepended. Verified
    // directly: "10.0.0.9" alone -> req.ip 10.0.0.9, but
    // "10.0.0.9, 203.0.113.5" -> req.ip 203.0.113.5. So the real client address
    // is always appended last here, exactly as the platform proxy appends it.
    const REAL_CLIENT = "203.0.113.5";
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/mcp")
        .set("Authorization", `Bearer rot-${i}-${"a".repeat(30)}`)
        // Everything an attacker can invent, all at once.
        .set("X-Forwarded-For", `10.0.0.${i}, 10.1.1.${i}, ${REAL_CLIENT}`)
        .set("x-cb-client-ip", `10.2.2.${i}`)
        .set("x-cb-proxy-secret", `wrong-secret-${i}`)
        .set("X-Real-IP", `10.3.3.${i}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      codes.push(res.status);
    }
    // One bucket, because every request resolved to the same real address.
    expect(codes.filter((c) => c === 429).length).toBe(14);
  });

  it("🔴 x-cb-client-ip is honoured ONLY with the matching proxy secret", async () => {
    const prior = process.env.WEB_PROXY_SECRET;
    process.env.WEB_PROXY_SECRET = "the-real-proxy-secret";
    try {
      const app = await appWithOuterLimit(6);
      const codes: number[] = [];
      for (let i = 0; i < 20; i++) {
        const res = await request(app)
          .post("/mcp")
          .set("Authorization", `Bearer rot-${i}-${"a".repeat(30)}`)
          // A forwarded IP WITHOUT the secret, and with a wrong one. Neither is
          // trusted, so both fall back to the real address and share a bucket.
          .set("x-cb-client-ip", `10.9.9.${i}`)
          .set("x-cb-proxy-secret", i % 2 === 0 ? "" : `guessed-${i}`)
          .set("X-Forwarded-For", "203.0.113.7")
          .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        codes.push(res.status);
      }
      expect(codes.filter((c) => c === 429).length).toBe(14);
    } finally {
      if (prior === undefined) delete process.env.WEB_PROXY_SECRET;
      else process.env.WEB_PROXY_SECRET = prior;
    }
  });

  it("the 429 body keeps its shape and carries retry metadata", async () => {
    const app = await appWithOuterLimit(1);
    await request(app).post("/mcp").set("Authorization", "Bearer a".padEnd(40, "a")).send({});
    const res = await request(app).post("/mcp").set("Authorization", "Bearer b".padEnd(40, "b")).send({});
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "rate_limited" });
    // standardHeaders: clients need to know when to come back.
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-reset"]).toBeDefined();
  });
});

describe("🔴 no bearer value is ever kept or emitted", () => {
  it("the PRODUCTION key is a hash, and never contains the credential", () => {
    const token = "super-secret-token-value-do-not-store";
    const key = credentialKey(`Bearer ${token}`, "1.2.3.4");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain(token);
    expect(key).not.toContain("super-secret");
    // 🔴 The key is PERSISTED (PgRateStore writes it to rate_limit_counter), so
    // a plaintext key put live bearer tokens in a table meant to hold none -
    // undoing the reason McpAccessToken stores sha256 in the first place.
    expect(key).not.toContain("Bearer");
  });

  it("🔴 equivalent valid header forms map to ONE bucket", () => {
    // Authentication trims the captured token, so all of these authenticate as
    // the SAME credential. While the limiter hashed the raw header they landed
    // in different buckets, and the 120/min per-connection limit was bypassable
    // by re-spacing the header.
    const token = "tok-".padEnd(43, "x");
    const forms = [
      `Bearer ${token}`,
      `Bearer  ${token}`,
      `Bearer   ${token}   `,
      `bearer ${token}`,
      `BEARER ${token}`,
      ` Bearer ${token}`,
      `Bearer	${token}`,
    ];
    const keys = new Set(forms.map((h) => credentialKey(h, "1.2.3.4")));
    expect(keys.size, `forms produced ${keys.size} buckets: ${[...keys].join(", ")}`).toBe(1);
  });

  it("a malformed credential falls back to an ADDRESS-scoped key", () => {
    // Not to a per-request one: a flood of junk headers from one host must share
    // a bucket and stay bounded by the outer IP limiter.
    const bad = ["", "Basic abc", "Bearer", "Bearer   ", "token abc", undefined];
    const keys = new Set(bad.map((h) => credentialKey(h, "9.9.9.9")));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("ip:9.9.9.9");
  });

  it("🔴 the shared extractor is what authentication uses, byte for byte", () => {
    // One function, so "what we authenticate as" and "what we count as" cannot
    // drift apart again.
    const token = "abc-".padEnd(43, "y");
    expect(bearerToken(`Bearer  ${token}  `)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Basic xyz")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("a 429 log line carries no credential", async () => {
    const warns: unknown[] = [];
    const spy = vi.spyOn(logger, "warn").mockImplementation(((obj: unknown) => {
      warns.push(obj);
      return logger;
    }) as never);
    const app = await appWithOuterLimit(1);
    const secret = `Bearer leak-canary-${"z".repeat(30)}`;
    await request(app).post("/mcp").set("Authorization", secret).send({});
    await request(app).post("/mcp").set("Authorization", secret).send({});
    spy.mockRestore();

    const blob = JSON.stringify(warns);
    expect(warns.length).toBeGreaterThan(0);
    expect(blob).not.toContain("leak-canary");
    expect(blob.toLowerCase()).not.toContain("authorization");
  });
});
