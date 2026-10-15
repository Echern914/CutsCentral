/**
 * "How do I get booked out more?" - the answer built from THIS shop's numbers.
 *
 * The API computes a brief (apps/api engines/bookedOut.ts) from data ChairBack
 * already holds: how full the coming weeks are, which weekday runs emptiest,
 * how many clients come back, how many new ones arrive, no-shows, regulars who
 * are overdue, and what the booking page is missing. The Assistant hands the
 * brief to the support engine as a live fact, and the engine renders it as the
 * answer, with one button per item.
 *
 * 🔴 NO MODEL. Every sentence is a template filled with a counted number, and
 * every rule is a threshold written down in the engine. The Assistant stays
 * free to run (dashboard/assistant/costBoundary.test.ts).
 *
 * This file is the WIRE shape only, so the API, the support engine and the web
 * agree on one structure. It carries counts and percentages - never money and
 * never a client's name.
 */

/** One thing to work on, with the number that says so. */
export interface BookedOutItem {
  /** Stable rule id ("upcoming_fill", "overdue_regulars", ...). */
  id: string;
  /** What to do, as a short imperative: "Fill your next two weeks". */
  title: string;
  /** The number behind it, in a sentence: "Your next 2 weeks are 38% booked." */
  finding: string;
  /** How, in one or two sentences. */
  fix: string;
  /**
   * Where to do it: a feature registry id, resolved against the asker's seat
   * by the support engine. Null when the fix is not a screen.
   */
  action: { label: string; featureId: string } | null;
}

export interface BookedOutBrief {
  /** "shop" for an owner or manager; "own" for one provider's own book. */
  scope: "shop" | "own";
  /** The one-line state of things, leading the answer. */
  headline: string;
  /** Ranked, most worth doing first. Empty when nothing stands out. */
  items: BookedOutItem[];
  /** What is already working, so the answer is not only a list of faults. */
  strengths: string[];
  /** Which data this was read from, in a sentence ("Based on the last 8 weeks..."). */
  basis: string;
}

/** The most items an answer shows. The rest wait until these are done. */
export const BOOKED_OUT_MAX_ITEMS = 5;

/**
 * The brief as plain text - for a channel that renders paragraphs only (the
 * help bubble, an MCP client). The Assistant renders `items` as cards instead.
 */
export function bookedOutText(brief: BookedOutBrief): string {
  const parts: string[] = [brief.headline];
  if (brief.items.length === 0) {
    parts.push("Nothing in your numbers stands out right now.");
  } else {
    parts.push(
      brief.items
        .map((item, i) => `${i + 1}. ${item.title}. ${item.finding} ${item.fix}`)
        .join("\n"),
    );
  }
  if (brief.strengths.length > 0) parts.push(`Going well: ${brief.strengths.join(" ")}`);
  parts.push(brief.basis);
  return parts.join("\n\n");
}
