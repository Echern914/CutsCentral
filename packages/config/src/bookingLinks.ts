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
 * Does the shop's page show "Request an appointment", and so does the request
 * route take one? ONE rule for both, because they disagreed: the page showed
 * the form to every shop with no way to book (so a client is never left on a
 * dead page), while the route refused every shop with requests switched off.
 * A client at a no-link shop filled it in and got "Something went wrong" on
 * every try, and the barber never saw the request.
 *
 * ChairBack booking replaces the form entirely - it IS self-serve booking.
 */
export function showsRequestForm(shop: {
  bookingMode: string;
  bookingUrl: string | null;
  takesRequests: boolean;
}): boolean {
  if (shop.bookingMode === "native") return false;
  return shop.takesRequests || !isUsableBookingLink(shop.bookingUrl);
}

/**
 * The Book link an automatic or barber-sent MESSAGE carries - nudge, win-back,
 * promotion, text and push alike.
 *
 * bookNowUrl, with one exception: a ChairBack-booking shop that never saved an
 * outside link keeps the message it has always sent - the customer's rewards
 * link alone. Nothing was wrong with those messages (only a saved link pointing
 * at the wrong system was), and a second link would change every text that
 * shop sends: the two-link body carries a "•", which is not GSM-7, so the whole
 * text re-encodes at roughly twice the segments. Adding a Book line for those
 * shops is its own decision, not a side effect of this rule.
 */
export function messageBookingUrl(shop: BookingLinkShop, appBaseUrl: string): string | null {
  if (shop.bookingMode === "native" && !isUsableBookingLink(shop.bookingUrl)) return null;
  return bookNowUrl(shop, appBaseUrl);
}

/**
 * "Book again": the shop's booking page with a past visit's service and
 * provider preselected - `/book/<slug>?service=<id>&staff=<id>`, the rebook
 * prefill the booking page reads (book/[slug]/page.tsx) and lands on the time
 * step. The manage page's "Book a new time" and the app's "Book again" both
 * build it here, so the two can never send a different shape.
 *
 * 🔴 A PREFILL, NEVER A PERMISSION. These ids are already public on the
 * booking page, and the page re-checks them against what the shop offers NOW:
 * a retired service or a provider who no longer does it is dropped, and the
 * customer gets the ordinary booking page. A missing id is simply left off.
 *
 * Plain string work only: imported by client components.
 */
export function rebookPath(
  slug: string,
  prefill: { serviceId?: string | null; staffId?: string | null } | null | undefined,
): string {
  const query: string[] = [];
  if (prefill?.serviceId) query.push(`service=${encodeURIComponent(prefill.serviceId)}`);
  // A provider without a service pre-picks nothing the page can use.
  if (prefill?.serviceId && prefill.staffId) query.push(`staff=${encodeURIComponent(prefill.staffId)}`);
  return `/book/${encodeURIComponent(slug)}${query.length > 0 ? `?${query.join("&")}` : ""}`;
}

// The link a shop HANDS OUT (dashboard link, share tile, QR code, broadcast
// push landing) stays /book/<slug> in every mode, built where it is used. That
// page decides at visit time - the booking form on ChairBack booking, else a
// redirect to the shop's page, whose Book button follows bookNowUrl - so a
// printed code survives a later switch, and it stays a /book/ link, which the
// iOS app claims as a universal link (a /s/ link would open Safari).
