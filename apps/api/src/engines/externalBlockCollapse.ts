/**
 * Collapse EXACT duplicate external blocks into one agenda row.
 *
 * Acuity stores duplicate blocks happily, and a barber who taps "block off"
 * twice (or whose block-off didn't look like it worked, so they tapped again)
 * ends up with several identical bands stacked on one evening. ChairBack
 * rendered every one of them: four identical "7:15 PM - 11:15 PM · Acuity · 4h"
 * rows on the same Wednesday, each saying "Remove this in Acuity - it syncs
 * back". The data was right; the day was unreadable.
 *
 * EXACT duplicates only. Two blocks are the same band only when their start,
 * their end, their note AND their source calendar all match:
 *
 *   - overlapping is NOT duplicate. 7:15-11:15 and 7:15-9:15 are two different
 *     answers to "when does my chair free up", and merging them would invent a
 *     third;
 *   - a different note is NOT duplicate. Collapsing "Lunch" into "Dentist"
 *     swaps one wrong display for another;
 *   - a different calendar is NOT duplicate. `externalCalendarId` is unused
 *     today (blocks are shop-wide), but two barbers each blocking the same
 *     evening is two real blocks, and keying on it now means the eventual
 *     calendar->staff mapping doesn't quietly start hiding one of them.
 *
 * The survivor is the EARLIEST-CREATED row, so the agenda row's id is stable:
 * it is the React key on the client, and re-syncing must not make the card
 * churn.
 */
export interface CollapsibleBlock {
  id: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  externalCalendarId: string | null;
  createdAt: Date;
}

export interface CollapsedBlock<T> {
  block: T;
  /** How many identical blocks this row stands for. 1 = not a duplicate. */
  duplicateCount: number;
}

/**
 * Length-prefix each field instead of joining on a delimiter.
 *
 * A barber's note is free text, so ANY printable separator is forgeable: with a
 * "|" join, the note "x|y" on no calendar keys identically to the note "x" on
 * calendar "y", and one of those two real blocks silently vanishes from the
 * day. Prefixing each part with its length is unambiguous whatever the text
 * contains, and unlike a NUL separator it stays plain ASCII in the source.
 */
function groupKey(parts: string[]): string {
  return parts.map((p) => `${p.length}:${p}`).join("");
}

export function collapseExternalBlocks<T extends CollapsibleBlock>(
  rows: T[],
): CollapsedBlock<T>[] {
  const groups = new Map<string, { block: T; duplicateCount: number }>();
  for (const row of rows) {
    const key = groupKey([
      row.startsAt.toISOString(),
      row.endsAt.toISOString(),
      row.reason ?? "",
      row.externalCalendarId ?? "",
    ]);
    const seen = groups.get(key);
    if (!seen) {
      groups.set(key, { block: row, duplicateCount: 1 });
      continue;
    }
    seen.duplicateCount++;
    // Keep the earliest-created as the survivor. Ties break on id so the answer
    // is deterministic even when two rows were written in the same millisecond
    // (one Acuity sweep upserting a page of blocks does exactly that).
    const rowMs = row.createdAt.getTime();
    const seenMs = seen.block.createdAt.getTime();
    if (rowMs < seenMs || (rowMs === seenMs && row.id < seen.block.id)) {
      seen.block = row;
    }
  }
  return [...groups.values()];
}
