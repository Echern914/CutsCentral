import { describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  hashToken,
  isValidVerifier,
  mintSecret,
  pkceS256,
  safeEqual,
} from "./tokens.js";
import { ALL_SCOPES, DEFAULT_SCOPES, READ_SCOPES, WRITE_SCOPES, parseScopes } from "@chairback/config/mcpScopes";

/**
 * The token primitives, without a request in the way.
 *
 * mcp.oauth.test.ts proves the FLOW. This file proves the pieces the flow is
 * built from behave the way the RFCs say - including against the specs' own
 * published test vectors, so "we match the standard" is checked rather than
 * asserted.
 */

describe("PKCE (RFC 7636)", () => {
  /**
   * 🔴 THE SPEC'S OWN TEST VECTOR, from RFC 7636 Appendix B. This is the one
   * assertion in the suite that cannot pass by accident: if our S256 transform
   * disagreed with the RFC by so much as an encoding choice, every real client
   * would fail PKCE and the only symptom would be "connecting doesn't work".
   */
  it("matches the RFC's published verifier/challenge pair", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(pkceS256(verifier)).toBe(challenge);
  });

  it("produces base64url — no padding, no + or /", () => {
    for (let i = 0; i < 50; i++) {
      const c = pkceS256(mintSecret());
      expect(c).toMatch(/^[A-Za-z0-9\-_]+$/);
      expect(c).not.toContain("=");
    }
  });

  it("a different verifier never produces the same challenge", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(pkceS256(mintSecret()));
    expect(seen.size).toBe(200);
  });

  it("enforces the RFC's 43-128 character verifier range", () => {
    expect(isValidVerifier("a".repeat(42))).toBe(false);
    expect(isValidVerifier("a".repeat(43))).toBe(true);
    expect(isValidVerifier("a".repeat(128))).toBe(true);
    expect(isValidVerifier("a".repeat(129))).toBe(false);
    // Only the unreserved set.
    expect(isValidVerifier(`${"a".repeat(42)}+`)).toBe(false);
    expect(isValidVerifier(`${"a".repeat(42)}/`)).toBe(false);
    expect(isValidVerifier(`${"a".repeat(42)}=`)).toBe(false);
    expect(isValidVerifier(`${"a".repeat(42)} `)).toBe(false);
    expect(isValidVerifier(`${"a".repeat(39)}-._~`)).toBe(true);
  });

  it("a token this server mints is always an acceptable verifier", () => {
    // A client that uses our own generator must not be rejected by our own
    // length rule - 32 random bytes is 43 base64url chars, exactly the minimum.
    for (let i = 0; i < 20; i++) expect(isValidVerifier(mintSecret())).toBe(true);
  });
});

describe("hashing and secrets", () => {
  it("hashToken is sha256 hex, and never the input", () => {
    const t = mintSecret();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(t);
  });

  it("is stable, so a lookup finds the row it stored", () => {
    const t = mintSecret();
    expect(hashToken(t)).toBe(hashToken(t));
  });

  it("🔴 mints unguessable, non-colliding secrets", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(mintSecret());
    expect(seen.size).toBe(2000);
    // 32 bytes -> 43 base64url characters. A shorter token would be the kind of
    // change nothing else would notice.
    expect(mintSecret()).toHaveLength(43);
  });

  it("safeEqual compares correctly, including the length-mismatch case", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    // Must not throw on differing lengths (timingSafeEqual does).
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("a", "")).toBe(false);
  });
});

