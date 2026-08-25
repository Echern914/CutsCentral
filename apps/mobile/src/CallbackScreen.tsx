import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { completeFromUrl } from "./joinAuth";

/**
 * Finishing "Join your shop" when the app is opened BY the callback rather than
 * by the authentication sheet closing.
 *
 * Two links land here and they are the same screen on purpose:
 *  - chairback://auth/callback  the custom scheme, if it reaches the router
 *    instead of being swallowed by the open authentication session;
 *  - https://getchairback.com/auth/mobile/callback  the verified universal
 *    link, which is what happens when the barber finished in ordinary Safari
 *    (they dismissed the sheet, or opened the invitation email on their phone)
 *    and the OS hands the URL to the app.
 *
 * The state check inside completeFromUrl is what makes this safe to expose to
 * any link on the device: a callback that doesn't match the attempt THIS app
 * started buys nothing, and neither does one whose PKCE verifier we don't hold.
 */
export function CallbackScreen() {
  const params = useLocalSearchParams<{ code?: string; state?: string }>();
  const [failure, setFailure] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const { code, state } = params;
      if (!code || !state) {
        // Opened with nothing to finish - send them where they were going.
        router.replace("/login");
        return;
      }
      const result = await completeFromUrl(
        `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      );
      if (result === "joined") {
        router.replace("/barber");
        return;
      }
      if (result === "not_ours" || result === "no_attempt") {
        // Not this device's flow (or it went stale). Nothing to explain, and
        // nothing to worry about: their seat, if they accepted, already exists.
        router.replace("/login");
        return;
      }
      setFailure(
        result === "offline"
          ? "We couldn't reach ChairBack. Check your connection and try again."
          : "That sign-in link has already been used or has expired. Start again from Join your shop.",
      );
    })();
  }, [params]);

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safe}>
        {failure ? (
          <View style={styles.center}>
            <Text style={styles.title}>Almost there</Text>
            <Text style={styles.body}>{failure}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace("/join")}
              style={styles.primary}
            >
              <Text style={styles.primaryText}>Back to Join your shop</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color="#D4AF37" />
            <Text style={styles.body}>Signing you in…</Text>
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0A0A0B" },
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
  title: { color: "#F5F5F4", fontSize: 22, fontWeight: "700", marginBottom: 10 },
  body: {
    color: "#A1A1AA",
    fontSize: 16,
    lineHeight: 23,
    textAlign: "center",
    marginTop: 12,
  },
  primary: {
    minHeight: 52,
    marginTop: 24,
    borderRadius: 14,
    backgroundColor: "#D4AF37",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  primaryText: { color: "#0A0A0B", fontSize: 16, fontWeight: "700" },
});
