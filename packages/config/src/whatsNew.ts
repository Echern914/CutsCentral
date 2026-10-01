/**
 * WHAT'S NEW - the shop's changelog, shown in the dashboard's bell.
 *
 * Eric, 2026-09-30: "when we do new features or new fixes... there should also
 * be a little notification bell on all new features and fixes coming out so
 * they know what's happening." Barbers were finding changes by accident, or
 * not at all - a fix they asked for could ship and they'd keep working around
 * the old behaviour.
 *
 * 🔑 ADD THE ENTRY IN THE SAME PR AS THE CHANGE, at the TOP of the list. One
 * entry per change a barber would notice; nothing for internal work. Written
 * for the barber: what is different for them, in a sentence or two - no
 * internals, no PR numbers, no other shop's name.
 *
 * 🔴 AN ID IS FOREVER. It is the read marker (User.whatsNewSeenId): the bell
 * counts the entries above the one a barber last saw. Editing a shipped id
 * would make everything read as new again; edit the words instead. Ids start
 * with the entry's date so a marker that no longer matches still sorts.
 * whatsNew.test.ts holds the list to all of this.
 */

export type WhatsNewKind = "feature" | "fix";

export interface WhatsNewEntry {
  /** "YYYY-MM-DD-short-slug". Unique, and never changed once shipped. */
  id: string;
  /** YYYY-MM-DD: the day it went live. */
  date: string;
  kind: WhatsNewKind;
  /** One line, at most 60 characters. */
  title: string;
  /** What changed for the barber, at most 280 characters. */
  body: string;
}

