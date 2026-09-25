import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { WEB_ORIGIN } from "../config";
import { errorCopy } from "./api";
import { invalidate, useCustomer } from "./CustomerProvider";
import type { SavedShop } from "./types";

export type JoinStatus = "joined" | "pending" | "needs_connecting";

/**
 * Where a shop row opens: the booking page when it is ChairBack's own, else the
 * shop's page here. A shop that books through Acuity, Square or its own site
 * has a bookUrl off ChairBack, which the in-app page refuses to load - its
 * ChairBack page is what carries the Book button that links out.
 */
export function shopPageFor(shop: { bookUrl: string; handle: string }): string {
  return shop.bookUrl.startsWith(`${WEB_ORIGIN}/`) ? shop.bookUrl : `${WEB_ORIGIN}/s/${shop.handle}`;
}

/**
 * Joining a shop, and taking a saved shop or a waiting request back off - shared
 * by Home and Book.
 *
 * Joining hands the shop the customer's name and proven contacts, so the join
 * screen says so before the tap. Removing says the other half out loud.
 */
export function useSavedShopActions() {
  const router = useRouter();
  const { api } = useCustomer();

  function open(shop: SavedShop): void {
    router.push({ pathname: "/customer/link", params: { url: shopPageFor(shop), name: shop.name } });
  }

  async function join(handle: string, firstName: string, lastName: string, instagram: string): Promise<JoinStatus> {
    const res = await api.send<{ status: JoinStatus }>("POST", "/api/me/shops/join", {
      handle,
      firstName,
      lastName,
      instagram,
    });
    // The name is the account's too (the greeting), and the shop lists change.
    invalidate("/api/me");
    return res.status;
  }

  function remove(shop: SavedShop, onRemoved: () => void): void {
    const pending = shop.pending === true;
    Alert.alert(
      pending ? `Cancel your request to join ${shop.name}?` : `Remove ${shop.name}?`,
      pending
        ? `${shop.name} won't see your request any more. You can ask again later.`
        : `It comes off your shops, and ${shop.name} will no longer see that you saved them.`,
      [
        { text: pending ? "Keep waiting" : "Keep", style: "cancel" },
        {
          text: pending ? "Cancel request" : "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await api.send("DELETE", `/api/me/shops/saved/${encodeURIComponent(shop.key)}`);
              invalidate("/api/me/home");
              onRemoved();
            } catch (err) {
              Alert.alert(errorCopy(err).title, errorCopy(err).body);
            }
          },
        },
      ],
    );
  }

  return { open, join, remove };
}
