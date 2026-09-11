import { useEffect } from "react";
import { useLocalSearchParams } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE, rewardsUrl } from "@/src/config";
import { WebPage } from "@/src/customer/WebPage";

/**
 * A link from a shop - a tapped /r/<token> (rewritten here by
 * app/+native-intent.tsx), a pasted one, or a shop found by name. Opens that
 * shop's page exactly as the one-shop app always did: the link is the
 * shortcut it always was, signed in or not. "Done" leads to My ChairBack (or
 * to sign-in, for someone not signed in yet) - never a dead end.
 */
export default function LinkScreen() {
  const { token, url, name } = useLocalSearchParams<{ token?: string; url?: string; name?: string }>();

  useEffect(() => {
    // Remembered only so the sign-in screen can offer "Open my shop's page".
    if (token) AsyncStorage.setItem(STORAGE.lastToken, token).catch(() => {});
  }, [token]);

  return (
    <WebPage
      title={name ?? ""}
      load={async () => {
        if (token) return rewardsUrl(token);
        if (url) return url; // WebPage refuses anything off ChairBack's origin.
        throw new Error("no_link");
      }}
      onMessage={(data) => {
        if (data === "cb:deleted") AsyncStorage.removeItem(STORAGE.lastToken).catch(() => {});
      }}
    />
  );
}
