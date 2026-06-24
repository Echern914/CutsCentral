import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";

/**
 * Root layout. Configures how notifications behave while the app is foregrounded
 * (still show the banner) and hosts the stack: the mode picker, then the two
 * WebView screens. Everything else (push registration, deep links) lives in the
 * screens so it runs with the right identity in scope.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function RootLayout() {
  useEffect(() => {
    // Tapping a notification routes via its data.url, handled per-screen.
  }, []);

  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#0A0A0B" },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="customer" />
        <Stack.Screen name="barber" />
      </Stack>
    </>
  );
}
