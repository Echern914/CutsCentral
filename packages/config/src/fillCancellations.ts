/**
 * FILL CANCELLATIONS AUTOMATICALLY - the barber's one switch for Auto-fill
 * (apps/api engines/autoFill.ts), and the reasons it cannot run.
 *
 * Shared truth, so the dashboard's card and the API's answer can never
 * disagree: the API names a blocker by its code, and this file says what it
 * means to the barber. A code is a contract; the words can change freely.
 */

/** How long Gold members have the time to themselves before everyone hears. */
export const FILL_CANCELLATIONS_HEAD_START_MIN = 15;

export const FILL_CANCELLATIONS_TITLE = "Fill cancellations automatically";

export const FILL_CANCELLATIONS_SUMMARY =
  `When someone cancels, Gold members get a ${FILL_CANCELLATIONS_HEAD_START_MIN}-minute head start, ` +
  "then everyone with your app gets a notification. First to book gets it.";

/**
 * Why a shop's switch would do nothing right now. Order is the order the card
 * lists them in: the ones the barber can fix themselves first.
 */
export const AUTO_FILL_BLOCKERS = [
  "not_native",
  "booking_page_off",
  "rewards_off",
  "plan",
  "receptionist_texting",
  "pushes_paused",
] as const;

export type AutoFillBlocker = (typeof AUTO_FILL_BLOCKERS)[number];

const BLOCKER_TEXT: Record<AutoFillBlocker, string> = {
  not_native: "Your clients book somewhere other than ChairBack right now. This works when they book through your ChairBack booking page.",
  booking_page_off: "Your booking page is off, so nobody could book the time. Turn your booking page on first.",
  rewards_off: "Rewards are off. Gold members come from rewards, so turn rewards on first.",
  plan: "This comes with Premium, and your shop isn't on Premium right now.",
  receptionist_texting: "Your AI receptionist already fills cancellations by text, so this stays out of its way.",
  pushes_paused: "App notifications are paused on ChairBack's side right now, so nothing would reach your clients.",
};

/** What a blocker means, for the barber. Unknown codes (a newer API) get a plain fallback. */
export function autoFillBlockerText(code: string): string {
  return (BLOCKER_TEXT as Record<string, string>)[code] ?? "Something about your shop's setup is stopping it right now.";
}

/** Narrow an API answer to the codes this build knows; unknown ones are kept as-is for the fallback text. */
export function isAutoFillBlocker(code: string): code is AutoFillBlocker {
  return (AUTO_FILL_BLOCKERS as readonly string[]).includes(code);
}
