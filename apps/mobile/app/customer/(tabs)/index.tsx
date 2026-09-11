import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useRegisterDevice, useResource } from "@/src/customer/CustomerProvider";
import { Screen } from "@/src/customer/Screen";
import { errorCopy } from "@/src/customer/api";
import { greeting } from "@/src/customer/format";
import { openAppointment, openDirections, openManage, openStorefront } from "@/src/customer/navigate";
import {
  ConnectProfileList,
  HistoryGroup,
  NextAppointmentCard,
  NoUpcomingCard,
  RewardSummaryList,
  ShopList,
} from "@/src/customer/sections";
import { space } from "@/src/customer/theme";
import type { Home } from "@/src/customer/types";
import {
  Button,
  ErrorState,
  Placeholder,
  ProfileButton,
  SectionHeader,
  StaleBanner,
  Tap,
  Txt,
  Wordmark,
} from "@/src/customer/ui";

/**
 * MY CHAIRBACK - the customer's own home, not any one shop's.
 *
 * Order is importance: the next appointment (the thing they opened the app
 * for), then their shops (one tap from booking again), rewards where a shop
 * offers them, and the most recent visits.
 */
export default function HomeScreen() {
  const router = useRouter();
  const home = useResource<Home>("/api/me/home");
  useRegisterDevice();

  const data = home.data;
  const firstName = data?.firstName ?? null;

  return (
    <Screen
      refreshing={home.refreshing}
      onRefresh={home.refresh}
      header={
        <View style={styles.header}>
          <Wordmark />
          <ProfileButton name={firstName} onPress={() => router.navigate("/customer/profile")} />
        </View>
      }
    >
      <Txt variant="title1" accessibilityRole="header" style={styles.greeting}>
        {firstName ? `${greeting()}, ${firstName}` : greeting()}
      </Txt>

      {home.stale ? <StaleBanner onRetry={home.refresh} /> : null}

      {!data && home.loading ? (
        <View style={styles.placeholders} accessibilityLabel="Loading your appointments" accessible>
          <Placeholder height={300} />
          <Placeholder height={140} />
        </View>
      ) : !data ? (
        <ErrorState {...errorCopy(home.error)} onRetry={home.refresh} />
      ) : (
        <HomeBody data={data} />
      )}
    </Screen>
  );
}

function HomeBody({ data }: { data: Home }) {
  const router = useRouter();
  const next = data.next;
  const moreUpcoming = data.upcomingCount - (next ? 1 : 0);
  // An app build can outlive the API build that answers it (there is no
  // over-the-air channel): a missing list is an empty one, never a crash.
  const ambiguous = data.ambiguous ?? [];

  return (
    <View>
      {next ? (
        <NextAppointmentCard
          appt={next}
          onDetails={() => openAppointment(router, next.id)}
          onDirections={next.address ? () => openDirections(next.address!) : undefined}
          onReschedule={next.canManage ? () => openManage(router, next.id, "reschedule") : undefined}
          onCancel={next.canManage ? () => openManage(router, next.id, "cancel") : undefined}
        />
      ) : (
        <NoUpcomingCard serviceNoun={data.vocabulary.serviceNoun} onBook={() => router.navigate("/customer/book")} />
      )}

      {moreUpcoming > 0 ? (
        <Tap
          onPress={() => router.navigate("/customer/appointments")}
          accessibilityLabel={`${moreUpcoming} more upcoming`}
          accessibilityHint="Opens your appointments"
          style={styles.moreUpcoming}
        >
          <Txt variant="subhead" tone="gold">
            {`${moreUpcoming} more upcoming`}
          </Txt>
        </Tap>
      ) : null}

      {/* No section action: every row IS "Book" - a third one here was noise. */}
      {data.shops.length > 0 ? (
        <>
          <SectionHeader title={`Your ${data.vocabulary.providerNounPlural}`} />
          <ShopList shops={data.shops} onOpen={(shop) => openStorefront(router, shop)} />
        </>
      ) : ambiguous.length === 0 ? (
        <>
          <SectionHeader title={`Your ${data.vocabulary.providerNounPlural}`} />
          <View style={styles.findCard}>
            <Txt variant="subhead" tone="secondary">
              Shops you've booked with show up here once you've signed in with the same number or email you gave them.
            </Txt>
            <Button label="Find a shop" variant="secondary" onPress={() => router.navigate("/customer/book")} style={styles.findButton} />
          </View>
        </>
      ) : null}
      {/* Nothing here yet AND a profile we can't open: "sign in with the same
          number" would be nonsense - they did, and it is the reason the shop
          below is waiting. The connect section speaks for this one. */}

      {/* A profile we won't open on a shared contact alone. Placed under the
          shops, because it IS a shop of theirs - one we can't safely show
          yet - and never above the appointment they opened the app for. */}
      {ambiguous.length > 0 ? (
        <>
          <SectionHeader title="Needs connecting" />
          <Txt variant="subhead" tone="secondary" style={styles.connectNote}>
            {ambiguous.length === 1
              ? "Someone else's profile uses the same number or email, so we can't tell which one is yours. Open the link the shop sent you to connect it."
              : "Other profiles use the same number or email, so we can't tell which ones are yours. Open the link each shop sent you to connect them."}
          </Txt>
          <ConnectProfileList
            shops={ambiguous}
            onConnect={(shop) =>
              router.navigate({ pathname: "/customer/connect", params: { shop: shop.name } })
            }
          />
        </>
      ) : null}

      {data.rewards.length > 0 ? (
        <>
          <SectionHeader
            title="Rewards"
            action="See all"
            onAction={() => router.navigate("/customer/rewards")}
            actionHint="Opens your rewards"
          />
          <RewardSummaryList rewards={data.rewards} onOpen={() => router.navigate("/customer/rewards")} />
        </>
      ) : null}

      {data.recent.length > 0 ? (
        <>
          <SectionHeader
            title="Recent visits"
            action="See all"
            onAction={() => router.navigate("/customer/appointments")}
            actionHint="Opens your appointment history"
          />
          <HistoryGroup
            items={data.recent}
            onOpen={(a) => openAppointment(router, a.id)}
            onBookAgain={(a) => openStorefront(router, a.shop)}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  greeting: { marginTop: space.s2, marginBottom: space.s3 - 4 },
  placeholders: { gap: space.s2 },
  moreUpcoming: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", marginTop: space.half },
  findCard: { gap: space.s2 },
  findButton: { alignSelf: "flex-start" },
  connectNote: { marginBottom: space.s2 - 4 },
});
