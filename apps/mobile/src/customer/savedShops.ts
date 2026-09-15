import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, errorCopy } from "./api";
import { invalidate, useCustomer } from "./CustomerProvider";
import type { SavedShop } from "./types";

export type AddOutcome = "added" | "name_required" | "not_found" | "failed";

/**
 * "Add to my shops", and taking a shop back off - shared by Home and Book.
 *
 * Adding is the moment a shop learns this person's name, so the screens say so
 * before the tap, and the API refuses an account with no name (name_required)
 * rather than showing the shop a blank. Removing says the other half out loud:
 * the shop stops seeing that they saved it.
 */
export function useSavedShopActions() {
  const router = useRouter();
  const { api } = useCustomer();

  function open(shop: { bookUrl: string; name: string }): void {
    router.push({ pathname: "/customer/link", params: { url: shop.bookUrl, name: shop.name } });
  }

  async function add(handle: string): Promise<AddOutcome> {
    try {
      await api.send("POST", "/api/me/shops/saved", { handle });
      invalidate("/api/me/home");
      return "added";
    } catch (err) {
      if (err instanceof ApiError && err.code === "name_required") return "name_required";
      if (err instanceof ApiError && err.status === 404) return "not_found";
      Alert.alert(errorCopy(err).title, errorCopy(err).body);
      return "failed";
    }
  }

  function remove(shop: SavedShop, onRemoved: () => void): void {
    Alert.alert(
      `Remove ${shop.name}?`,
      `It comes off your shops, and ${shop.name} will no longer see that you saved them.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Remove",
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

  return { open, add, remove };
}
