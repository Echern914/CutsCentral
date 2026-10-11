import { Linking, Platform } from "react-native";
import type { Router } from "expo-router";

/**
 * Every way out of a My ChairBack screen, named once.
 *
 * The shop's storefront, its booking flow, and the manage page (reschedule /
 * cancel, with every fee rule attached) are the EXISTING web pages. The app
 * opens them - it never rebuilds them - in a screen that always has a native
 * way back to My ChairBack.
 */

/**
 * 🔴 ONE TAP, ONE SCREEN. A quick double tap on a row fired two pushes, so two
 * identical screens stacked up: Back (or a swipe) took away the top copy and
 * landed on the SAME screen, which read as "Back doesn't work - sometimes it
 * does". A push to the same place inside this window is the same tap.
 */
const SAME_TAP_MS = 1000;
let lastPush: { key: string; at: number } | null = null;

function pushOnce(router: Router, key: string, push: () => void, now = Date.now()): void {
  if (lastPush && lastPush.key === key && now - lastPush.at < SAME_TAP_MS) return;
  lastPush = { key, at: now };
  push();
}

/** Tests only: forget the last push. */
export function __resetPushGuardForTests(): void {
  lastPush = null;
}

export function openAppointment(router: Router, id: string): void {
  pushOnce(router, `appointment:${id}`, () =>
    router.push({ pathname: "/customer/appointment/[id]", params: { id } }),
  );
}

/** The shop's storefront, as this customer's own record sees it. */
export function openStorefront(router: Router, shop: { key: string; name: string }): void {
  pushOnce(router, `shop:${shop.key}`, () =>
    router.push({ pathname: "/customer/shop/[key]", params: { key: shop.key, name: shop.name } }),
  );
}

/** The shop's manage page for one ChairBack booking (reschedule / cancel). */
export function openManage(router: Router, appointmentId: string, intent: "reschedule" | "cancel"): void {
  pushOnce(router, `manage:${appointmentId}:${intent}`, () =>
    router.push({ pathname: "/customer/manage/[id]", params: { id: appointmentId, intent } }),
  );
}

/** Directions in the phone's own maps app. */
export function openDirections(address: string): void {
  const q = encodeURIComponent(address);
  const url = Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
  Linking.openURL(url).catch(() => {});
}
