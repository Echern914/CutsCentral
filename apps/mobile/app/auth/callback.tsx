import { CallbackScreen } from "@/src/CallbackScreen";

/**
 * chairback://auth/callback - the custom-scheme return.
 *
 * Usually unreachable by design: while the authentication session is open, iOS
 * consumes this URL to close the sheet and hands it to us as a RESULT instead
 * of a navigation. This route is what catches the leftovers - the sheet was
 * dismissed early, or the link was opened from somewhere else on the device.
 */
export default function AuthCallbackRoute() {
  return <CallbackScreen />;
}
