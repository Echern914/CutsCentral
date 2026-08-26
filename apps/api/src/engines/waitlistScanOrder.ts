import { Prisma } from "@chairback/db";

/**
 * THE CANDIDATE SCAN'S RANKING — and the keyset predicate that resumes it.
 *
 * engines/waitlistOffer.ts streams waitlist entries out of the database in
 * ranked pages and evaluates each one against the freed slot. Two things have
 * to agree perfectly for that walk to be correct:
 *
 *   1. the ORDER BY, and
 *   2. the WHERE that says "strictly after the last row of the previous page".
 *
 * 🔴 IF THEY DISAGREE, ROWS SILENTLY VANISH. Order by A and resume by B and
 * the second page starts somewhere the first page never reached: entries are
 * skipped, or visited twice, and nothing anywhere throws. A waitlist that
 * quietly never offers anything to the 51st person is not a visible bug — it
 * is a person who stops hearing from the shop.
 *
 * So they are not written twice. Both are generated from ONE list, SCAN_ORDER
 * below, and adding a component (the loyalty tier is next) means editing that
 * list and the row `select` — never the walk itself.
 *
 * Two rules constrain what may go in the list, and both are load-bearing:
 *
 * 🔴 EVERY COMPONENT MUST BE NOT NULL. Postgres sorts NULLs LAST ascending,
 *    but `column > NULL` is NULL, not true — so once the cursor passes a NULL
 *    the predicate excludes every remaining NULL row forever. A nullable
 *    ranking column does not reorder the queue, it DELETES the tail of it.
 *    Rank by a coalesced expression or a NOT NULL mirror column, never by the
 *    nullable column itself. keysetAfter() throws rather than emit such a
 *    predicate.
 *
 * 🔴 EVERY COMPONENT MUST BE ASCENDING, and the last one must be UNIQUE.
 *    `id` is what makes the whole thing total: without a unique tail, two rows
 *    that tie on every ranked column are indistinguishable to the cursor and
 *    the page boundary between them is a coin toss.
 */

/**
 * A column the scan ranks by. Extending this union without extending the
 * switches below is a compile error, which is the point of the union.
 */
export type ScanField = "tierRank" | "createdAt" | "id";

/**
 * The ranking, first ORDER BY key first.
 *
 * Loyalty rank, then the queue the waitlist has always been: earliest joiner
 * first, id breaking same-instant ties. Gold sorts to the front because Gold
 * carries the SMALLEST number (engines/waitlistTierRank.ts) - every component
 * here is ascending, per the rules above.
 *
 * 🔑 Adding `tierRank` to this line IS the ordering change. The ORDER BY, the
 * resume predicate and the cursor all followed from it, and the walk in
 * waitlistOffer.ts did not move at all - which is what this module was built
 * for.
 */
export const SCAN_ORDER: readonly ScanField[] = ["tierRank", "createdAt", "id"];

/**
 * The minimum a scanned row must select for the cursor to be readable.
 *
 * 🔴 `tierRank` is NOT NULL in the database on purpose - a nullable ranking
 * column would make the cursor drop the tail of the queue (see the NOT NULL
 * rule above), so the type here is `number`, never `number | null`.
 */
export interface ScanRow {
  tierRank: number;
  createdAt: Date;
  id: string;
}

/**
 * One component of a cursor: a ranked column and this row's value for it.
 *
 * `value` is deliberately `unknown` rather than `Date | string`. It is an
 * opaque token — built by scanCursorFrom, consumed by keysetAfter, never read
 * in between — and typing it loosely is what lets the null guard below be a
 * real check instead of a comparison TypeScript rejects as impossible. The
 * day a nullable column is added to SCAN_ORDER, that guard is the thing that
 * fires.
 */
export interface ScanKeyPart {
  readonly field: ScanField;
  readonly value: unknown;
}

/** The ORDER BY, generated from SCAN_ORDER. */
export function scanOrderBy(): Prisma.WaitlistEntryOrderByWithRelationInput[] {
  return SCAN_ORDER.map((field): Prisma.WaitlistEntryOrderByWithRelationInput => {
    switch (field) {
      case "tierRank":
        return { tierRank: "asc" };
      case "createdAt":
        return { createdAt: "asc" };
      case "id":
        return { id: "asc" };
    }
  });
}

/** This row's ranking key, in ORDER BY position. */
export function scanCursorFrom(row: ScanRow): ScanKeyPart[] {
  return SCAN_ORDER.map((field): ScanKeyPart => {
    switch (field) {
      case "tierRank":
        return { field, value: row.tierRank };
      case "createdAt":
        return { field, value: row.createdAt };
      case "id":
        return { field, value: row.id };
    }
  });
}

/**
 * "Strictly after this row, in SCAN_ORDER" — the lexicographic keyset
 * predicate, expanded from the same list the ORDER BY came from.
 *
 * For an ascending ORDER BY of (k1 … kn), a row is after the cursor iff there
 * is SOME position i where it equals the cursor on k1 … k(i-1) and is strictly
 * greater on ki. That is one OR arm per position:
 *
 *   (tierRank, createdAt, id)
 *     ->  tierRank > R
 *     OR (tierRank = R AND createdAt > X)
 *     OR (tierRank = R AND createdAt = X AND id > Y)
 *
 * which is byte-for-byte the predicate this scan has always used. Prepending
 * a component adds an arm and lengthens the rest; nothing else moves.
 *
 * KEYSET, NEVER OFFSET. An OFFSET re-counts from the top on every page, so an
 * insert behind the cursor shifts every later row down one and the next page
 * skips whatever slid across the boundary. Keyset names a position instead of
 * counting to one: a row inserted behind the cursor is simply seen by the next
 * freed slot, never double-visited by this one.
 */
export function keysetAfter(key: readonly ScanKeyPart[]): Prisma.WaitlistEntryWhereInput {
  const OR: Prisma.WaitlistEntryWhereInput[] = [];
  for (let i = 0; i < key.length; i += 1) {
    const clause: Record<string, unknown> = {};
    // Equal on everything more significant …
    for (let j = 0; j < i; j += 1) {
      const eq = key[j]!;
      clause[eq.field] = eq.value;
    }
    // … and strictly greater here.
    const gt = key[i]!;
    if (gt.value === null || gt.value === undefined) {
      // See the NOT NULL rule at the top. Refusing is the safe failure: an
      // offer that throws is retried, an offer built on a predicate that
      // excludes half the queue is not even wrong out loud.
      throw new Error(
        `waitlist scan: ranking column "${gt.field}" is null; a keyset cursor ` +
          `cannot resume past a null (column > NULL is NULL, not true)`,
      );
    }
    clause[gt.field] = { gt: gt.value };
    // The one cast in the module. The clause is built from ScanField keys and
    // Prisma filter values, which is precisely the shape of a where input;
    // TypeScript cannot see that through a computed key.
    OR.push(clause as Prisma.WaitlistEntryWhereInput);
  }
  return { OR };
}
