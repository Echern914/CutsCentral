/**
 * WHERE "BOOK" GOES - the one rule for every surface that sends a customer to
 * book, so a message, a button and a printed code can never disagree.
 *
 * The shop's booking MODE decides, never whether a link happens to be saved:
 *
 *  - ChairBack booking: the shop's own booking page, /book/<slug>. Even when an
 *    old Acuity/Booksy link is still saved - switching modes never clears it,
 *    and that link sends the customer to the system the shop just left.
 *  - Any other mode: the saved link, when it is one a customer can open.
 *  - Nothing usable: null, and each caller keeps its own fallback (the rewards
 *    page for a message, no button for a page).
 *
 * 🔴 NEVER FOR MANAGING AN EXISTING APPOINTMENT. A booking that still lives in
 * Acuity is changed through Acuity's own link on that visit
 * (Visit.customerManageUrl), and a ChairBack booking through its manage token.
 * Pointing either at "where Book goes" would make a second booking instead.
 */

/** The four shop facts the rule reads. */
export interface BookingLinkShop {
  bookingMode: string;
  bookingUrl: string | null;
  slug: string | null;
  publicPageEnabled: boolean;
}

/**
 * Could a customer actually open this saved link? The rule the write path
 * enforces (a real URL with an http(s) scheme), re-checked because callers read
 * the stored row, and a value that reached it another way never met it.
 */
export function isUsableBookingLink(url: string | null | undefined): boolean {
  const value = url?.trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== ""
    );
  } catch {
    return false;
  }
}

const trimBase = (base: string) => base.replace(/\/+$/, "");

/**
 * Where a customer goes to book right now, or null when there is nowhere.
 *
 * ChairBack booking needs the public page on: the booking page refuses a shop
 * whose page is switched off, so a link to it would be a dead end.
 */
export function bookNowUrl(shop: BookingLinkShop, appBaseUrl: string): string | null {
  if (shop.bookingMode === "native") {
    return shop.publicPageEnabled && shop.slug
      ? `${trimBase(appBaseUrl)}/book/${shop.slug}`
      : null;
  }
  return isUsableBookingLink(shop.bookingUrl) ? shop.bookingUrl!.trim() : null;
}

/**
 * The link a shop HANDS OUT - copied, shared, printed as a QR code.
 *
 * On ChairBack booking that is the booking page itself. Otherwise it is the
 * shop's ChairBack page, whose Book button follows bookNowUrl: a code printed
 * today keeps working when the shop later changes how it takes bookings, which
 * a code pointing straight at Acuity would not. Null until the shop has a
 * handle.
 */
export function shareUrl(
  shop: Pick<BookingLinkShop, "bookingMode" | "slug">,
  appBaseUrl: string,
): string | null {
  if (!shop.slug) return null;
  const base = trimBase(appBaseUrl);
  return shop.bookingMode === "native" ? `${base}/book/${shop.slug}` : `${base}/s/${shop.slug}`;
}
