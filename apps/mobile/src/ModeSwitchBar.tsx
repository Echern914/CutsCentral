import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";

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
 * 🔑 NOTHING IS CLEARED. Not `cb.session`, not `cb.customerToken`, and — since
 * the round trip has a back arrow — not `cb.mode` either.
 *
 * This bar used to delete `cb.mode` before navigating, purely to stop the
 * picker's returning-user <Redirect> from bouncing the user straight back here.
 * That worked, and it made the picker a ONE-WAY DOOR: by the time you arrived,
 * the app had already forgotten which dashboard you came from, so "I opened
 * this by mistake" had no answer but to pick a role again. `?switching=1` says
 * the same thing to the picker ("show yourself, don't redirect") without
 * destroying the one piece of state that knows the way home. Choosing a role is
 * now the ONLY thing that writes `cb.mode`.
 */
export function ModeSwitchBar({ label }: { label: string }) {
  return (
    <View style={styles.bar}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        onPress={() => router.replace({ pathname: "/", params: { switching: "1" } })}
        accessibilityRole="button"
        accessibilityLabel="Switch mode"
        accessibilityHint="Opens the welcome screen to choose shop or customer. You can come straight back."
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
