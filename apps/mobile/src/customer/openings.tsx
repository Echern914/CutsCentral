import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { ApiError, errorCopy } from "./api";
import { invalidate, useCustomer } from "./CustomerProvider";
import { dayLabel, money, timeLabel, timeRange } from "./format";
import { priceChange } from "./openingClaim";
import { color, radius, space } from "./theme";
import type { Opening } from "./types";
import { Avatar, Button, Txt } from "./ui";

/**
 * "Held for you": a slot the shop kept for this customer's tier.
 *
 * The card says who it is held for and until when, because that is the whole
 * offer - a Gold member is being given first pick, not a discount. After the
 * hold it goes back on the shop's booking page, so the deadline is the point,
 * and it is stated in the shop's own time (every other time in this app is).
 */

export function OpeningCard({
  opening,
  onBooked,
  now = new Date(),
}: {
  opening: Opening;
  onBooked: () => void;
  now?: Date;
}) {
  const { api } = useCustomer();
  const [busy, setBusy] = useState(false);
  const tz = opening.shop.timezone;
  const what = [opening.serviceName, opening.staffName ? `with ${opening.staffName}` : null].filter(Boolean).join(" ");
  const verb = opening.requiresApproval ? "Request it" : "Book it";
  const priceLabel = (price: number | null) => (price === null ? null : money(Math.round(price * 100)));

  // The confirmation names the price too: it is the figure the server checks
  // the booking against (openingClaim.ts).
  function confirm() {
    const price = priceLabel(opening.price);
    Alert.alert(
      `${verb}?`,
      `${dayLabel(opening.startsAt, tz, now)}, ${timeRange(opening.startsAt, opening.endsAt, tz)} at ${opening.shop.name}${
        what ? ` · ${what}` : ""
      }${price ? ` · ${price}` : ""}.`,
      [
        { text: "Not now", style: "cancel" },
        { text: verb, onPress: () => void book(opening.price) },
      ],
    );
  }

  async function book(expectedPrice: number | null) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.send<{ pending: boolean }>(
        "POST",
        `/api/me/openings/${encodeURIComponent(opening.id)}/book`,
        { expectedPrice },
      );
      // Everything that shows appointments has changed.
      invalidate("/api/me");
      onBooked();
      Alert.alert(
        res.pending ? "Requested" : "You're booked",
        res.pending
          ? `${opening.shop.name} will confirm your time: ${dayLabel(opening.startsAt, tz, now)} at ${timeLabel(opening.startsAt, tz)}.`
          : `${dayLabel(opening.startsAt, tz, now)} at ${timeLabel(opening.startsAt, tz)}. It's on your appointments.`,
      );
    } catch (err) {
      // 🔴 The shop changed the price while this card was open: nothing was
      // booked and the hold stands. Ask again, at the new figure.
      const changed = priceChange(err);
      if (changed) {
        onBooked(); // refresh the card to the new price behind the question
        const next = priceLabel(changed.price);
        Alert.alert(
          "The price changed",
          next ? `This time is now ${next}. ${verb} at ${next}?` : `This time no longer has a listed price. ${verb} anyway?`,
          [
            { text: "Not now", style: "cancel" },
            { text: next ? `${verb} at ${next}` : verb, onPress: () => void book(changed.price) },
          ],
        );
        return;
      }
      // Someone else took it, or the hold ran out while this screen was open.
      const gone =
        err instanceof ApiError && (err.status === 410 || err.status === 409 || err.status === 404);
      if (gone) {
        onBooked();
        Alert.alert("That one's gone", "It was taken or the hold ran out. Your shops are still one tap away.");
      } else {
        Alert.alert(errorCopy(err).title, errorCopy(err).body);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Avatar uri={opening.shop.logoUrl} name={opening.shop.name} size={36} />
        <View style={styles.flex}>
          <Txt variant="headline" numberOfLines={1}>
            {opening.shop.name}
          </Txt>
          <Txt variant="footnote" tone="gold">
            {`Held for ${opening.audience}`}
          </Txt>
        </View>
      </View>

      <Txt variant="title3">{`${dayLabel(opening.startsAt, tz, now)} · ${timeRange(opening.startsAt, opening.endsAt, tz)}`}</Txt>
      {what ? (
        <Txt variant="subhead" tone="secondary">
          {opening.price === null ? what : `${what} · ${money(Math.round(opening.price * 100))}`}
        </Txt>
      ) : null}
      <Txt variant="footnote" tone="secondary">
        {`Yours until ${timeLabel(opening.heldUntil, tz)}, then it's open to anyone.`}
      </Txt>

      <Button label={verb} busy={busy} onPress={confirm} style={styles.action} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.goldTint,
    padding: space.s2,
    gap: space.s1,
    marginBottom: space.s2 - 4,
  },
  head: { flexDirection: "row", alignItems: "center", gap: space.s2 - 4 },
  action: { marginTop: space.s1 },
});
