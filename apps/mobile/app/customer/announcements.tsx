import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { invalidate, useCustomer, useResource } from "@/src/customer/CustomerProvider";
import { Screen } from "@/src/customer/Screen";
import { errorCopy } from "@/src/customer/api";
import { ANNOUNCEMENTS_PATH, readThrough, sentLabel, type Announcement, type Announcements } from "@/src/customer/announcements";
import { color, space } from "@/src/customer/theme";
import { useAnnouncementWake } from "@/src/customer/useAnnouncementWake";
import { Avatar, EmptyState, ErrorState, Group, Placeholder, StaleBanner, Txt } from "@/src/customer/ui";

/**
 * Announcements - what the customer's shops broadcast to them, newest first.
 *
 * The bell on the home opens this, and so does tapping a shop's announcement
 * push. Opening it marks everything it SHOWED as read: the marker goes up to
 * the newest one on screen, so one that arrives meanwhile still counts as new.
 * The bell's badge only changes once the API has recorded that - it is never
 * cleared on the phone's say-so.
 */
export default function AnnouncementsScreen() {
  const { api } = useCustomer();
  const res = useResource<Announcements>(ANNOUNCEMENTS_PATH);
  // A new one arriving while this is open (or on top when the app wakes).
  useAnnouncementWake(res.reload);
  const data = res.data;

  // Which ones were new when they were shown, kept for this visit: after the
  // read is recorded the API says 0 unread, but the customer should still see
  // which ones they hadn't read yet.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const unread = data.announcements.slice(0, data.unreadCount).map((a) => a.id);
    if (unread.length > 0) setFresh((prev) => new Set([...prev, ...unread]));

    const through = readThrough(data);
    if (!through || marked.current === through) return;
    marked.current = through;
    api
      .send("POST", `${ANNOUNCEMENTS_PATH}/read`, { through })
      // The home's bell refetches on focus and reads the new count.
      .then(() => invalidate(ANNOUNCEMENTS_PATH))
      // Not recorded (offline, or the read-only demo): the badge stays, and
      // the next visit tries again.
      .catch(() => {
        marked.current = null;
      });
  }, [api, data]);

  return (
    <Screen underNavBar refreshing={res.refreshing} onRefresh={res.refresh}>
      {res.stale ? <StaleBanner onRetry={res.refresh} /> : null}
      {!data && res.loading ? (
        <View style={styles.list} accessibilityLabel="Loading announcements" accessible>
          <Placeholder height={120} />
          <Placeholder height={120} />
        </View>
      ) : !data ? (
        <ErrorState {...errorCopy(res.error)} onRetry={res.refresh} />
      ) : data.announcements.length === 0 ? (
        <EmptyState
          title="No announcements yet"
          body="When a shop you're a client of sends news - openings, holiday hours, specials - it shows up here."
        />
      ) : (
        <View style={styles.list}>
          {data.announcements.map((a) => (
            <AnnouncementCard key={a.id} item={a} isNew={fresh.has(a.id)} />
          ))}
        </View>
      )}
    </Screen>
  );
}

function AnnouncementCard({ item, isNew }: { item: Announcement; isNew: boolean }) {
  const when = sentLabel(item.sentAt);
  return (
    <Group style={styles.card}>
      <View
        style={styles.head}
        accessible
        accessibilityLabel={[isNew ? "New" : null, item.shop.name, when].filter(Boolean).join(", ")}
      >
        <Avatar uri={item.shop.logoUrl} name={item.shop.name} size={36} />
        <View style={styles.flex}>
          <Txt variant="subheadStrong" numberOfLines={1}>
            {item.shop.name}
          </Txt>
          <Txt variant="footnote" tone="secondary">
            {when}
          </Txt>
        </View>
        {isNew ? (
          <View style={styles.newTag}>
            <View style={styles.dot} />
            <Txt variant="captionStrong" tone="gold">
              NEW
            </Txt>
          </View>
        ) : null}
      </View>
      {item.title ? (
        <Txt variant="headline" style={styles.title}>
          {item.title}
        </Txt>
      ) : null}
      <Txt variant="body" selectable>
        {item.body}
      </Txt>
    </Group>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.s2 - 4 },
  card: { padding: space.s2 },
  head: { flexDirection: "row", alignItems: "center", gap: space.s2 - 4, marginBottom: space.s1 + 4 },
  flex: { flex: 1, minWidth: 0 },
  newTag: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: color.gold },
  title: { marginBottom: space.half },
});
