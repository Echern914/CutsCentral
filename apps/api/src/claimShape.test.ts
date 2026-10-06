import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 🔴 NO CLAIM MAY BE `WHERE "id" IN (SELECT ... LIMIT n ... FOR UPDATE ...)`.
 *
 * Under a nested-loop plan PostgreSQL re-runs that locked sub-select for every
 * outer row, and each re-run skips the rows the UPDATE already changed - so it
 * claims past its LIMIT (#445; reproduced and pinned in
 * engines/claimLimit.test.ts). Whether it happens depends on table statistics,
 * which is exactly why it surfaced as a flake nobody could pin down.
 *
 * The safe shapes run the locked sub-select once: a MATERIALIZED CTE (what
 * every claim here uses), or `= ANY(ARRAY(SELECT ...))`. This test scans the
 * API source for the unsafe one, so a new outbox cannot reintroduce it.
 */

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** The text inside the parentheses that open at `open` (exclusive), or null if unbalanced. */
function balanced(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** TypeScript comments removed (they quote the old shape to explain it). URLs keep their `//`. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every `IN ( ... )` in code whose body both LIMITs and locks rows: the over-claiming shape. */
function unsafeClaims(raw: string): string[] {
  const src = stripComments(raw);
  const hits: string[] = [];
  for (const m of src.matchAll(/\bIN\s*\(/gi)) {
    const body = balanced(src, m.index! + m[0].length - 1);
    if (body && /\bLIMIT\b/i.test(body) && /\bFOR\s+UPDATE\b/i.test(body)) {
      hits.push(body.replace(/\s+/g, " ").trim().slice(0, 120));
    }
  }
  return hits;
}

describe("claim shape (#445)", () => {
  it("the detector flags the over-claiming shape and passes the safe ones", () => {
    expect(
      unsafeClaims(`UPDATE "X" SET a = 1 WHERE "id" IN (
        SELECT "id" FROM "X" WHERE s = 'P' ORDER BY c LIMIT \${batch} FOR UPDATE SKIP LOCKED) RETURNING "id"`),
    ).toHaveLength(1);
    expect(
      unsafeClaims(`WITH due AS MATERIALIZED (SELECT "id" FROM "X" LIMIT 5 FOR UPDATE SKIP LOCKED)
        UPDATE "X" t SET a = 1 FROM due WHERE t."id" = due."id"`),
    ).toHaveLength(0);
    // A lock with no LIMIT takes every row anyway, so a re-run changes nothing.
    expect(unsafeClaims(`WHERE "id" IN (SELECT "id" FROM "X" WHERE r = 1 FOR UPDATE SKIP LOCKED)`)).toHaveLength(0);
    // A plain IN list is not a sub-select.
    expect(unsafeClaims(`AND b."status" IN ('QUEUED', 'SENDING')`)).toHaveLength(0);
    // A comment explaining the old shape is not the old shape...
    expect(unsafeClaims(`// as \`WHERE "id" IN (... LIMIT n FOR UPDATE SKIP LOCKED)\` it over-claims`)).toHaveLength(0);
    expect(unsafeClaims(`/* WHERE "id" IN (SELECT 1 LIMIT 1 FOR UPDATE) */ const x = 1;`)).toHaveLength(0);
    // ...but code after a comment still is.
    expect(
      unsafeClaims(`// a note\nconst q = sql\`UPDATE t SET a = 1 WHERE "id" IN (SELECT "id" FROM t LIMIT 1 FOR UPDATE)\`;`),
    ).toHaveLength(1);
  });

  it("🔴 no source file in the API claims with `IN (... LIMIT ... FOR UPDATE)`", () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const hit of unsafeClaims(readFileSync(file, "utf8"))) {
        found.push(`${relative(SRC, file)}: ${hit}`);
      }
    }
    expect(found).toEqual([]);
  });
});
