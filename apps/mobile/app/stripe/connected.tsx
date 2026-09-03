import { useEffect } from "react";
import { router } from "expo-router";

/**
 * chairback://stripe/connected - the Stripe connection's return.
 *
 * Usually unreachable by design: while the authentication sheet is open, the
 * OS consumes this URL to close it and hands it to AppWebView as a RESULT,
 * which reloads the payments page with the outcome. This route catches the
 * leftovers (the sheet was dismissed early, or the link was opened from
 * somewhere else on the device) and simply lands the barber back in the shop.
 */
export default function StripeConnectedRoute() {
  useEffect(() => {
    router.replace("/barber");
  }, []);
  return null;
}
