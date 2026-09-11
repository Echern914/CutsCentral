import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE, rewardsUrl } from "@/src/config";
import { invalidate, useCustomer } from "@/src/customer/CustomerProvider";
import { color, radius, space } from "@/src/customer/theme";
import { Button, Txt } from "@/src/customer/ui";
import { WebPage } from "@/src/customer/WebPage";

/**
 * A link from a shop - a tapped /r/<token> (rewritten here by
 * app/+native-intent.tsx), a pasted one, or a shop found by name. Opens that
 * shop's page exactly as the one-shop app always did: the link is the
 * shortcut it always was, signed in or not. "Done" leads to My ChairBack (or
 * to sign-in, for someone not signed in yet) - never a dead end.
 *
 * For somebody already signed in it is ALSO how a profile gets connected that
 * a shared phone number could never connect on its own - holding this link is
 * the proof the contact alone is not.
 *
 * 🔴 AN OFFER, NEVER AN AUTOMATIC CLAIM. The person tapping may be a parent
 * opening their child's link; connecting it silently would move that child's
 * visits into the parent's account. One clearly labelled tap, never
 * pre-answered, and the page opens the same either way.
 */
export default function LinkScreen() {
  const { token, url, name } = useLocalSearchParams<{ token?: string; url?: string; name?: string }>();
  const { status, api, isDemo } = useCustomer();
  const [offer, setOffer] = useState<"idle" | "busy" | "connected" | "refused" | "dismissed">("idle");

  useEffect(() => {
    // Remembered only so the sign-in screen can offer "Open my shop's page".
    if (token) AsyncStorage.setItem(STORAGE.lastToken, token).catch(() => {});
  }, [token]);

  async function connect() {
    if (!token) return;
    setOffer("busy");
    try {
      await api.send("POST", "/api/me/profiles/claim", { link: token });
      // The home, shops, rewards and history all change with this.
      invalidate("/api/me");
      setOffer("connected");
    } catch {
      // Already connected elsewhere, not this account's contact, or nothing to
      // connect: one answer for all of them. A link that opens nothing must
      // not become a way to learn whose it is.
      setOffer("refused");
    }
  }

  const canOffer = Boolean(token) && status === "signedIn" && !isDemo;

  return (
    <WebPage
      title={name ?? ""}
      banner={
        canOffer && offer !== "dismissed" ? (
          <View style={styles.banner}>
            {offer === "connected" ? (
              <Txt variant="subhead" accessibilityLiveRegion="polite">
                Connected. This profile is part of My ChairBack now.
              </Txt>
            ) : offer === "refused" ? (
              <Txt variant="subhead" tone="secondary" accessibilityLiveRegion="polite">
                We couldn't connect this one. It may already belong to another account - the shop can sort that out.
              </Txt>
            ) : (
              <>
                <Txt variant="subhead" style={styles.bannerText}>
                  Are these visits yours? Connect this profile to My ChairBack.
                </Txt>
                <View style={styles.bannerActions}>
                  <Button
                    label="Connect"
                    busy={offer === "busy"}
                    onPress={() => void connect()}
                    style={styles.bannerButton}
                  />
                  <Button
                    label="Not now"
                    variant="plain"
                    onPress={() => setOffer("dismissed")}
                    style={styles.bannerButton}
                  />
                </View>
              </>
            )}
          </View>
        ) : null
      }
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

const styles = StyleSheet.create({
  banner: {
    margin: space.s2,
    padding: space.s2,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    gap: space.s1,
  },
  bannerText: { marginBottom: space.half },
  bannerActions: { flexDirection: "row", flexWrap: "wrap", gap: space.s1, alignItems: "center" },
  bannerButton: { flexGrow: 1, flexBasis: 120 },
});
