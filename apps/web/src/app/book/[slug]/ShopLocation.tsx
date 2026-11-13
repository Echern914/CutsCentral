import type { BookingPageLocation } from "@chairback/config/shopAddress";

/**
 * WHERE THE SHOP IS, ON THE BOOKING PAGE.
 *
 * Clients kept asking their barber for the address, because it first
 * appeared in the confirmation email. It now sits under the shop name while
 * they book, and again on the booked screen.
 *
 * The API decides what may be shown (config `bookingPageLocation`): the full
 * address with a maps link, or - for a shop that keeps its street private -
 * only the town, with the true promise that the booking brings the rest. A
 * shop with no address, or an API older than the field, renders nothing.
 */

function Pin() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M8 14.5s4.5-4.2 4.5-7.8a4.5 4.5 0 0 0-9 0c0 3.6 4.5 7.8 4.5 7.8z" />
      <circle cx="8" cy="6.7" r="1.6" />
    </svg>
  );
}

/** Under the shop name, before anything is booked. */
export function ShopLocationLine({ location }: { location?: BookingPageLocation | null }) {
  if (!location) return null;
  if (location.address && location.mapsUrl) {
    return (
      <div>
        <a
          href={location.mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-qa="shop-address"
          aria-label={`${location.address} (opens directions)`}
          className="inline-flex min-h-[44px] max-w-full items-center gap-1.5 text-sm text-muted underline decoration-offwhite/30 underline-offset-4 transition-colors hover:text-offwhite hover:decoration-offwhite"
        >
          <Pin />
          <span className="min-w-0">{location.address}</span>
        </a>
      </div>
    );
  }
  if (!location.locality) return null;
  return (
    <div className="mt-2 text-sm text-muted" data-qa="shop-address">
      <span className="inline-flex items-center gap-1.5">
        <Pin />
        {location.locality}
      </span>
      {location.sentAfterBooking && (
        <span className="mt-0.5 block text-xs">The exact address comes with your booking.</span>
      )}
    </div>
  );
}

/** On the booked screen, above the link to their appointment page. */
export function ShopLocationBooked({ location }: { location?: BookingPageLocation | null }) {
  if (!location) return null;
  if (location.address && location.mapsUrl) {
    return (
      <p className="mt-3 text-sm" data-qa="booked-address">
        <span className="text-muted">Where: </span>
        <a
          href={location.mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline decoration-offwhite/30 underline-offset-4 hover:decoration-offwhite"
        >
          {location.address}
        </a>
      </p>
    );
  }
  // The appointment page reads the stored address, private or not: the
  // person on it has booked.
  if (location.sentAfterBooking) {
    return (
      <p className="mt-3 text-sm text-muted" data-qa="booked-address">
        The exact address is on your appointment page.
      </p>
    );
  }
  return null;
}
