import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useResource } from "@/src/customer/CustomerProvider";
import { Screen } from "@/src/customer/Screen";
import { errorCopy } from "@/src/customer/api";
import { dayLabel, money, timeRange, untilLabel } from "@/src/customer/format";
import { Cancel, MapPin, Reschedule, Store } from "@/src/customer/icons";
import { openDirections, openManage, openStorefront } from "@/src/customer/navigate";
import { color, space } from "@/src/customer/theme";
import type { AppointmentDetail } from "@/src/customer/types";
import { Avatar, Button, ErrorState, Group, Placeholder, Row, Separator, StatusLabel, Txt } from "@/src/customer/ui";

/**
 * One appointment, Wallet-clear: when, what, with whom, where, and what can be
 * done about it. Reschedule and cancel hand off to the shop's own manage page,
 * where every fee and deposit rule already lives - they are not re-implemented
 * here. A booking another system holds (Acuity, Square) says so plainly.
 */
export default function AppointmentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const res = useResource<{ appointment: AppointmentDetail }>(id ? `/api/me/appointments/${encodeURIComponent(id)}` : null);
  const a = res.data?.appointment;

  if (!a) {
    return (
      <Screen underNavBar>
        {res.loading ? <Placeholder height={320} /> : <ErrorState {...errorCopy(res.error)} onRetry={res.refresh} />}
      </Screen>
    );
  }

  const until = untilLabel(new Date(a.startsAt), new Date(), a.timezone);
  const upcoming = a.status === "booked" || a.status === "requested";

  return (
    <Screen underNavBar refreshing={res.refreshing} onRefresh={res.refresh}>
      <View style={styles.head}>
        <Avatar uri={a.providerImageUrl ?? a.shop.logoUrl} name={a.providerName ?? a.shop.name} size={64} />
        <Txt variant="title1" accessibilityRole="header" style={styles.day}>
          {dayLabel(a.startsAt, a.timezone)}
        </Txt>
        <Txt variant="title3" tone="secondary">
          {timeRange(a.startsAt, a.endsAt, a.timezone)}
        </Txt>
        {upcoming && until ? (
          <Txt variant="subhead" tone="secondary">
            {until[0]!.toUpperCase() + until.slice(1)}
          </Txt>
        ) : null}
        <View style={styles.status}>
          <StatusLabel status={a.status} label={a.statusLabel} />
        </View>
        {a.statusDetail ? (
          <Txt variant="footnote" tone="secondary">
            {a.statusDetail}
          </Txt>
        ) : null}
      </View>

      <Group>
        {a.serviceName ? <Row title="Service" subtitle={a.serviceName} chevron={false} /> : null}
        {a.providerName ? (
          <>
            <Separator />
            <Row title="With" subtitle={a.providerName} chevron={false} />
          </>
        ) : null}
        <Separator />
        <Row title="Shop" subtitle={a.shop.name} chevron={false} />
        {a.address ? (
          <>
            <Separator />
            <Row
              title="Where"
              subtitle={a.address}
              onPress={() => openDirections(a.address!)}
              accessibilityHint="Opens directions in Maps"
            />
          </>
        ) : null}
        {a.priceCents !== null ? (
          <>
            <Separator />
            <Row title="Price" subtitle={money(a.priceCents)} chevron={false} />
          </>
        ) : null}
      </Group>

      <View style={styles.actions}>
        {a.canManage ? (
          <>
            <Button
              label="Reschedule"
              variant="secondary"
              icon={<Reschedule size={18} color={color.text} />}
              onPress={() => openManage(router, a.id, "reschedule")}
              accessibilityHint="Opens the shop's booking page for this appointment"
            />
            <Button
              label="Cancel appointment"
              variant="secondary"
              icon={<Cancel size={18} color={color.text} />}
              onPress={() => openManage(router, a.id, "cancel")}
              accessibilityHint="Opens the shop's booking page, where you can cancel and see any fee first"
            />
          </>
        ) : null}
        {a.address && upcoming ? (
          <Button
            label="Directions"
            variant="secondary"
            icon={<MapPin size={18} color={color.text} />}
            onPress={() => openDirections(a.address!)}
          />
        ) : null}
        {a.manageNote ? (
          <Txt variant="footnote" tone="secondary" style={styles.note}>
            {a.manageNote}
          </Txt>
        ) : null}
        <Button
          label={upcoming ? `Visit ${a.shop.name}` : "Book again"}
          icon={<Store size={18} color={color.onGold} />}
          onPress={() => openStorefront(router, a.shop)}
          accessibilityHint="Opens the shop's page"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: "flex-start", gap: space.half, marginBottom: space.s3 },
  day: { marginTop: space.s2 },
  status: { marginTop: space.s1, flexDirection: "row" },
  actions: { marginTop: space.s3, gap: space.s1 + 4 },
  note: { textAlign: "center" },
});
