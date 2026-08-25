import { Redirect, useLocalSearchParams } from "expo-router";

/**
 * https://getchairback.com/team/join?token=... opened on a phone with the app
 * installed.
 *
 * This route exists because the app CLAIMS that path as a universal link (see
 * the AASA route on the web). A claimed path with no route behind it is worse
 * than not claiming it: the OS hands the URL to the app and expo-router shows
 * its "unmatched route" screen, so tapping the invitation email would look
 * broken. Here it instead lands on Join your shop with the invitation already
 * filled in - the shortest version of this whole flow.
 *
 * A missing/garbled token falls through to the same screen with an empty field
 * rather than an error; inviteTokenFrom() is the one place that judges shape.
 */
export default function TeamJoinDeepLink() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return (
    <Redirect href={token ? `/join?invite=${encodeURIComponent(token)}` : "/join"} />
  );
}
