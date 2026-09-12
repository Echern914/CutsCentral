import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useResource } from "@/src/customer/CustomerProvider";
import { Screen } from "@/src/customer/Screen";
import { errorCopy } from "@/src/customer/api";
import { openAppointment, openStorefront } from "@/src/customer/navigate";
import { HistoryGroup } from "@/src/customer/sections";
import { space } from "@/src/customer/theme";
import type { History } from "@/src/customer/types";
import { EmptyState, ErrorState, Placeholder, SectionHeader, StaleBanner } from "@/src/customer/ui";

/**
 * Every appointment the customer has at every shop they're linked to - ChairBack
 * bookings and Acuity/Square visits together, each with one canonical status.
 * Upcoming soonest-first, then the past newest-first.
 */
export default function AppointmentsScreen() {
  const router = useRouter();
  const history = useResource<History>("/api/me/appointments");
  const data = history.data;

  return (
    <Screen title="Appointments" refreshing={history.refreshing} onRefresh={history.refresh}>
      {history.stale ? <StaleBanner onRetry={history.refresh} /> : null}
      {!data && history.loading ? (
        <View style={styles.placeholders}>
          <Placeholder height={76} />
          <Placeholder height={76} />
          <Placeholder height={76} />
        </View>
      ) : !data ? (
        <ErrorState {...errorCopy(history.error)} onRetry={history.refresh} />
      ) : data.upcoming.length === 0 && data.past.length === 0 ? (
        <EmptyState
          title="No appointments yet"
          body="When you book with a shop on ChairBack, your appointments show up here."
          action="Book an appointment"
          onAction={() => router.navigate("/customer/book")}
        />
      ) : (
        <>
          <SectionHeader title="Upcoming" />
          {data.upcoming.length > 0 ? (
            <HistoryGroup
              items={data.upcoming}
              onOpen={(a) => openAppointment(router, a.id)}
              onBookAgain={(a) => openStorefront(router, a.shop)}
            />
          ) : (
            <EmptyState title="Nothing booked" action="Book an appointment" onAction={() => router.navigate("/customer/book")} />
          )}
          {data.past.length > 0 ? (
            <>
              <SectionHeader title="Past" />
              <HistoryGroup
                items={data.past}
                onOpen={(a) => openAppointment(router, a.id)}
                onBookAgain={(a) => openStorefront(router, a.shop)}
              />
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  placeholders: { gap: space.s1 },
});
