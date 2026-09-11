import { useLocalSearchParams } from "expo-router";
import { invalidate, useCustomer } from "@/src/customer/CustomerProvider";
import { WebPage } from "@/src/customer/WebPage";

/**
 * Reschedule or cancel: the shop's own manage page for this booking. The
 * cancellation window, deposits, card-on-file fees and standing-appointment
 * choices all live there already, with their disclosures - so this screen is a
 * frame around it, never a second implementation of any of it.
 */
export default function ManageScreen() {
  const { id } = useLocalSearchParams<{ id: string; intent?: string }>();
  const { api } = useCustomer();
  return (
    <WebPage
      title="Your appointment"
      load={async () => (await api.get<{ url: string }>(`/api/me/appointments/${encodeURIComponent(id)}/manage`)).url}
      onClose={() => invalidate("/api/me")}
    />
  );
}
