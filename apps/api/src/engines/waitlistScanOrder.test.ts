import { describe, expect, it } from "vitest";
import {
  keysetAfter,
  scanCursorFrom,
  scanOrderBy,
  SCAN_ORDER,
  type ScanField,
  type ScanKeyPart,
} from "./waitlistScanOrder.js";
import { RANK_GOLD, RANK_NONE, RANK_SILVER } from "./waitlistTierRank.js";

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
 * proved below over a list with heavy ties on BOTH ranked columns, every row
 * taken as the cursor in turn. waitlistOffer.test.ts then walks a real
 * multi-page scan and checks the ids that come back; this file checks the
 * algebra underneath it.
 */

const D = (ms: number): Date => new Date(1_800_000_000_000 + ms);

/* ------------------------------------------------------------------ */
/* A tiny evaluator, so the predicate can be checked against the sort   */
/* ------------------------------------------------------------------ */

type Row = { tierRank: number; createdAt: Date; id: string };
type Clause = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

function scanValue(row: Row, field: ScanField): unknown {
  switch (field) {
    case "tierRank":
      return row.tierRank;
    case "createdAt":
      return row.createdAt;
    case "id":
      return row.id;
  }
}

/** Sort key order == SCAN_ORDER, read off the row. */
function rank(a: Row, b: Row): number {
  for (const part of SCAN_ORDER) {
    const c = cmp(scanValue(a, part), scanValue(b, part));
    if (c !== 0) return c;
  }
  return 0;
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
  it("is (tierRank, createdAt, id) - loyalty first, then the queue it always was", () => {
    expect([...SCAN_ORDER]).toEqual(["tierRank", "createdAt", "id"]);
    expect(scanOrderBy()).toEqual([{ tierRank: "asc" }, { createdAt: "asc" }, { id: "asc" }]);
  });

  it("🔴 Gold sorts to the FRONT, which means Gold carries the smallest number", () => {
    // Every component is ascending (asserted below), so "Gold first" is a fact
    // about the numbers, not about the query. If the ranks were ever
    // renumbered the wrong way round, this is what catches it.
    expect(RANK_GOLD).toBeLessThan(RANK_SILVER);
    expect(RANK_SILVER).toBeLessThan(RANK_NONE);
  });

  it("🔴 the ORDER BY and the cursor read the SAME columns in the SAME order", () => {
    // The drift alarm. These two are generated from one list precisely so
    // they cannot disagree; this fails the moment somebody teaches one of
    // them about a column and forgets the other.
    const orderByFields = scanOrderBy().map((o) => Object.keys(o)[0]);
    const cursorFields = scanCursorFrom({ tierRank: RANK_NONE, createdAt: D(0), id: "a" }).map(
      (p) => p.field,
    );
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
  it("expands (tierRank, createdAt, id) into one arm per component", () => {
    const at = D(5_000);
    expect(keysetAfter(scanCursorFrom({ tierRank: RANK_GOLD, createdAt: at, id: "e7" }))).toEqual({
      OR: [
        { tierRank: { gt: RANK_GOLD } },
        { tierRank: RANK_GOLD, createdAt: { gt: at } },
        { tierRank: RANK_GOLD, createdAt: at, id: { gt: "e7" } },
      ],
    });
  });

  it("arm i is equal on the i more significant keys, and greater on the i-th", () => {
    const key = scanCursorFrom({ tierRank: RANK_SILVER, createdAt: D(1), id: "z" });
    const arms = (keysetAfter(key).OR ?? []) as Clause[];
    expect(arms).toHaveLength(SCAN_ORDER.length);
    arms.forEach((arm, i) => {
      const fields = Object.keys(arm);
      expect(fields).toEqual([...SCAN_ORDER].slice(0, i + 1));
      // Everything before position i is an equality; position i is the `gt`.
      fields.slice(0, i).forEach((f) => expect(arm[f]).not.toHaveProperty("gt"));
      expect(arm[fields[i]!]).toHaveProperty("gt");
    });
  });

  it("🔴 refuses a null component instead of emitting a predicate that hides rows", () => {
    // column > NULL is NULL, not true: a nullable ranking column does not
    // reorder the queue, it deletes the tail of it. Loud beats silent - and
    // this is exactly why tierRank is NOT NULL in the database.
    const key: ScanKeyPart[] = [
      { field: "tierRank", value: null },
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
  // 240 rows with ties on BOTH ranked columns, and neither aligned with the
  // other: three ranks cycling row by row (80 each), and groups of eight
  // sharing an instant. So a run of equal ranks is broken up by instants and
  // a run of equal instants is broken up by ranks, which is the only place the
  // middle arm of the predicate does any work.
  const RANKS = [RANK_GOLD, RANK_SILVER, RANK_NONE];
  const rows: Row[] = Array.from({ length: 240 }, (_, i) => ({
    tierRank: RANKS[i % 3]!,
    createdAt: D(Math.floor(i / 8) * 1000),
    // Ids deliberately NOT in insertion order - (i * 97) mod 240 is a
    // permutation, so the id tie-break has to actually do something.
    id: `e${String((i * 97) % 240).padStart(3, "0")}`,
  }));
  const sorted = [...rows].sort(rank);

  it("ranking by tier actually reorders the list (otherwise this proves nothing)", () => {
    const byJoinTime = [...rows].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    );
    expect(sorted.map((r) => r.id)).not.toEqual(byJoinTime.map((r) => r.id));
    // And Gold really is at the front of it.
    expect(sorted.slice(0, 80).every((r) => r.tierRank === RANK_GOLD)).toBe(true);
  });

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
    // The actual scan invariant, stated directly: take any page boundary, and
    // page + what the cursor lets through must be the list, exactly once each.
    // 80 and 81 straddle a rank boundary on purpose.
    for (const size of [1, 7, 50, 80, 81, 239]) {
      const page = sorted.slice(0, size);
      const rest = sorted.filter((r) => matches(keysetAfter(scanCursorFrom(page[size - 1]!)), r));
      const seen = [...page, ...rest].map((r) => r.id);
      expect(new Set(seen).size).toBe(sorted.length);
      expect(seen).toEqual(sorted.map((r) => r.id));
    }
  });
});
