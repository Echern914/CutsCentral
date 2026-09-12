import { Alert } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { invalidate, useCustomer } from "@/src/customer/CustomerProvider";
import { WebPage } from "@/src/customer/WebPage";

/**
 * A shop's storefront - the existing /r/<token> page (hero, Book, rewards,
 * waitlist, reviews), opened as this customer's own record so booking knows
 * them and "Your rewards" is one tap in. Nothing here is rebuilt; "Done"
 * returns to My ChairBack from wherever the page has gone.
 */
export default function ShopScreen() {
  const { key, name } = useLocalSearchParams<{ key: string; name?: string }>();
  const { api } = useCustomer();

  return (
    <WebPage
      title={name ?? ""}
      load={async () => (await api.get<{ url: string }>(`/api/me/shops/${encodeURIComponent(key)}/storefront`)).url}
      // Whatever happened inside (a booking, a cancellation) shows on return.
      onClose={() => invalidate("/api/me")}
      onMessage={(data) => {
        // The page's own "Delete my data" erased this record: the link is dead
        // and the shop drops off My ChairBack on the next load.
        if (data === "cb:deleted") {
          invalidate("/api/me");
          Alert.alert("Deleted", `${name ?? "The shop"} no longer has your details.`);
        }
      }}
    />
  );
}
