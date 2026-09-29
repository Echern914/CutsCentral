/**
 * THE SHOP'S NOTE FOR CLIENTS - a line or two the owner writes once and every
 * booking confirmation carries. A barber, 2026-09-29: "if we could add notes to
 * the confirmations. Like I would tell people please arrive 10 minutes early."
 *
 * Not the booking policy (config/bookingPolicy.ts): that is what a customer
 * AGREES to before booking, versioned and snapshotted. This is information for
 * after - where to park, arrive early, bring a photo - and changing it changes
 * what every upcoming confirmation page shows, with nothing to agree to.
 *
 * Shown on the booked screen, the customer's appointment page, and the
 * confirmation and reminder emails. Never in a text message: SMS confirmations
 * are off for cost, and every character of a reminder text is paid for.
 *
 * Pure: no I/O - imported by client components.
 *
 * 🔴 IT IS TEXT, EVERYWHERE. The owner's words are rendered as text in React
 * and escaped in email HTML - never as markup.
 */

/** Two or three short sentences - it rides on every confirmation. */
export const CLIENT_NOTE_MAX = 300;

/**
 * Clean what the owner typed (or what the database holds): trimmed, runs of
 * blank lines collapsed to one, blank = null (nothing shown anywhere).
 *
 * Like the booking policy it does NOT cut to length - the settings API refuses
 * an over-long note rather than silently dropping the end of a sentence.
 */
export function normalizeClientNote(raw: string | null | undefined): string | null {
  const text = (raw ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** The heading every surface shows above the note, so they all read alike. */
export function clientNoteHeading(shopName: string): string {
  return `A note from ${shopName}`;
}
