import { useCallback, useState } from "react";

/**
 * "I SAVE THINGS IN THE SERVICES AND THEY DON'T SAVE." (a barber, 2026-10-01)
 *
 * After a save, revalidatePath refetches the whole booking page - seconds on
 * prod - and until that lands the list still holds the PRE-save rows. An
 * editor reopened in that window seeded from the old row, so the change looked
 * lost; and because a service save sends the WHOLE service, saving again from
 * that form wrote the old values back over the new ones.
 *
 * This holds the row a save just wrote, per id, for exactly as long as the
 * list still holds the row object that save replaced. The page's refresh
 * hands down NEW row objects, and from then on the server's row wins again -
 * so a change made anywhere else is never masked. (The group editor carries
 * the same fix, keyed by value - see ServiceGroupItem.)
 */
export function useJustSaved<T extends { id: string }>() {
  const [saved, setSaved] = useState<Record<string, { row: T; replaced: T }>>({});

  /** `replaced` is the row the list holds right now; `row` is what was written. */
  const remember = useCallback((replaced: T, row: T) => {
    setSaved((cur) => ({ ...cur, [replaced.id]: { row, replaced } }));
  }, []);

  /** The row to show and to edit: the just-saved one until the list catches up. */
  const current = useCallback(
    (row: T): T => {
      const s = saved[row.id];
      return s && s.replaced === row ? s.row : row;
    },
    [saved],
  );

  return { current, remember };
}
