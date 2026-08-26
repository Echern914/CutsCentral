import { describe, expect, it } from "vitest";
import { collapseExternalBlocks, type CollapsibleBlock } from "./externalBlockCollapse.js";

/**
 * Collapsing duplicate external blocks.
 *
 * The whole risk here is collapsing too much: a band that hides a DIFFERENT
 * span, or a different note, tells the barber their chair frees up at a time it
 * doesn't. So most of these assert what must NOT merge.
 */
const T = (iso: string) => new Date(iso);

function blk(over: Partial<CollapsibleBlock> = {}): CollapsibleBlock {
  return {
    id: over.id ?? "a",
    startsAt: T("2026-08-26T23:15:00.000Z"),
    endsAt: T("2026-08-27T03:15:00.000Z"),
    reason: null,
    externalCalendarId: "14200364",
    createdAt: T("2026-08-20T10:00:00.000Z"),
    ...over,
  };
}

describe("collapseExternalBlocks", () => {
  it("collapses four identical blocks into one row of four", () => {
    // Drick's Wednesday: four identical 7:15-11:15 PM bands, each saying
    // "Remove this in Acuity - it syncs back".
    const rows = ["a", "b", "c", "d"].map((id, i) =>
      blk({ id, createdAt: T(`2026-08-2${i}T10:00:00.000Z`) }),
    );
    const out = collapseExternalBlocks(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.duplicateCount).toBe(4);
  });

  it("keeps the earliest-created row as the survivor", () => {
    // The id is the React key on the client; re-syncing must not churn it.
    const out = collapseExternalBlocks([
      blk({ id: "late", createdAt: T("2026-08-25T10:00:00.000Z") }),
      blk({ id: "early", createdAt: T("2026-08-01T10:00:00.000Z") }),
    ]);
    expect(out[0]!.block.id).toBe("early");
  });

  it("breaks a created-at tie deterministically", () => {
    // One Acuity sweep upserts a page of blocks in the same millisecond.
    const same = T("2026-08-01T10:00:00.000Z");
    const forward = collapseExternalBlocks([
      blk({ id: "zzz", createdAt: same }),
      blk({ id: "aaa", createdAt: same }),
    ]);
    const reversed = collapseExternalBlocks([
      blk({ id: "aaa", createdAt: same }),
      blk({ id: "zzz", createdAt: same }),
    ]);
    expect(forward[0]!.block.id).toBe("aaa");
    expect(reversed[0]!.block.id).toBe("aaa");
  });

  it("reports 1 for a block with no duplicate", () => {
    expect(collapseExternalBlocks([blk()])[0]!.duplicateCount).toBe(1);
  });

  it("NEVER merges overlapping blocks with different ends", () => {
    // 7:15-11:15 and 7:15-9:15 are two different answers to "when does the
    // chair free up". Merging them would invent a third.
    const out = collapseExternalBlocks([
      blk({ id: "long" }),
      blk({ id: "short", endsAt: T("2026-08-27T01:15:00.000Z") }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("NEVER merges blocks with different starts", () => {
    const out = collapseExternalBlocks([
      blk({ id: "a" }),
      blk({ id: "b", startsAt: T("2026-08-26T22:15:00.000Z") }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("NEVER merges blocks with different notes", () => {
    // Hiding "Dentist" under "Lunch" swaps one wrong display for another.
    const out = collapseExternalBlocks([
      blk({ id: "a", reason: "Lunch" }),
      blk({ id: "b", reason: "Dentist" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("NEVER merges blocks from different calendars", () => {
    // Two barbers each blocking the same evening is two real blocks.
    const out = collapseExternalBlocks([
      blk({ id: "a", externalCalendarId: "1" }),
      blk({ id: "b", externalCalendarId: "2" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("treats a null note and a null calendar as their own group", () => {
    const out = collapseExternalBlocks([
      blk({ id: "a", reason: null, externalCalendarId: null }),
      blk({ id: "b", reason: null, externalCalendarId: null }),
      blk({ id: "c", reason: "Lunch", externalCalendarId: null }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((g) => g.block.reason === null)!.duplicateCount).toBe(2);
  });

  it("cannot be fooled by a note that looks like the group key", () => {
    // The separator must not be forgeable from inside a field.
    const out = collapseExternalBlocks([
      blk({ id: "a", reason: "x", externalCalendarId: "y" }),
      blk({ id: "b", reason: "x y", externalCalendarId: "" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("returns nothing for no rows", () => {
    expect(collapseExternalBlocks([])).toEqual([]);
  });
});
