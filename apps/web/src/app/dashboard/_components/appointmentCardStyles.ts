/**
 * The shared visual language for appointment cards - booking day view, the
 * dashboard's Today agenda, and a client's Upcoming list all speak it:
 *
 *   - The CLIENT'S NAME is the focus: semibold, its own full-width block,
 *     wrapping naturally. NEVER truncated - "Ab…" cost barbers the one fact
 *     the card exists to show. [overflow-wrap:anywhere] is the safety net for
 *     unbroken 40-character names at 320px.
 *   - Time and status stay quiet and structural; service details ride in a
 *     muted secondary line.
 *
 * Presentation only. Statuses, permissions and action handlers are untouched
 * by design - this module owns no behavior.
 */

/** Full-name block: wraps anywhere, never ellipsizes. Size set per surface. */
export const NAME_WRAP_CLS =
  "min-w-0 [overflow-wrap:anywhere] font-semibold leading-snug text-offwhite";

/**
 * Up to two initials for the little avatar circle. Unicode-aware ([...] not
 * charCodeAt), so "José María" -> "JM" and "王小明" -> "王".
 */
const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  // A generational suffix is not a name: "Blackwood III" must not read "AI".
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1]!.toLowerCase())) {
    words.pop();
  }
  if (words.length === 0) return "•";
  const first = [...words[0]!][0] ?? "";
  const second = words.length > 1 ? ([...words[words.length - 1]!][0] ?? "") : "";
  return (first + second).toUpperCase() || "•";
}
