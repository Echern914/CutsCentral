/**
 * The names on the "How customers book" cards (ConnectPlatforms), in one
 * place, because other copy tells the barber which one to tap. A sentence that
 * names a card by anything other than what the card says sends him looking for
 * a control that does not exist (NoBookingLinkBanner, 2026-10-22).
 */
export const CONNECT_CARD_NAMES = {
  native: "ChairBack Booking",
  acuity: "Acuity",
  square: "Square Appointments",
  link: "Your own link",
} as const;
