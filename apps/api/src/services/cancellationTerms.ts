import {
  bookingCancellationTerms,
  type CancellationTerms,
  type CancellationTermsSnapshot,
} from "@chairback/config";
import { prisma } from "@chairback/db";

/**
 * Which cancellation terms an EXISTING booking is settled by - the server half
 * of config/shopPolicy.ts `bookingCancellationTerms`.
 *
 * Every surface that charges, refunds or QUOTES a cancellation or no-show fee
 * for one booking asks here: the cancel engine, the card-on-file settlement,
 * the client's appointment page, the receptionist and the Wallet pass. Asking
 * the shop directly is how a policy tightened today reached a booking made
 * under the old one.
 */

/** The snapshot columns, for a Prisma `select` on Appointment. */
export const CANCELLATION_TERMS_SNAPSHOT_SELECT = {
  cancelWindowHoursAtBooking: true,
  cancelFeeBpsAtBooking: true,
  cardOnFileFeesAtBooking: true,
  cardFeeFlatCentsAtBooking: true,
} as const;

/** The shop columns a booking with no snapshot falls back to. */
export const SHOP_CANCELLATION_TERMS_SELECT = {
  cancelWindowHours: true,
  cancelFeeBps: true,
  chargeCardOnFileFees: true,
  cardFeeFlatCents: true,
} as const;

/** No shop row: nothing may be charged on terms nobody can read. */
const NOTHING_CHARGED: CancellationTerms = {
  cancelWindowHours: 0,
  cancelFeeBps: 0,
  chargeCardOnFileFees: false,
  cardFeeFlatCents: null,
};

/**
 * The terms this booking is settled by: its own snapshot, or - a booking made
 * before snapshots existed - the shop's current settings, as it always was.
 *
 * Shop carries RLS with no policy for the app role: read directly here, never
 * from inside runWithShop, where the row reads as null.
 */
export async function termsForBooking(
  shopId: string,
  snapshot: CancellationTermsSnapshot,
): Promise<CancellationTerms> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: SHOP_CANCELLATION_TERMS_SELECT,
  });
  return bookingCancellationTerms(snapshot, shop ?? NOTHING_CHARGED);
}
