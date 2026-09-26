import { useEffect, useState } from "react";
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import { router } from "expo-router";
import { API_ORIGIN } from "./config";
import { APP_STORE_URL, checkForRequiredUpdate } from "./updateGate";

/**
 * "Update ChairBack" - shown over everything when this build is older than the
 * API's minimum. The rule, and why every doubt means "carry on", is in
 * src/updateGate.ts.
 *
 * Checked on launch and each time the app returns to the foreground, so a
 * customer who taps Update, installs, and comes back is let straight in, and a
 * minimum lowered on the server releases a blocked phone on its next open.
 */
export function useUpdateRequired(): boolean {
  const [required, setRequired] = useState(false);

  useEffect(() => {
    // The minimum is an iOS build number; nothing else can be compared to it.
    if (Platform.OS !== "ios") return;
    // The INSTALLED binary's CFBundleVersion, read natively - not the config
    // the JS was bundled with, which is only a fallback.
    const build = Constants.platform?.ios?.buildNumber ?? Constants.expoConfig?.ios?.buildNumber;
    let alive = true;
    const check = () => {
      void checkForRequiredUpdate((url, init) => fetch(url, init), API_ORIGIN, build).then(
        (answer) => {
          // null = couldn't tell: keep what we last knew.
          if (!alive || answer === null) return;
          if (answer) closeModalScreens();
          setRequired(answer);
        },
      );
    };
    check();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return required;
}

/**
 * 🔴 The shop page, Join and "Your appointment" open as NATIVE modals, which
 * iOS draws above the whole React root - above this screen too. Left open,
 * a customer could keep using an out-of-date build there until they closed
 * it. So a "must update" answer closes them first. Whatever it pops back to is
 * hidden under the update screen anyway.
 */
function closeModalScreens(): void {
  try {
    if (router.canDismiss()) router.dismissAll();
  } catch {
    // Navigation not ready yet: nothing can be open above us either.
  }
}

export function UpdateRequired() {
  return (
    // accessibilityViewIsModal: VoiceOver must not reach the app underneath,
    // any more than a finger can.
    <View style={styles.root} accessibilityViewIsModal>
      <Text style={styles.title} accessibilityRole="header">
        Update ChairBack
      </Text>
      <Text style={styles.body}>
        This version of the app is out of date. Update it from the App Store to keep using
        ChairBack.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => void Linking.openURL(APP_STORE_URL).catch(() => {})}
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
      >
        <Text style={styles.primaryText}>Update</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#0A0A0B",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
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
    paddingHorizontal: 32,
  },
  pressed: { opacity: 0.85 },
  primaryText: { color: "#0A0A0B", fontSize: 16, fontWeight: "700" },
});
