import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  AUDIT_METADATA_KEYS,
  sanitizeAuditMetadata,
  type AuditMetadata,
} from "./waitlistAudit.js";
import { logger } from "../logger.js";

/**
 * The metadata guard, tested as the promise it is: NOTHING about a customer
 * reaches this table. A reviewer can miss a leaked key in a diff; these cannot.
 *
 * The guard drops rather than throws, on purpose - it runs inside booking and
 * join transactions and a metadata typo must never fail a customer's request -
 * so "it dropped the bad thing" is the assertion, not "it exploded".
 */

afterEach(() => vi.restoreAllMocks());

const sanitize = (m: AuditMetadata | Record<string, unknown>) =>
  sanitizeAuditMetadata(m as AuditMetadata) as Record<string, unknown> | undefined;

describe("metadata allowlist", () => {
  it("keeps the codes and counts an audit is made of", () => {
    expect(
      sanitize({ code: "slot_taken", fromStatus: "WAITING", windowCount: 3, pending: true }),
    ).toEqual({ code: "slot_taken", fromStatus: "WAITING", windowCount: 3, pending: true });
  });

  it("🔴 drops any key that is not on the list", () => {
    expect(sanitize({ code: "ok", firstName: "Marcus", note: "back door" })).toEqual({
      code: "ok",
    });
  });

  it("🔴 drops an email even under an allowlisted key", () => {
    // The key allowlist alone would let this through - the value guard is why
    // it does not.
    expect(sanitize({ code: "marcus@example.com" })).toBeUndefined();
  });

  it("🔴 drops a phone number even under an allowlisted key", () => {
    expect(sanitize({ outcome: "+12025550171" })).toBeUndefined();
    expect(sanitize({ outcome: "2025550171" })).toBeUndefined();
  });

  it("🔴 drops prose - a matcher `reason` names a customer's schedule", () => {
    const reason =
      "no window fits: [2026-08-25..2026-08-25 @ 09:00-12:00] slot date 2026-08-29 not in range";
    // Both the key AND the length rule refuse it.
    expect(sanitize({ reason })).toBeUndefined();
    expect(sanitize({ code: reason })).toBeUndefined();
  });

  it("drops objects and arrays - scalars only", () => {
    expect(sanitize({ code: "ok", metadata: { nested: 1 }, via: ["a"] })).toEqual({ code: "ok" });
  });

  it("keeps null and false, which are real values, and skips undefined", () => {
    expect(sanitize({ toStatus: null, linked: false, code: undefined })).toEqual({
      toStatus: null,
      linked: false,
    });
  });

  it("returns undefined rather than an empty object", () => {
    expect(sanitize({})).toBeUndefined();
    expect(sanitizeAuditMetadata(undefined)).toBeUndefined();
  });

  it("logs the dropped KEY and never the value", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation((() => {}) as never);
    sanitize({ phone: "+12025550171" });
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(warn.mock.calls[0]![0]);
    expect(payload).toContain("phone"); // the key name
    expect(payload).not.toContain("2025550171"); // never the value
  });
});

describe("the allowlist itself", () => {
  it("🔴 contains no key that names a person or a preference", () => {
    // A key can only leak what it is allowed to be called. This is the list a
    // future reader has to argue with before adding "phone" for convenience.
    const banned = [
      "phone",
      "email",
      "firstName",
      "lastName",
      "name",
      "note",
      "token",
      "tokenHash",
      "cancelToken",
      "cancelTokenHash",
      "claimToken",
      "reason",
      "body",
      "subject",
      "startDate",
      "startMin",
      "endMin",
      "windows",
      "preferredTime",
      "address",
      "to",
    ];
    for (const b of banned) {
      expect(AUDIT_METADATA_KEYS as readonly string[]).not.toContain(b);
    }
  });

  it("🔴 every metadata key used anywhere in the source is on the list", () => {
    // Catches the drift the sanitizer would otherwise swallow at runtime: a
    // call site passing `metadata: { entryPhone }` still compiles (the type is
    // Partial<Record<...>> and excess-property checks miss spread objects),
    // gets silently dropped in production, and nobody notices the event lost
    // its detail. Here it fails the build instead.
    const root = path.resolve(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(root);

    const allowed = new Set<string>(AUDIT_METADATA_KEYS);
    const offenders: string[] = [];
    let inspected = 0;

    /** The metadata object literal starting at `{`, by brace matching - so a
     *  conditional spread (`...(x ? { linked: false } : {})`) is included. */
    const objectAt = (src: string, open: number): string => {
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
      }
      return "";
    };

    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Scoped to OUR calls: `metadata:` is a common property name (Stripe
      // PaymentIntents use one), so a file-wide scan would flag unrelated code.
      for (const call of src.matchAll(/recordWaitlistEvent(?:BestEffort)?\(/g)) {
        const window = src.slice(call.index!, call.index! + 2000);
        const at = window.search(/\bmetadata:\s*\{/);
        if (at === -1) continue;
        inspected++;
        // Comments first: these blocks are heavily annotated, and prose like
        // "// Worth recording: ..." otherwise reads as a key named `recording`.
        const body = objectAt(window, window.indexOf("{", at))
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        for (const k of body.matchAll(/(?:^|[\s{(,])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
          const key = k[1]!;
          if (!allowed.has(key)) offenders.push(`${path.relative(root, f)}: ${key}`);
        }
      }
    }

    expect(offenders, `metadata keys outside the allowlist: ${offenders.join(", ")}`).toEqual([]);
    // A scan that silently matched nothing would pass forever. Every audit
    // call site that carries metadata must actually have been read.
    expect(inspected).toBeGreaterThanOrEqual(12);
  });
});
