import { CallbackScreen } from "@/src/CallbackScreen";

/**
 * https://getchairback.com/auth/mobile/callback - the VERIFIED universal link,
 * and the preferred way back into the app: unlike a custom scheme, only a build
 * signed by us and vouched for by that domain's apple-app-site-association can
 * claim it.
 *
 * The path here must stay in step with MOBILE_APP.authCallbackPath in
 * @chairback/config, the AASA route, and the Android intent filter - four
 * places, one string, and a mismatch shows up only as "the link opens Safari".
 */
export default function MobileAuthCallbackRoute() {
  return <CallbackScreen />;
}
