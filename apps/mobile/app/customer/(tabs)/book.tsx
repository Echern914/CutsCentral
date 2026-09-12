import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { API_ORIGIN } from "@/src/config";
import { useResource } from "@/src/customer/CustomerProvider";
import { Screen } from "@/src/customer/Screen";
import { errorCopy } from "@/src/customer/api";
import { openStorefront } from "@/src/customer/navigate";
import { ShopList } from "@/src/customer/sections";
import { color, radius, space, type } from "@/src/customer/theme";
import type { Home } from "@/src/customer/types";
import { Avatar, Button, ErrorState, Group, Placeholder, Row, SectionHeader, StaleBanner, Txt } from "@/src/customer/ui";

/**
 * BOOK - "Your shops" first, always. The app never chooses a shop for the
 * customer: they pick one of their own, or find a new one by its full name
 * (the existing exact-handle lookup - a lookup, not a search, so nobody can
 * browse other people's businesses), or open the link a shop sent them.
 */
export default function BookScreen() {
  const router = useRouter();
  const home = useResource<Home>("/api/me/home");
  const data = home.data;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen title="Book" refreshing={home.refreshing} onRefresh={home.refresh}>
        {home.stale ? <StaleBanner onRetry={home.refresh} /> : null}
        {!data && home.loading ? (
          <Placeholder height={180} />
        ) : !data ? (
          <ErrorState {...errorCopy(home.error)} onRetry={home.refresh} />
        ) : data.shops.length > 0 ? (
          <>
            <Txt variant="headline" accessibilityRole="header" style={styles.sub}>
              {`Your ${data.vocabulary.providerNounPlural}`}
            </Txt>
            <ShopList shops={data.shops} onOpen={(shop) => openStorefront(router, shop)} />
          </>
        ) : (
          <Txt variant="subhead" tone="secondary">
            You haven't booked with a shop on ChairBack yet - or you booked with a different number or email. Find the shop below, or add that number in Profile.
          </Txt>
        )}

        <FindShop />
        <OpenLink />
      </Screen>
    </KeyboardAvoidingView>
  );
}

interface Found {
  name: string;
  logoUrl: string | null;
  town: string | null;
  pageUrl: string;
}

function FindShop() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function find() {
    const typed = value.trim();
    if (!typed || busy) return;
    setBusy(true);
    setMessage(null);
    setFound(null);
    try {
      const res = await fetch(`${API_ORIGIN}/api/find-shop?handle=${encodeURIComponent(typed)}`);
      if (!res.ok) {
        // One answer for every miss, matching the API's single refusal - it
        // must never hint that a shop exists but is private.
        setMessage("No shop with that name. Check the full name with them, or use the link they sent.");
        return;
      }
      const body = (await res.json()) as { shop: Found };
      setFound(body.shop);
    } catch {
      setMessage("You're offline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View>
      <SectionHeader title="Find a shop" />
      <Txt variant="subhead" tone="secondary" style={styles.sub}>
        Enter the shop's full name - the one on their door.
      </Txt>
      <TextInput
        value={value}
        onChangeText={setValue}
        onSubmitEditing={find}
        placeholder="Shop name"
        placeholderTextColor={color.textTertiary}
        autoCapitalize="words"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="search"
        accessibilityLabel="Shop name"
        style={styles.input}
      />
      <Button label="Find" variant="secondary" busy={busy} onPress={find} style={styles.gap} />
      {message ? (
        <Txt variant="footnote" tone="secondary" style={styles.gap} accessibilityLiveRegion="polite">
          {message}
        </Txt>
      ) : null}
      {found ? (
        <Group style={styles.gap}>
          <Row
            leading={<Avatar uri={found.logoUrl} name={found.name} size={44} />}
            title={found.name}
            subtitle={found.town}
            onPress={() =>
              router.push({ pathname: "/customer/link", params: { url: found.pageUrl, name: found.name } })
            }
            accessibilityHint="Opens the shop's page"
          />
        </Group>
      ) : null}
    </View>
  );
}

/** A link a shop texted or emailed: /r/<token> opens that shop's page, as it always has. */
function OpenLink() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  function open() {
    const raw = value.trim();
    const token = raw.match(/\/r\/([^/?#\s]+)/)?.[1] ?? (/^[A-Za-z0-9_-]{16,}$/.test(raw) ? raw : null);
    if (!token) {
      setMessage("That doesn't look like a link from a shop on ChairBack.");
      return;
    }
    setMessage(null);
    router.push({ pathname: "/customer/link", params: { token: decodeURIComponent(token) } });
  }

  return (
    <View>
      <SectionHeader title="Have a link from a shop?" />
      <TextInput
        value={value}
        onChangeText={setValue}
        onSubmitEditing={open}
        placeholder="getchairback.com/r/..."
        placeholderTextColor={color.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="Link from your shop"
        style={styles.input}
      />
      <Button label="Open link" variant="secondary" onPress={open} style={styles.gap} />
      {message ? (
        <Txt variant="footnote" tone="secondary" style={styles.gap} accessibilityLiveRegion="polite">
          {message}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.bg },
  sub: { marginBottom: space.s1 + 4 },
  gap: { marginTop: space.s1 + 4 },
  input: {
    ...type.body,
    color: color.text,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space.s2,
    paddingVertical: space.s1 + 4,
    minHeight: 50,
  },
});
