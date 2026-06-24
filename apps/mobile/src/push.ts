import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { WEB_ORIGIN } from "./config";

/**
 * Native push (APNs/FCM via Expo's push service). This is the iOS-app twin of
 * the web's VAPID push: the app asks the OS for permission, gets an Expo push
 * token, and registers it with our backend tagged to the current identity:
 *  - customer: their magicToken (so loyalty/rebooking events reach the device)
 *  - barber:   their session (so business events reach the device)
 *
 * Everything here is best-effort: a denied permission or a registration failure
 * must never block the app - the WebView still works, you just don't get push.
 */

export async function getExpoPushToken(): Promise<string | null> {
  // Push only works on a physical device (simulators have no APNs token).
  if (!Device.isDevice) return null;

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== "granted") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ||
    Constants.easConfig?.projectId;
  try {
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return token.data;
  } catch {
    return null;
  }
}

/**
 * Register a CUSTOMER device for native push, keyed by their magicToken. Hits a
 * public, token-keyed endpoint that mirrors the web push-subscribe route.
 */
export async function registerCustomerPush(magicToken: string): Promise<void> {
  const token = await getExpoPushToken();
  if (!token) return;
  await fetch(`${WEB_ORIGIN}/r/${encodeURIComponent(magicToken)}/push/native`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expoPushToken: token, platform: Platform.OS }),
  }).catch(() => {});
}

/**
 * Register a BARBER device for native push. The WebView holds the session, so
 * the native side can't read the cookie directly; instead the page posts a
 * short-lived bearer token out to the app (via the WebView bridge), which we
 * forward here. Until that bridge is wired this is a no-op-safe stub.
 */
export async function registerBarberPush(bearer: string): Promise<void> {
  const token = await getExpoPushToken();
  if (!token) return;
  await fetch(`${WEB_ORIGIN}/api/dashboard/push/native`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ expoPushToken: token, platform: Platform.OS }),
  }).catch(() => {});
}
