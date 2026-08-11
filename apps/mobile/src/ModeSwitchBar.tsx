import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE } from "@/src/config";

/**
 * The way back to the welcome picker.
 *
 * The picker has always promised "You can switch anytime" — and then never
 * delivered it: once `cb.mode` is saved, index.tsx <Redirect>s straight past
 * the picker on every launch, so a barber who is ALSO a customer somewhere
 * (which is most of them) had no route to the other side short of deleting the
 * app. This bar is that route.
 *
 * It lives in the top safe-area strip that barber/customer already reserve
 * above their WebView, so it costs a thin band of chrome that was dark anyway
 * and never covers the web UI underneath — important, because the dashboard's
 * own nav sits at the BOTTOM of the WebView and a floating pill down there
 * would sit on top of a tab.
 *
 * 🔑 ONLY `cb.mode` is cleared. The barber's `cb.session` and the customer's
 * `cb.lastToken` both survive, so switching back is instant — no re-login, no
 * re-texting yourself the magic link. Switching is meant to be cheap enough to
 * do mid-day between a cut and checking your own punches.
 */
export function ModeSwitchBar({ label }: { label: string }) {
  async function switchMode() {
    // Best-effort: if storage fails we still navigate, and the picker's own
    // read-failure path shows the picker rather than hanging.
    try {
      await AsyncStorage.removeItem(STORAGE.mode);
    } catch {
      // ignored — the picker handles an unreadable mode by showing itself
    }
    router.replace("/");
  }

  return (
    <View style={styles.bar}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        onPress={switchMode}
        accessibilityRole="button"
        accessibilityLabel="Switch mode"
        accessibilityHint="Returns to the welcome screen to choose barbershop or customer."
        // A generous tap target on a thin bar: the visible pill is small, the
        // pressable is not.
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>⇄ Switch</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: "#0A0A0B",
  },
  label: {
    color: "#A1A1AA",
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontWeight: "600",
    flexShrink: 1,
  },
  button: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(212,175,55,0.35)",
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  buttonPressed: { backgroundColor: "rgba(212,175,55,0.14)" },
  buttonText: {
    color: "#E6C964",
    fontSize: 12,
    fontWeight: "600",
  },
});