describe("lifetimes", () => {
  it("🔴 an access token is short, a refresh token is long, a code is seconds", () => {
    expect(AUTH_CODE_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(ACCESS_TOKEN_TTL_MS).toBeLessThanOrEqual(60 * 60_000);
    expect(ACCESS_TOKEN_TTL_MS).toBeGreaterThan(AUTH_CODE_TTL_MS);
    expect(REFRESH_TOKEN_TTL_MS).toBeGreaterThan(ACCESS_TOKEN_TTL_MS);
    // A refresh token that outlived a quarter would be a credential nobody
    // remembers issuing.
    expect(REFRESH_TOKEN_TTL_MS).toBeLessThanOrEqual(90 * 24 * 60 * 60_000);
  });
});

describe("🔴 scopes — the read-only guarantee", () => {
  it("no write scope exists in this release", () => {
    // Load-bearing empty array, not a placeholder. The write PR adds the
    // confirmation flow FIRST and only then the scopes that need it.
    expect(WRITE_SCOPES).toEqual([]);
    expect(ALL_SCOPES).toEqual([...READ_SCOPES]);
    for (const s of ALL_SCOPES) expect(s).toMatch(/:read$/);
  });

  it("the default grant carries no customer data", () => {
    expect(DEFAULT_SCOPES).toEqual(["chairback:help:read", "chairback:readiness:read"]);
    // Anything that could name a person must be asked for explicitly, so it
    // appears on the consent screen.
    expect(DEFAULT_SCOPES).not.toContain("chairback:clients:read");
    expect(DEFAULT_SCOPES).not.toContain("chairback:calendar:read");
  });

  it("🔴 an unknown scope is an error, never silently dropped", () => {
    const r = parseScopes("chairback:help:read chairback:nonsense:read");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.unknown).toEqual(["chairback:nonsense:read"]);
  });

  it("returns scopes in canonical order, not the caller's", () => {
    const r = parseScopes("chairback:clients:read chairback:help:read");
    expect(r.ok).toBe(true);
    // The consent screen and the stored grant must always read the same way.
    expect(r.ok && r.scopes).toEqual(["chairback:help:read", "chairback:clients:read"]);
  });

  it("de-duplicates a repeated scope", () => {
    const r = parseScopes("chairback:help:read chairback:help:read");
    expect(r.ok && r.scopes).toEqual(["chairback:help:read"]);
  });

  it("an empty or absent scope falls back to the default, not to everything", () => {
    for (const raw of [undefined, "", "   "]) {
      const r = parseScopes(raw);
      expect(r.ok && r.scopes).toEqual([...DEFAULT_SCOPES]);
    }
  });

  it("every scope has consent-screen copy", async () => {
    const { SCOPE_LABELS } = await import("@chairback/config/mcpScopes");
    for (const s of ALL_SCOPES) {
      expect(SCOPE_LABELS[s], `${s} has no label`).toBeTruthy();
      // The label is what a human reads before granting; the raw scope string
      // is not an explanation.
      expect(SCOPE_LABELS[s]).not.toBe(s);
    }
  });
});

/**
 * 🔴 ROW-LEVEL SECURITY on the token tables.
 *
 * These six tables are DEFAULT-DENY for `chairback_app` - RLS enabled, forced,
 * and with no policy and no grant. That is stronger than the tenant-isolation
 * policy the domain tables use, and it is necessary rather than belt-and-braces:
 * resolving a bearer token is how a shop is DISCOVERED, so the lookup runs
 * before any shop context exists and a `shopId = current_shop_id()` policy would
 * make every token unresolvable. (That is the same trap that made FORCE RLS on
 * SquareConnection break the Square webhook.)
 *
 * The consequence worth testing: nothing running inside a tenant transaction can
 * read a token hash, however confused it gets about which shop it is in.
 */
describe("🔴 RLS — the token tables are invisible to the tenant role", () => {
  const TOKEN_TABLES = [
    "McpClient",
    "McpAuthCode",
    "McpConnection",
    "McpAccessToken",
    "McpRefreshToken",
    "McpToolGrant",
  ];

  it("every token table has RLS enabled AND forced", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'Mcp%'`,
    );
    const byName = new Map(rows.map((r) => [r.relname, r]));
    for (const t of [...TOKEN_TABLES, "McpAuditEvent"]) {
      const row = byName.get(t);
      expect(row, `${t} is missing`).toBeDefined();
      expect(row!.relrowsecurity, `${t} RLS not enabled`).toBe(true);
      // FORCE matters: without it the table OWNER bypasses its own policy.
      expect(row!.relforcerowsecurity, `${t} RLS not forced`).toBe(true);
    }
  });

  it("🔴 the tenant role cannot SELECT a token table at all", async () => {
    const rows = await prisma.$queryRawUnsafe<{ relname: string; can: boolean }[]>(
      `SELECT c.relname,
              COALESCE(has_table_privilege('chairback_app', c.oid, 'SELECT'), false) AS can
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'Mcp%'`,
    );
    const byName = new Map(rows.map((r) => [r.relname, r.can]));
    for (const t of TOKEN_TABLES) {
      expect(byName.get(t), `${t} is readable by chairback_app`).toBe(false);
    }
    // The audit table IS an ordinary tenant table and must stay readable.
    expect(byName.get("McpAuditEvent")).toBe(true);
  });

  it("the token tables carry no policy, which is what makes them default-deny", async () => {
    const rows = await prisma.$queryRawUnsafe<{ tablename: string; n: bigint }[]>(
      `SELECT tablename, count(*) AS n FROM pg_policies
        WHERE schemaname = 'public' AND tablename LIKE 'Mcp%'
        GROUP BY tablename`,
    );
    const byName = new Map(rows.map((r) => [r.tablename, Number(r.n)]));
    for (const t of TOKEN_TABLES) {
      expect(byName.get(t) ?? 0, `${t} unexpectedly has a policy`).toBe(0);
    }
    // And the audit table has exactly the tenant-isolation policy.
    expect(byName.get("McpAuditEvent")).toBe(1);
  });
});
