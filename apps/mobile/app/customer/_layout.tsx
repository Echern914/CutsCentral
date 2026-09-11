import { StyleSheet, View } from "react-native";
import { Redirect, Stack, useSegments, type Href } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { CustomerProvider, useCustomer } from "@/src/customer/CustomerProvider";
import { color } from "@/src/customer/theme";

/**
 * My ChairBack - the customer's side of the app.
 *
 *   "I'm a customer" -> /customer -> signed in?  -> the five tabs (Home first)
 *                                   -> signed out -> /customer/sign-in
 *
 * The gate is DECLARATIVE (a <Redirect>, never an imperative router call on
 * mount - the expo-router launch hang this app's root layout warns about).
 * Two screens are open to a signed-out customer: sign-in itself, and `link`,
 * where a tapped /r/<token> link from a shop still opens that shop's page
 * exactly as it always has - the link remains the shortcut it always was.
 *
 * Screens that leave My ChairBack for a shop's own web pages (the storefront,
 * the manage page) are presented as modals with a "Done" button: the
 * WebView's edge-swipe is the WEB page's back gesture, so a native swipe-back
 * would fight it. Nothing a customer opens from here can strand them.
 */
export default function CustomerLayout() {
  return (
    <CustomerProvider>
      <StatusBar style="light" />
      <Gate />
    </CustomerProvider>
  );
}

function Gate() {
  const { status } = useCustomer();
  const segments = useSegments() as string[];
  const leaf = segments[1];
  const openToEveryone = leaf === "sign-in" || leaf === "link";

  let redirect: Href | null = null;
  if (status === "signedOut" && !openToEveryone) redirect = "/customer/sign-in";
  if (status === "signedIn" && leaf === "sign-in") redirect = "/customer";

  return (
    <View style={styles.root}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: color.bg },
          headerStyle: { backgroundColor: color.bg },
          headerTintColor: color.goldText,
          headerTitleStyle: { color: color.text },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="(tabs)" />
        {/* Reached by the gate, not by a tap: it appears, it doesn't slide in. */}
        <Stack.Screen name="sign-in" options={{ animation: "none" }} />
        <Stack.Screen name="appointment/[id]" options={{ headerShown: true, title: "", headerBackTitle: "Back" }} />
        <Stack.Screen name="shop/[key]" options={{ presentation: "fullScreenModal", headerShown: true }} />
        <Stack.Screen name="manage/[id]" options={{ presentation: "modal", headerShown: true, title: "Your appointment" }} />
        <Stack.Screen name="link" options={{ headerShown: true, title: "" }} />
        {/* Connecting a profile is a deliberate detour from the home, and
            nothing else can happen until it is answered or dismissed. */}
        <Stack.Screen
          name="connect"
          options={{ presentation: "modal", headerShown: true, title: "", headerBackTitle: "Back" }}
        />
      </Stack>
      {/* A quiet cover while the keychain answers or a redirect is on its way,
          so no screen flashes that the customer can't actually use. */}
      {status === "loading" || redirect ? <View style={styles.cover} pointerEvents="none" /> : null}
      {redirect ? <Redirect href={redirect} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  cover: { ...StyleSheet.absoluteFillObject, backgroundColor: color.bg },
});
