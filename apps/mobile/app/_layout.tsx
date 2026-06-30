import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import {
  useFonts,
  BricolageGrotesque_700Bold,
} from "@expo-google-fonts/bricolage-grotesque";

/**
 * Root layout.
 *
 * Three things here are load-bearing for the app to actually appear (their
 * absence presented as a permanent "buffering"/blank launch):
 *  1. SplashScreen control: keep the native splash up, then hide it once the
 *     tree has mounted. Without expo-splash-screen + an explicit hide, the
 *     native splash could stay up indefinitely on a release build.
 *  2. SafeAreaProvider: the screens use <SafeAreaView> from
 *     react-native-safe-area-context, which REQUIRES this provider as an
 *     ancestor; without it the safe-area frame can collapse and the WebView
 *     gets zero height (blank screen with the spinner overlay on top).
 *  3. The notification handler is registered in an effect (not at module scope),
 *     so a failure there can never block the first render.
 */

// Keep the native splash visible until the first layout effect hides it. Called
// at module load (before the component) as the splash API requires; guarded so a
// failure never throws at startup.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  // Brand display font (Bricolage Grotesque) for the wordmark, so mobile matches
  // the web --font-display. We hold the native splash until it resolves - but on
  // EITHER loaded OR error, so a font that never loads can never wedge the app on
  // a permanent splash (mirrors this file's other launch-safety guards).
  const [fontsLoaded, fontError] = useFonts({ BricolageGrotesque_700Bold });

  useEffect(() => {
    // Configure foreground notification behavior once, safely.
    try {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          // SDK 54 / expo-notifications 0.32 split the old shouldShowAlert into
          // banner + list (both control foreground presentation on iOS).
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    // Reveal the app once the tree is mounted AND the font has settled.
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded, fontError]);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#0A0A0B" },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="customer" />
        <Stack.Screen name="login" />
        <Stack.Screen name="barber" />
      </Stack>
    </SafeAreaProvider>
  );
}
