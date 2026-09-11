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

export function openAppointment(router: Router, id: string): void {
  router.push({ pathname: "/customer/appointment/[id]", params: { id } });
}

/** The shop's storefront, as this customer's own record sees it. */
export function openStorefront(router: Router, shop: { key: string; name: string }): void {
  router.push({ pathname: "/customer/shop/[key]", params: { key: shop.key, name: shop.name } });
}

/** The shop's manage page for one ChairBack booking (reschedule / cancel). */
export function openManage(router: Router, appointmentId: string, intent: "reschedule" | "cancel"): void {
  router.push({ pathname: "/customer/manage/[id]", params: { id: appointmentId, intent } });
}

/** Directions in the phone's own maps app. */
export function openDirections(address: string): void {
  const q = encodeURIComponent(address);
  const url = Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
  Linking.openURL(url).catch(() => {});
}
