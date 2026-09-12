import { StyleSheet, View } from "react-native";
import { color, radius, space, TOUCH } from "./theme";
import {
  calendarBlock,
  dayLabel,
  progressLine,
  remainingLine,
  shortDate,
  spokenWhen,
  timeRange,
  untilLabel,
} from "./format";
import { Cancel, Details, MapPin, Reschedule } from "./icons";
import { Avatar, Button, Group, ProgressBar, Row, Separator, StatusLabel, Tap, Txt, useLargeText } from "./ui";
import type {
  AmbiguousShop,
  Appointment,
  AppointmentDetail,
  RewardProgram,
  RewardSummary,
  Shop,
} from "./types";

/**
 * The home's building blocks - pure presentation, data in and callbacks out,
 * so the same components render in the app and in the visual-check harness.
 */

// ---------------------------------------------------------------------------
// Next appointment - the most important thing on the screen
// ---------------------------------------------------------------------------

export function NextAppointmentCard({
  appt,
  now = new Date(),
  onDetails,
  onDirections,
  onReschedule,
  onCancel,
}: {
  appt: Appointment | AppointmentDetail;
  now?: Date;
  onDetails: () => void;
  onDirections?: () => void;
  onReschedule?: () => void;
  onCancel?: () => void;
}) {
  const until = untilLabel(new Date(appt.startsAt), now, appt.timezone);
  const who = appt.providerName ? `with ${appt.providerName}` : null;
  const place = [appt.shop.city, appt.shop.region].filter(Boolean).join(", ");
  const spoken = [
    "Next appointment",
    spokenWhen(appt.startsAt, appt.timezone),
    until,
    appt.serviceName,
    who,
    `at ${appt.shop.name}`,
    appt.statusLabel,
    appt.statusDetail,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <View style={styles.card}>
      <Tap onPress={onDetails} accessibilityLabel={spoken} accessibilityHint="Opens the appointment" pressedStyle={styles.cardPressed}>
        <View style={styles.cardTop}>
          <View style={styles.who}>
            <Avatar uri={appt.providerImageUrl ?? appt.shop.logoUrl} name={appt.providerName ?? appt.shop.name} size={48} />
            <View style={styles.whoText}>
              <Txt variant="headline" numberOfLines={2}>
                {appt.shop.name}
              </Txt>
              <Txt variant="subhead" tone="secondary" numberOfLines={2}>
                {[who, place].filter(Boolean).join(" · ") || " "}
              </Txt>
            </View>
          </View>

          <Txt variant="title1" style={styles.day}>
            {dayLabel(appt.startsAt, appt.timezone, now)}
          </Txt>
          <Txt variant="body" tone="secondary">
            {timeRange(appt.startsAt, appt.endsAt, appt.timezone)}
            {until && !/^(today|tomorrow)$/i.test(dayLabel(appt.startsAt, appt.timezone, now)) ? ` · ${until}` : ""}
          </Txt>
          {appt.serviceName ? (
            <Txt variant="headline" style={styles.service}>
              {appt.serviceName}
            </Txt>
          ) : null}
          <View style={styles.statusRow}>
            <StatusLabel status={appt.status} label={appt.statusLabel} />
          </View>
          {appt.statusDetail ? (
            <Txt variant="footnote" tone="secondary" style={styles.detailLine}>
              {appt.statusDetail}
            </Txt>
          ) : null}
        </View>
      </Tap>

      <View style={styles.cardActions}>
        <Button label="View details" onPress={onDetails} icon={<Details size={18} color={color.onGold} />} />
        {(onDirections || onReschedule || onCancel) && (
          <View style={styles.tiles}>
            {onDirections ? (
              <ActionTile label="Directions" onPress={onDirections} icon={<MapPin color={color.text} />} hint="Opens Maps" />
            ) : null}
            {onReschedule ? (
              <ActionTile label="Reschedule" onPress={onReschedule} icon={<Reschedule color={color.text} />} hint="Opens the shop's booking page for this appointment" />
            ) : null}
            {onCancel ? (
              <ActionTile label="Cancel" onPress={onCancel} icon={<Cancel color={color.text} />} hint="Opens the shop's booking page, where you can cancel" />
            ) : null}
          </View>
        )}
        {appt.manageNote ? (
          <Txt variant="footnote" tone="secondary" style={styles.manageNote}>
            {appt.manageNote}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

/**
 * One of the card's secondary actions. Side by side as icon-over-label tiles
 * at ordinary text sizes; at the large Dynamic Type sizes they become
 * full-width icon-beside-label rows, so no label is ever squeezed or cut.
 */
function ActionTile({ label, onPress, icon, hint }: { label: string; onPress: () => void; icon: React.ReactNode; hint: string }) {
  const large = useLargeText();
  return (
    <Tap onPress={onPress} accessibilityLabel={label} accessibilityHint={hint} style={large ? styles.tileRow : styles.tile}>
      {icon}
      <Txt variant="footnoteStrong" style={large ? undefined : styles.tileLabel}>
        {label}
      </Txt>
    </Tap>
  );
}

/** When nothing is booked: calm, one clear way forward. */
export function NoUpcomingCard({ serviceNoun, onBook }: { serviceNoun: string; onBook: () => void }) {
  return (
    <View style={[styles.card, styles.emptyCard]}>
      <Txt variant="title2" accessibilityRole="header">
        {`Ready for your next ${serviceNoun}?`}
      </Txt>
      <Txt variant="subhead" tone="secondary" style={styles.emptyBody}>
        Nothing is booked right now.
      </Txt>
      <Button label="Book an appointment" onPress={onBook} style={styles.emptyButton} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Your shops
// ---------------------------------------------------------------------------

export function shopSubtitle(shop: Shop, now = new Date()): string {
  if (shop.hasUpcoming) return "Upcoming appointment";
  if (!shop.lastVisitAt) return "No visits yet";
  const when = `Last visit ${shortDate(shop.lastVisitAt, shop.timezone, now)}`;
  return shop.usualService ? `${when} · ${shop.usualService}` : when;
}

export function ShopList({ shops, onOpen, now }: { shops: Shop[]; onOpen: (shop: Shop) => void; now?: Date }) {
  return (
    <Group>
      {shops.map((shop, i) => (
        <View key={shop.key}>
          {i > 0 ? <Separator inset={space.s2 + 52 + 12} /> : null}
          <Row
            onPress={() => onOpen(shop)}
            chevron={false}
            leading={<Avatar uri={shop.heroImageUrl ?? shop.logoUrl} name={shop.name} size={52} />}
            title={shop.name}
            subtitle={shopSubtitle(shop, now)}
            trailing={
              <Txt variant="subheadStrong" tone="gold">
                Book
              </Txt>
            }
            accessibilityLabel={`Book at ${shop.name}. ${shopSubtitle(shop, now)}`}
            accessibilityHint="Opens the shop's page"
          />
        </View>
      ))}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// A profile that needs connecting
// ---------------------------------------------------------------------------

/**
 * A shop whose profile the API would not open on a contact alone, because
 * somebody else's record carries that contact too.
 *
 * The tone is deliberate: this is not an error and not a warning, it is the
 * app being careful with somebody's visits. It says what happened in one
 * sentence, in the customer's own terms ("more than one person uses this
 * number"), and offers the one thing that settles it - the link the shop
 * already sent them. It never shows or hints at the other profile.
 */
export function ConnectProfileList({
  shops,
  onConnect,
}: {
  shops: AmbiguousShop[];
  onConnect: (shop: AmbiguousShop) => void;
}) {
  return (
    <Group>
      {shops.map((shop, i) => (
        <View key={shop.key}>
          {i > 0 ? <Separator inset={space.s2 + 52 + 12} /> : null}
          <Row
            onPress={() => onConnect(shop)}
            chevron={false}
            leading={<Avatar uri={shop.logoUrl} name={shop.name} size={52} />}
            title={shop.name}
            subtitle="Connect with the link they sent you"
            trailing={
              <Txt variant="subheadStrong" tone="gold">
                Connect
              </Txt>
            }
            accessibilityLabel={`Connect your profile at ${shop.name}`}
            accessibilityHint="Explains how to connect the right profile"
          />
        </View>
      ))}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export function RewardSummaryList({ rewards, onOpen }: { rewards: RewardSummary[]; onOpen: () => void }) {
  return (
    <Group>
      {rewards.map((r, i) => {
        const ready = r.readyRewards.length > 0;
        const line = r.next ? progressLine(r.balance, r.next.cost, r.unit) : `${r.balance} ${r.unit === "visits" ? "visits" : "punches"}`;
        const sub = ready
          ? `Ready to use: ${r.readyRewards[0]}`
          : r.next
            ? remainingLine(r.next.remaining, r.next.rewardName, r.unit)
            : null;
        return (
          <View key={`${r.shop.key}:${r.cardName ?? "default"}`}>
            {i > 0 ? <Separator /> : null}
            <Tap
              onPress={onOpen}
              accessibilityLabel={[r.shop.name, r.cardName, line, sub].filter(Boolean).join(". ")}
              accessibilityHint="Opens your rewards"
              pressedStyle={styles.rowPressed}
              style={styles.rewardRow}
            >
              <View style={styles.rewardHead}>
                <Txt variant="headline" style={styles.flex}>
                  {line}
                </Txt>
                <Txt variant="footnote" tone="secondary" numberOfLines={1} style={styles.rewardShop}>
                  {r.cardName ? `${r.shop.name} · ${r.cardName}` : r.shop.name}
                </Txt>
              </View>
              {r.next ? <ProgressBar fraction={Math.min(1, r.balance / r.next.cost)} label={line} /> : null}
              {sub ? (
                <Txt variant="subhead" tone={ready ? "gold" : "secondary"}>
                  {sub}
                </Txt>
              ) : null}
            </Tap>
          </View>
        );
      })}
    </Group>
  );
}

export function RewardProgramCard({ program, now = new Date() }: { program: RewardProgram; now?: Date }) {
  return (
    <View style={styles.program}>
      <View style={styles.programHead}>
        <Avatar uri={program.shop.logoUrl} name={program.shop.name} size={40} />
        <View style={styles.flex}>
          <Txt variant="headline">{program.shop.name}</Txt>
          {program.tier.label ? (
            <Txt variant="footnote" tone="secondary">
              {`${program.tier.label} member · ${program.tier.visits} ${program.tier.visits === 1 ? "visit" : "visits"}`}
            </Txt>
          ) : null}
        </View>
      </View>

      {program.cards.map((card) => {
        const line = card.next ? progressLine(card.balance, card.next.cost, card.unit) : `${card.balance} ${card.unit}`;
        const ready = card.rewards.filter((r) => r.ready);
        return (
          <View key={card.name ?? "default"} style={styles.cardBlock}>
            {card.name ? (
              <Txt variant="footnoteStrong" tone="secondary">
                {card.name}
              </Txt>
            ) : null}
            <Txt variant="title2">{line}</Txt>
            {card.next ? <ProgressBar fraction={Math.min(1, card.balance / card.next.cost)} label={line} /> : null}
            {card.next ? (
              <Txt variant="subhead" tone="secondary">
                {remainingLine(card.next.remaining, card.next.rewardName, card.unit)}
              </Txt>
            ) : null}
            {ready.length > 0 ? (
              <View style={styles.readyBox} accessible accessibilityLabel={`Ready to use: ${ready.map((r) => r.name).join(", ")}. Ask at your next visit.`}>
                <Txt variant="subheadStrong" tone="gold">
                  {`Ready to use: ${ready.map((r) => r.name).join(", ")}`}
                </Txt>
                <Txt variant="footnote" tone="secondary">
                  Ask for it at your next visit.
                </Txt>
              </View>
            ) : null}
            {card.rewards.length > 0 ? (
              <View style={styles.menu}>
                {card.rewards.map((r) => (
                  <View key={r.name} style={styles.menuRow}>
                    <View style={styles.flex}>
                      <Txt variant="subhead">{r.name}</Txt>
                      {r.description ? (
                        <Txt variant="footnote" tone="secondary">
                          {r.description}
                        </Txt>
                      ) : null}
                    </View>
                    <Txt variant="footnote" tone={r.ready ? "gold" : "tertiary"}>
                      {r.ready ? "Ready" : `${r.cost} ${card.unit === "visits" ? "visits" : "punches"}`}
                    </Txt>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}

      {program.otherProfileHasPunches ? (
        <Txt variant="footnote" tone="secondary" style={styles.note}>
          {`${program.shop.name} has a second profile for you with punches on it. Ask them to combine your profiles.`}
        </Txt>
      ) : null}

      {program.activity.length > 0 ? (
        <View style={styles.activity}>
          <Txt variant="footnoteStrong" tone="secondary" accessibilityRole="header">
            Activity
          </Txt>
          {program.activity.slice(0, 6).map((a, i) => (
            <View key={`${a.date}:${i}`} style={styles.activityRow} accessible accessibilityLabel={`${shortDate(a.date, program.shop.timezone, now)}. ${a.label}. ${a.punches > 0 ? "plus" : "minus"} ${Math.abs(a.punches)}`}>
              <Txt variant="footnote" tone="secondary" style={styles.activityDate}>
                {shortDate(a.date, program.shop.timezone, now)}
              </Txt>
              <Txt variant="subhead" style={styles.flex} numberOfLines={1}>
                {a.label}
              </Txt>
              <Txt variant="subheadStrong" tone={a.punches > 0 ? "primary" : "secondary"}>
                {a.punches > 0 ? `+${a.punches}` : `${a.punches}`}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function HistoryRow({
  appt,
  onPress,
  onBookAgain,
}: {
  appt: Appointment;
  onPress: () => void;
  onBookAgain?: () => void;
}) {
  const cal = calendarBlock(appt.startsAt, appt.timezone);
  const title = appt.serviceName ?? "Appointment";
  // At large text sizes "Book again" moves under the row instead of stealing
  // the width the service and shop names need.
  const large = useLargeText();
  return (
    <View style={large ? styles.historyStack : styles.historyRow}>
      <Tap
        onPress={onPress}
        accessibilityLabel={`${spokenWhen(appt.startsAt, appt.timezone)}. ${title} at ${appt.shop.name}. ${appt.statusLabel}`}
        accessibilityHint="Opens the appointment"
        pressedStyle={styles.rowPressed}
        style={styles.historyMain}
      >
        <View style={styles.cal} accessible={false}>
          <Txt variant="captionStrong" tone="gold" allowFontScaling={false}>
            {cal.month}
          </Txt>
          <Txt variant="title3" allowFontScaling={false}>
            {cal.day}
          </Txt>
        </View>
        <View style={styles.flex}>
          <Txt variant="body" numberOfLines={2}>
            {title}
          </Txt>
          <Txt variant="subhead" tone="secondary" numberOfLines={2}>
            {appt.shop.name}
          </Txt>
          <View style={styles.historyStatus}>
            <StatusLabel status={appt.status} label={appt.statusLabel} />
          </View>
        </View>
      </Tap>
      {onBookAgain ? (
        <Tap
          onPress={onBookAgain}
          accessibilityLabel={`Book again at ${appt.shop.name}`}
          style={large ? styles.againBelow : styles.again}
        >
          <Txt variant="subheadStrong" tone="gold">
            Book again
          </Txt>
        </Tap>
      ) : null}
    </View>
  );
}

export function HistoryGroup({
  items,
  onOpen,
  onBookAgain,
}: {
  items: Appointment[];
  onOpen: (a: Appointment) => void;
  onBookAgain: (a: Appointment) => void;
}) {
  return (
    <Group>
      {items.map((a, i) => (
        <View key={a.id}>
          {i > 0 ? <Separator inset={space.s2 + 44 + 12} /> : null}
          <HistoryRow appt={a} onPress={() => onOpen(a)} onBookAgain={() => onBookAgain(a)} />
        </View>
      ))}
    </Group>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    overflow: "hidden",
  },
  cardPressed: { backgroundColor: color.surfacePressed },
  cardTop: { padding: space.s2 + 4, paddingBottom: space.s2 },
  who: { flexDirection: "row", alignItems: "center", gap: space.s2 - 4 },
  whoText: { flex: 1, minWidth: 0 },
  day: { marginTop: space.s3 - 4 },
  service: { marginTop: space.s1 + 4 },
  statusRow: { marginTop: space.s1 + 2, flexDirection: "row" },
  detailLine: { marginTop: space.half },
  cardActions: {
    paddingHorizontal: space.s2 + 4,
    paddingBottom: space.s2 + 4,
    gap: space.s1 + 4,
  },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.s1 },
  tile: {
    flexGrow: 1,
    flexBasis: 90,
    minHeight: TOUCH + 18,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    gap: space.half,
    paddingVertical: space.s1,
    paddingHorizontal: space.half,
  },
  tileLabel: { textAlign: "center" },
  tileRow: {
    flexBasis: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2 - 4,
    minHeight: TOUCH + 4,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
    paddingHorizontal: space.s2,
    paddingVertical: space.s1,
  },
  manageNote: { textAlign: "center" },
  emptyCard: { padding: space.s3, alignItems: "flex-start" },
  emptyBody: { marginTop: space.s1 },
  emptyButton: { marginTop: space.s3, alignSelf: "stretch" },

  rowPressed: { backgroundColor: color.surfacePressed },
  rewardRow: { padding: space.s2, gap: space.s1 },
  rewardHead: { flexDirection: "row", alignItems: "baseline", gap: space.s1, flexWrap: "wrap" },
  rewardShop: { flexShrink: 1 },

  program: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    padding: space.s2 + 4,
    gap: space.s2,
    marginBottom: space.s2,
  },
  programHead: { flexDirection: "row", alignItems: "center", gap: space.s2 - 4 },
  cardBlock: { gap: space.s1 },
  readyBox: {
    marginTop: space.half,
    padding: space.s2 - 4,
    borderRadius: radius.md,
    backgroundColor: color.goldTint,
    gap: 2,
  },
  menu: {
    marginTop: space.half,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineStrong,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s1,
    paddingVertical: space.s1 + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  note: { lineHeight: 18 },
  activity: { gap: space.half },
  activityRow: { flexDirection: "row", alignItems: "center", gap: space.s2 - 4, minHeight: 32 },
  activityDate: { width: 64 },

  historyRow: { flexDirection: "row", alignItems: "center" },
  historyStack: { flexDirection: "column", alignItems: "stretch" },
  againBelow: {
    minHeight: TOUCH,
    justifyContent: "center",
    paddingLeft: space.s2 + 44 + 12,
    paddingBottom: space.s1,
  },
  historyMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2 - 4,
    paddingLeft: space.s2,
    paddingRight: space.s1,
    paddingVertical: space.s1 + 4,
    minHeight: TOUCH + 20,
  },
  cal: {
    width: 44,
    paddingVertical: space.half,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
  },
  historyStatus: { marginTop: space.half, flexDirection: "row" },
  again: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.s2 },
});
