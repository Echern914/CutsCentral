import { describe, expect, it } from "vitest";
import {
  keysetAfter,
  scanCursorFrom,
  scanOrderBy,
  SCAN_ORDER,
  type ScanField,
  type ScanKeyPart,
} from "./waitlistScanOrder.js";

/**
 * The keyset predicate, proved WITHOUT a database.
 *
 * The whole point of this module is that the ORDER BY and the "resume after
 * here" WHERE cannot drift apart, because a drift does not throw - it just
 * quietly stops visiting some of the queue. So the tests are about the two
 * staying in step, and about the predicate meaning exactly what the sort
 * means:
 *
 *   a row matches keysetAfter(cursor)  <=>  that row sorts strictly after it
 *
 * proved below over a list with heavy ties, every row taken as the cursor in
 * turn. waitlistOffer.test.ts then walks a real multi-page scan and checks
 * the ids that come back; this file checks the algebra underneath it.
 */

const D = (ms: number): Date => new Date(1_800_000_000_000 + ms);

/* ------------------------------------------------------------------ */
/* A tiny evaluator, so the predicate can be checked against the sort   */
/* ------------------------------------------------------------------ */

type Row = { createdAt: Date; id: string };
type Clause = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Sort key order == SCAN_ORDER, read off the row. */
function rank(a: Row, b: Row): number {
  for (const part of SCAN_ORDER) {
    const c = cmp(scanValue(a, part), scanValue(b, part));
    if (c !== 0) return c;
  }
  return 0;
}

function scanValue(row: Row, field: ScanField): unknown {
  return field === "createdAt" ? row.createdAt : row.id;
}

/** Evaluate the { OR: [ … ] } shape keysetAfter returns, against a row. */
function matches(where: { OR?: unknown }, row: Row): boolean {
  const arms = (where.OR ?? []) as Clause[];
  return arms.some((arm) =>
    Object.entries(arm).every(([field, spec]) => {
      const actual = scanValue(row, field as ScanField);
      if (spec !== null && typeof spec === "object" && "gt" in (spec as object)) {
        return cmp(actual, (spec as { gt: unknown }).gt) > 0;
      }
      return cmp(actual, spec) === 0;
    }),
  );
}

/* ------------------------------------------------------------------ */

describe("the scan's ranking", () => {
  it("is (createdAt, id) - the order the waitlist has always used", () => {
    expect([...SCAN_ORDER]).toEqual(["createdAt", "id"]);
    expect(scanOrderBy()).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("🔴 the ORDER BY and the cursor read the SAME columns in the SAME order", () => {
    // The drift alarm. These two are generated from one list precisely so
    // they cannot disagree; this fails the moment somebody teaches one of
    // them about a column and forgets the other.
    const orderByFields = scanOrderBy().map((o) => Object.keys(o)[0]);
    const cursorFields = scanCursorFrom({ createdAt: D(0), id: "a" }).map((p) => p.field);
    expect(orderByFields).toEqual([...SCAN_ORDER]);
    expect(cursorFields).toEqual([...SCAN_ORDER]);
  });

  it("every ORDER BY component is ASCENDING", () => {
    // Descending is not wrong in itself, but keysetAfter emits `gt` for every
    // component. A `desc` here would need `lt` and silently gets `gt`.
    for (const o of scanOrderBy()) {
      expect(Object.values(o)).toEqual(["asc"]);
    }
  });
});

describe("keysetAfter", () => {
  it("expands (createdAt, id) into exactly the predicate the scan used before", () => {
    const at = D(5_000);
    expect(keysetAfter(scanCursorFrom({ createdAt: at, id: "e7" }))).toEqual({
      OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: "e7" } }],
    });
  });

  it("one arm per component: arm i is equal on the i more significant keys", () => {
    // Three components, to pre-prove the shape a tier prepend produces. The
    // cast is the test reaching past the union on purpose - the module's own
    // switches are what keep production honest about which columns exist.
    const key: ScanKeyPart[] = [
      { field: "tierRank" as ScanField, value: 0 },
      { field: "createdAt", value: D(1) },
      { field: "id", value: "z" },
    ];
    expect(keysetAfter(key)).toEqual({
      OR: [
        { tierRank: { gt: 0 } },
        { tierRank: 0, createdAt: { gt: D(1) } },
        { tierRank: 0, createdAt: D(1), id: { gt: "z" } },
      ],
    });
  });

  it("🔴 refuses a null component instead of emitting a predicate that hides rows", () => {
    // column > NULL is NULL, not true: a nullable ranking column does not
    // reorder the queue, it deletes the tail of it. Loud beats silent.
    const key: ScanKeyPart[] = [
      { field: "tierRank" as ScanField, value: null },
      { field: "id", value: "z" },
    ];
    expect(() => keysetAfter(key)).toThrow(/null/i);
    expect(() => keysetAfter([{ field: "id", value: undefined }])).toThrow(/null/i);
  });

  it("an empty key matches nothing (an OR of no arms) - a scan never starts with one", () => {
    expect(keysetAfter([])).toEqual({ OR: [] });
  });
});

describe("🔴 the predicate means exactly what the sort means", () => {
  // 240 rows, ties everywhere: groups of 8 share an instant, so page
  // boundaries in the real scan land INSIDE a tie group and the (equal,
  // greater-on-id) arm is what has to carry the walk.
  const rows: Row[] = Array.from({ length: 240 }, (_, i) => ({
    // Ids deliberately NOT in insertion order - (i * 97) mod 240 is a
    // permutation, so the id tie-break has to actually do something.
    id: `e${String((i * 97) % 240).padStart(3, "0")}`,
    createdAt: D(Math.floor(i / 8) * 1000),
  }));
  const sorted = [...rows].sort(rank);

  it("matches the strict suffix, for every row taken as the cursor", () => {
    for (let i = 0; i < sorted.length; i += 1) {
      const cursor = scanCursorFrom(sorted[i]!);
      const where = keysetAfter(cursor);
      const matched = sorted.filter((r) => matches(where, r));
      // Everything after i, nothing at or before i. No skips (the count is
      // exact), no repeats (identities compared, not just the length), and
      // never the cursor row itself - STRICTLY after.
      expect(matched.map((r) => r.id)).toEqual(sorted.slice(i + 1).map((r) => r.id));
    }
  });

  it("the union of one page and its remainder is the whole list, always", () => {
    // The actual scan invariant, stated directly: take any page boundary,
    // and page + what the cursor lets through must be the list, exactly once
    // each.
    for (const size of [1, 7, 50, 239]) {
      const page = sorted.slice(0, size);
      const rest = sorted.filter((r) => matches(keysetAfter(scanCursorFrom(page[size - 1]!)), r));
      const seen = [...page, ...rest].map((r) => r.id);
      expect(new Set(seen).size).toBe(sorted.length);
      expect(seen).toEqual(sorted.map((r) => r.id));
    }
  });
});
