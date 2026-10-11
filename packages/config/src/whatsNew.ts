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
    id: "2026-10-10-moved-bookings-keep-length",
    date: "2026-10-10",
    kind: "fix",
    title: "Moved bookings keep their full length",
    body:
      "A booking with an add-on, or one you lengthened, now keeps all its time when you or the client move it. " +
      "Booking someone new on a number you already have no longer renames that client. And Mark no-show can't " +
      "overwrite a client's own cancel or charge them for it.",
  },
  {
    id: "2026-10-10-privacy-terms-updated",
    date: "2026-10-10",
    kind: "feature",
    title: "Updated Privacy Policy and Terms",
    body:
      "Our Privacy Policy and Terms now cover what has launched since June: paid plans, client payments through " +
      "your Stripe account, the ChairBack app, email and app notifications, Square, and AI tools you connect. " +
      "They take effect October 23.",
  },
  {
    id: "2026-10-10-no-show-after-completed",
    date: "2026-10-10",
    kind: "feature",
    title: "Mark a no-show after the visit shows completed",
    body:
      "A booking whose time passed counts as completed, even if nobody came. Open it, tap More, then Mark " +
      "no-show or Cancel visit, up to 7 days later. Its punch comes off, and nobody is told or charged. " +
      "A no-show keeps its deposit. A tipped or checked-out visit can't be changed.",
  },
  {
    id: "2026-10-09-remove-walk-in",
    date: "2026-10-09",
    kind: "feature",
    title: "Remove a walk-in you recorded by mistake",
    body:
      "Open the walk-in, tap More, then Remove walk-in. It comes off your schedule and out of your takings, and " +
      "nobody is told. A walk-in paid by card or tipped through ChairBack needs that refunded first. To fix one, " +
      "remove it and record it again.",
  },
  {
    id: "2026-10-09-repeat-change-acuity-still-confirming",
    date: "2026-10-09",
    kind: "fix",
    title: "Changing a long repeat no longer stalls on Acuity",
    body:
      "Edit this and future used to wait for Acuity on every date, and a long repeat could end in \"We couldn't " +
      "confirm that went through\". It now shows the result right away, marks any date Acuity is still confirming, " +
      "and checks again until each is confirmed or turned down.",
  },
  {
    id: "2026-10-09-text-and-group-moves-ask-first",
    date: "2026-10-09",
    kind: "fix",
    title: "Moves by text and group moves ask before a price changes",
    body:
      "Your text receptionist and the group booking page now move appointments the same way: add-ons and any price " +
      "you set stay put. If the menu price differs at the new time, the client is shown both figures and nothing " +
      "moves until they say yes.",
  },
  {
    id: "2026-10-09-server-hiccup-never-books-twice",
    date: "2026-10-09",
    kind: "fix",
    title: "A server hiccup never books or punches twice",
    body:
      "If ChairBack can't confirm a booking or a logged visit because of a server error, tapping again now finds " +
      "what the first tap saved instead of adding a second one. Change the details meanwhile and it tells you " +
      "what was saved.",
  },
  {
    id: "2026-10-08-moved-booking-keeps-its-price",
    date: "2026-10-08",
    kind: "fix",
    title: "A moved appointment keeps its price",
    body:
      "Moving an appointment used to reset it to the new day's menu price, dropping add-ons and any price you set. " +
      "Those now move with it. If only the menu price differs, the client sees both figures first, and the change " +
      "goes in the price history.",
  },
  {
    id: "2026-10-08-sheet-stays-after-edit",
    date: "2026-10-08",
    kind: "fix",
    title: "An appointment stays open after you change its time",
    body:
      "Moving an appointment to another hour used to close it the moment you saved, along with any note that Acuity " +
      "hadn't confirmed the new time yet. It now stays open on the new time, with that note, until you close it.",
  },
  {
    id: "2026-10-08-edit-repeat-this-and-future",
    date: "2026-10-08",
    kind: "feature",
    title: "Change a repeat from one date onward",
    body:
      "Open an appointment in a repeat, tap More, then Edit this and future to change the start time, service or " +
      "provider for it and every upcoming one. You see each date before anything changes. Prices stay as booked, " +
      "and finished, cancelled or one-off changed dates stay as they are.",
  },
  {
    id: "2026-10-08-book-again",
    date: "2026-10-08",
    kind: "feature",
    title: "Book a client's next visit from their appointment",
    body:
      "Open an appointment's Full details, tap More, then Book again. The client, service and provider carry over; " +
      "you pick the day and time. The appointment you started from is never changed, and a booking sent twice on " +
      "a weak connection is only made once.",
  },
  {
    id: "2026-10-08-swipe-days-month-view",
    date: "2026-10-08",
    kind: "feature",
    title: "Swipe between days on the calendar",
    body:
      "On the Month view, swipe left or right on the open day to move to the next or previous day, " +
      "just like the Day view. Swiping inside an open appointment no longer changes the day, and a refresh " +
      "keeps you on the day you were looking at.",
  },
  {
    id: "2026-10-08-one-visit-one-punch",
    date: "2026-10-08",
    kind: "fix",
    title: "Log visit can't punch the same visit twice",
    body:
      "Log visit now asks first when the client already has a visit that day (booked, synced or logged by hand), " +
      "so the same cut isn't punched twice. A tap sent twice, or retried after a dropped connection, logs once. " +
      "Rewards now shows when a promotion is adding punches to every visit.",
  },
  {
    id: "2026-10-08-booking-page-truth",
    date: "2026-10-08",
    kind: "fix",
    title: "Your booking page shows the exact price",
    body:
      "Deposits and prices with cents show as $12.50, not $13. Clients are promised a reminder text only when one " +
      "will be sent. Group booking works when you book less than a month out. In Acuity settings, Use this calendar " +
      "and Confirm save in one tap.",
  },
  {
    id: "2026-10-08-billing-and-settings-truth",
    date: "2026-10-08",
    kind: "fix",
    title: "Billing, payments and inbox say what really happened",
    body:
      "During a Premium AI trial, Billing now shows Keep it. Payment settings refuse an out-of-range deposit instead " +
      "of changing it. On a phone, Return in an inbox reply makes a new line instead of sending. Inbox and request " +
      "times show in your own time.",
  },
  {
    id: "2026-10-08-client-pages-truth",
    date: "2026-10-08",
    kind: "fix",
    title: "Client pages and the kiosk ask and say it right",
    body:
      "The walk-in kiosk's text consent box now starts unticked for every customer, and every step has Start over. " +
      "Client forms name a mistyped email, and leaving a waitlist says if it didn't go through. Android no longer " +
      "gets an Apple link.",
  },
  {
    id: "2026-10-08-services-tab-fixes",
    date: "2026-10-08",
    kind: "fix",
    title: "Services, specials and staff do what they say",
    body:
      "Editing a special now saves its Also bookable as choices, and a blank price is refused instead of saved as free. " +
      "Turning off a series or removing staff asks first. A hidden service's copy stays hidden, and an evening save " +
      "keeps today's holiday price.",
  },
  {
    id: "2026-10-08-sign-out-alerts-and-held-prices",
    date: "2026-10-08",
    kind: "fix",
    title: "Signing out stops your booking alerts",
    body:
      "Signing out now stops new booking and cancellation alerts on every phone you were signed in on, until you " +
      "sign in there again. A slot you hold for your members now shows them that slot's own price, like your " +
      "Saturday rate, before they book it.",
  },
  {
    id: "2026-10-08-home-clients-team-truth",
    date: "2026-10-08",
    kind: "fix",
    title: "Home, clients and team say what really happened",
    body:
      "Today no longer counts a lunch block as an appointment. Nudge now, Leave team and voiding rent say why when " +
      "they fail. Cancel on Edit profile throws the change away. Card pickers fit a phone, and promos show $12.50 off.",
  },
  {
    id: "2026-10-08-assistant-knows-whats-new",
    date: "2026-10-08",
    kind: "fix",
    title: "Ask the assistant about this week's changes",
    body:
      "The assistant now answers questions about Add at, repeats, Save anyway, Didn't finish booking, deposits on " +
      "moved bookings, saved cards, page designs and the app's Rewards tab. It no longer says a whole repeat can be " +
      "edited: change one date, or cancel the rest and set it up again.",
  },
  {
    id: "2026-10-08-checkout-tells-the-truth",
    date: "2026-10-08",
    kind: "fix",
    title: "Checkout never guesses whether a card was charged",
    body:
      "If checkout can't confirm a charge or refund, it now says so and tells you not to collect again, instead of " +
      "\"Nothing was charged\". Pressing Charge again shows the first result and never charges twice. A paid-in-full " +
      "booking no longer offers a $0.00 charge.",
  },
  {
    id: "2026-10-08-bell-back-button",
    date: "2026-10-08",
    kind: "fix",
    title: "A Back button here, and every update you missed",
    body:
      "On a phone this list filled the screen and there was no way to close it. A Back button now stays at the top " +
      "left while you scroll. This list also shows every update you haven't seen, not just the newest six.",
  },
  {
    id: "2026-10-08-hours-load-and-requests",
    date: "2026-10-08",
    kind: "fix",
    title: "Your hours are safe on a weak signal",
    body:
      "If your hours can't load, the sheet now says so with Try again, instead of showing every day off and letting a " +
      "save replace your real week. Save problems show above Save hours. With no booking link, your page's request " +
      "form now reaches you.",
  },
  {
    id: "2026-10-08-limits-hours-and-saves",
    date: "2026-10-08",
    kind: "fix",
    title: "Close at midnight, and saves that say when they fail",
    body:
      "Hours can now end at midnight. A service over 600 minutes or an add-on over 480 is named instead of " +
      "\"Couldn't add\". Quota, target and plan saves say when they fail, and switching a service quota from week " +
      "to month replaces it. Service groups no longer claim to set hours.",
  },
  {
    id: "2026-10-08-calendar-and-forms-truth",
    date: "2026-10-08",
    kind: "fix",
    title: "The calendar shows exactly what's open",
    body:
      "One barber's block-off no longer hides the other chairs, and the hours inside a long appointment no longer " +
      "offer a +. Cancel in Edit appointment throws the change away. A booking question you just added can be removed.",
  },
  {
    id: "2026-10-06-repeat-numbers-type",
    date: "2026-10-06",
    kind: "fix",
    title: "Type any number in a repeat",
    body:
      "In New appointment, the Every weeks and appointments total boxes now take the number you type. " +
      "Before, clearing a box jumped it to another number, so every 8 weeks was often the only choice. " +
      "A number outside the range is shown in red and is never swapped for another one.",
  },
  {
    id: "2026-10-06-repeats-every-visit",
    date: "2026-10-06",
    kind: "fix",
    title: "Repeats book every visit and skip your days off",
    body:
      "A repeat on your open times now books every visit you asked for, instead of stopping about 60 days out. " +
      "A Custom time repeat now skips the days you blocked off. Standing appointments booked online keep the " +
      "client's answers to your booking questions on every visit.",
  },
  {
    id: "2026-10-06-held-times-need-a-card",
    date: "2026-10-06",
    kind: "fix",
    title: "Waitlist and tier offers respect Require a card",
    body:
      "If you require a saved card to book, a waitlist offer or a time held for a tier could be booked without " +
      "one. Those times now stay on your booking page instead, where the card step runs. Prices set by day or " +
      "date now count too.",
  },
  {
    id: "2026-10-06-add-in-a-busy-hour",
    date: "2026-10-06",
    kind: "feature",
    title: "Add an appointment in the gap of a busy hour",
    body:
      "On your day, an hour that already has bookings now shows Add at, with the first open time in it - say " +
      "Add at 6:30 PM under a 6:20 booking. Tap it and New appointment opens on that time.",
  },
  {
    id: "2026-10-06-edit-move-tells-client",
    date: "2026-10-06",
    kind: "fix",
    title: "Moving a booking emails the client the new time",
    body:
      "If ChairBack already emailed a client about a booking, moving it in Edit now emails them the new time, " +
      "and their reminder goes out for the new time too. Bookings ChairBack never emailed about stay quiet. " +
      "The note you type in New appointment is now saved.",
  },
  {
    id: "2026-10-06-waitlist-frees-held-time",
    date: "2026-10-06",
    kind: "fix",
    title: "A waitlist time goes to the next person right away",
    body:
      "When someone leaves your waitlist, taps the new No thanks on an offer, or you remove them, the time " +
      "held for them now goes straight to the next person. Before, it stayed held for up to half an hour. " +
      "A hold also never runs past the start of the time it holds.",
  },
  {
    id: "2026-10-06-unfinished-compact",
    date: "2026-10-06",
    kind: "fix",
    title: "Didn't finish booking takes far less room",
    body:
      "Each person on the list is now one short row: who, the time they wanted, and whether it's still open. " +
      "Tap a row to see why they didn't finish and to text, call, book or dismiss them.",
  },
  {
    id: "2026-10-05-tip-ask-email",
    date: "2026-10-05",
    kind: "feature",
    title: "Clients get a Leave a tip email after a visit",
    body: "With Tips on, about an hour after a visit you finish (Done, checkout, or marked arrived) the client gets one email with a Leave a tip link. When they tip, they get a receipt and you get a push. A visit that only ended on the calendar is never asked.",
  },
  {
    id: "2026-10-05-unfinished-confirm-and-invite",
    date: "2026-10-05",
    kind: "feature",
    title: "Didn't finish booking now tells the client for you",
    body:
      "Book them now emails the client their confirmation (and pushes the app if they use it), so you don't " +
      "have to text everyone. When their time was taken, Email them to pick a new time sends one email with " +
      "your booking page.",
  },
  {
    id: "2026-10-05-book-without-card",
    date: "2026-10-05",
    kind: "fix",
    title: "Clients are booked even if they skip the card",
    body:
      "With Card on file, pressing Confirm now books the client and sends their confirmation. Saving a card comes " +
      "after and is optional, so nobody who skips it loses their time. Want card-or-nothing? Payments, Card on " +
      "file, Require a saved card to book.",
  },
  {
    id: "2026-10-05-online-tips",
    date: "2026-10-05",
    kind: "feature",
    title: "Clients can tip you online after a visit",
    body: "Turn on Tips in Payments. Once a visit is done, clients can leave 15, 20 or 25% or their own amount from their appointment page. Stripe's card fee comes out of each tip, as at any card reader. Each tip shows on the appointment, with a Refund tip button.",
  },
  {
    id: "2026-10-05-repeat-appointment",
    date: "2026-10-05",
    kind: "fix",
    title: "Repeat appointment, every 1 to 8 weeks",
    body: "Booking a client every few weeks? In New appointment, under Repeat, the option now reads Repeat appointment instead of Weekly. Pick it, set how many weeks apart, then how many times or until when. Repeating bookings show a Repeats tag on your calendar.",
  },
  {
    id: "2026-10-05-refund-kept-deposit",
    date: "2026-10-05",
    kind: "feature",
    title: "Give back a deposit you kept",
    body: "When a client cancels or doesn't show and you keep their deposit, you can still give it back. Open the appointment on your calendar and tap Refund under its payment. It goes back to the card or account they paid with. A cancelled booking no longer says money is still to collect.",
  },
  {
    id: "2026-10-04-nonrefundable-deposits",
    date: "2026-10-04",
    kind: "feature",
    title: "Make your deposit non-refundable",
    body:
      "If you take deposits, Payments now has Deposit refunds: keep the deposit when a client cancels, or let " +
      "your cancellation policy decide. Clients are told before they pay. If you cancel, they're refunded in full, " +
      "and bookings already made keep their terms.",
  },
  {
    id: "2026-10-04-move-deposit-bookings",
    date: "2026-10-04",
    kind: "fix",
    title: "Bookings with a deposit can be moved",
    body:
      "If you take deposits, clients can now move their booking from their link, and you can move it from your " +
      "calendar, to any time whose price still covers the deposit. The deposit stays with the booking and the rest " +
      "is paid at the shop. Before, every move was refused.",
  },
  {
    id: "2026-10-04-didnt-finish-booking",
    date: "2026-10-04",
    kind: "feature",
    title: "See who didn't finish booking",
    body:
      "Your Appointments page now shows clients who picked a time but didn't finish checking out, so they aren't " +
      "booked and may think they are. You'll see the time they wanted and if it's still open. Text or call them, " +
      "book them into it, or take them off the list.",
  },
  {
    id: "2026-10-04-card-step-no-cashapp",
    date: "2026-10-04",
    kind: "fix",
    title: "Clients save a card or Apple Pay to book",
    body:
      "If you keep a card on file, the card step now offers a card, Apple Pay or Link. Cash App is off that screen: " +
      "about 1 in 3 clients who picked it never got approved, so their time was released while they thought they " +
      "were booked.",
  },
  {
    id: "2026-10-02-app-not-booked-yet",
    date: "2026-10-02",
    kind: "fix",
    title: "The app tells clients a booking isn't finished",
    body:
      "If a client leaves before saving their card, the ChairBack app now says Not booked yet instead of Requested, " +
      "with the time it's held until. Its Reschedule button takes them back to save the card before the time is " +
      "released.",
  },
  {
    id: "2026-10-01-block-clients",
    date: "2026-10-01",
    kind: "feature",
    title: "Block a client from booking",
    body:
      "Open a client and tap Block from booking. They can't book, join your waitlist or move a booking online, " +
      "and they stop getting your rebook reminders and deals. Their booked appointments stay, and you can still book " +
      "them yourself.",
  },
  {
    id: "2026-10-01-edit-save-anyway",
    date: "2026-10-01",
    kind: "fix",
    title: "Change a booking's service at any time",
    body:
      "Changing a booking to another service - or another time - no longer dead-ends when it isn't one of the usual " +
      "openings clients get. Edit appointment tells you why and lets you Save anyway. It still can't overlap another " +
      "booking.",
  },
  {
    id: "2026-10-01-addons-say-why",
    date: "2026-10-01",
    kind: "fix",
    title: "Add-ons say why they won't fit",
    body:
      "When an add-on needs more time than is free after the time a client picked - say your next booking starts " +
      "right after - your booking page now tells them, and to pick another time, instead of just greying it out.",
  },
  {
    id: "2026-10-01-service-edits-save",
    date: "2026-10-01",
    kind: "fix",
    title: "Editing a service tells you if it didn't save",
    body:
      "If a change to a service can't be saved, Edit service now says why, right above Save, instead of seeming to " +
      "do nothing. And opening a service right after saving shows what you just saved, so saving again can't undo " +
      "it.",
  },
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