/** Newest first. New entries go at the TOP. */
export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-10-01-targeted-slots-booking-rules",
    date: "2026-10-01",
    kind: "fix",
    title: "Targeted slots follow your booking rules",
    body:
      "Your min notice and how far ahead clients can book now apply to targeted slots too, so nobody grabs one at " +
      "the last minute. They can still sit outside your regular hours, and you can still book a client into one " +
      "yourself from New appointment.",
  },
  {
    id: "2026-09-30-own-domain-stays",
    date: "2026-09-30",
    kind: "fix",
    title: "Your own domain keeps its name",
    body:
      "If you've connected your own domain, your page now opens right on it - your domain stays in the address bar " +
      "instead of switching to getchairback.com. Book still opens on ChairBack, so saved cards and Apple Pay keep " +
      "working.",
  },
  {
    id: "2026-09-30-rewards-in-the-app",
    date: "2026-09-30",
    kind: "feature",
    title: "Clients get their whole rewards in the app",
    body:
      "With the next ChairBack app update, a client's Rewards tab shows everything their rewards page does: the " +
      "countdown to rebook, their punch card, your deals and the rewards they've claimed. The Your rewards button " +
      "then comes off your page inside the app.",
  },
  {
    id: "2026-09-30-page-designs",
    date: "2026-09-30",
    kind: "feature",
    title: "Five new designs for your page",
    body:
      "Your page can now lead with your work. Under Your page, pick Photos first, Lookbook, The reel, Profile or " +
      "Fresh work. Tag each photo with its service and clients can book that exact look in one tap. Your page stays " +
      "Classic until you change it.",
  },
  {
    id: "2026-09-30-saved-cards",
    date: "2026-09-30",
    kind: "feature",
    title: "Clients can save their card for next time",
    body:
      "If your shop keeps a card on file, clients can tick \"Save this card\" when they book. Next time they pick a " +
      "time and book in one tap. The card shows on their client profile, and bookings you make for them carry it too.",
  },
  {
    id: "2026-09-30-confirm-books-once",
    date: "2026-09-30",
    kind: "fix",
    title: "Confirm books once, even on a double tap",
    body:
      "On your booking page, Confirm now says \"Booking…\" and stays off until the booking is done. A quick second " +
      "tap used to send a second request, which told your client their own time had just been taken.",
  },
  {
    id: "2026-09-30-booked-right-after-saving-card",
    date: "2026-09-30",
    kind: "fix",
    title: "Clients see \"Booked\" right after saving their card",
    body:
      "A client who saved their card could still see \"Requested\" on their appointment for a moment - and the " +
      "page didn't update. It now checks with the card processor as it opens, so a saved card always shows as booked.",
  },
  {
    id: "2026-09-30-unfinished-bookings-say-not-booked",
    date: "2026-09-30",
    kind: "fix",
    title: "Unfinished bookings now say \"Not booked yet\"",
    body:
      "When your shop takes a card to book, a client who leaves before saving it now sees \"Not booked yet\" " +
      "and can tap Finish booking to lock the time in - instead of thinking they're booked when they aren't.",
  },
  {
    id: "2026-09-30-square-appointments-import",
    date: "2026-09-30",
    kind: "fix",
    title: "Square appointments now come over in full",
    body:
      "Connecting Square now brings over your past visits and everything already booked ahead, and keeps syncing " +
      "every 30 minutes. The Square card on your Booking page shows how many came over and when it last synced.",
  },
  {
    id: "2026-09-30-returning-clients-remembered",
    date: "2026-09-30",
    kind: "feature",
    title: "Returning clients are remembered",
    body:
      "Your booking page now fills in a client's name, number and email from their last booking on the same phone, " +
      "with a \"Not you?\" button. A client who already agreed to your policies isn't asked again unless you change the wording.",
  },
  {
    id: "2026-09-30-imported-history-counts",
    date: "2026-09-30",
    kind: "fix",
    title: "Your imported visit history now counts",
    body:
      "Past appointments brought over from Acuity now count as completed visits, so each client's last visit, " +
      "visit rhythm and tier reflect their real history.",
  },
  {
    id: "2026-09-30-rebook-texts-skip-booked",
    date: "2026-09-30",
    kind: "fix",
    title: "Rebook texts skip clients who already booked",
    body:
      "The automatic \"time for a cut\" text no longer goes to a client who already has an appointment coming up, " +
      "and it stops for clients who have been gone a long time instead of repeating every few weeks.",
  },
  {
    id: "2026-09-29-book-any-time",
    date: "2026-09-29",
    kind: "feature",
    title: "Book any time you tap, at your own price",
    body:
      "Tap any time on your calendar, even outside your hours, to book a client there - and set a custom price " +
      "for it, like your after-hours rate.",
  },
  {
    id: "2026-09-29-hidden-services",
    date: "2026-09-29",
    kind: "feature",
    title: "Hide a service from your booking page",
    body:
      "Tap the eye on a service to keep it off your public booking page. You can still book it for clients yourself.",
  },
  {
    id: "2026-09-29-note-for-clients",
    date: "2026-09-29",
    kind: "feature",
    title: "A note for your clients",
    body:
      "Add a note - like \"Please arrive 10 minutes early\" - and your clients see it with their appointment after they book.",
  },
  {
    id: "2026-09-29-delete-resolved-conflicts",
    date: "2026-09-29",
    kind: "feature",
    title: "Clear out resolved conflicts",
    body: "Booking conflicts you have already resolved can now be deleted from the conflict list.",
  },
];

/**
 * The entries a barber has not seen yet.
 *
 * `seenId` is the newest entry they have seen. Everything above it in the list
 * is new. A marker that no longer matches an entry (one was removed) falls
 * back to its date. With no marker at all, only what shipped since the account
 * was created counts - a new shop is not greeted with a pile of history.
 */
export function unseenWhatsNew(
  seenId: string | null,
  accountCreatedAt: Date,
  entries: readonly WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  if (seenId) {
    const at = entries.findIndex((e) => e.id === seenId);
    if (at >= 0) return entries.slice(0, at);
    const seenDate = seenId.slice(0, 10);
    return entries.filter((e) => e.date > seenDate);
  }
  const joined = accountCreatedAt.toISOString().slice(0, 10);
  return entries.filter((e) => e.date >= joined);
}
