import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { API_ORIGIN } from "@/src/config";
import { useCustomer, useResource } from "@/src/customer/CustomerProvider";
import { Screen } from "@/src/customer/Screen";
import { errorCopy } from "@/src/customer/api";
import { linkTarget } from "@/src/customer/connectLink";
import { openStorefront } from "@/src/customer/navigate";
import { useSavedShopActions } from "@/src/customer/savedShops";
import { SavedShopList, ShopList } from "@/src/customer/sections";
import { color, radius, space, type } from "@/src/customer/theme";
import type { Home } from "@/src/customer/types";
import { Avatar, Button, ErrorState, Group, Placeholder, Row, SectionHeader, StaleBanner, Txt } from "@/src/customer/ui";

/**
 * BOOK - "Your shops" first, always. The app never chooses a shop for the
 * customer: they pick one of their own, or find a new one by its full name
 * (the existing exact-handle lookup - a lookup, not a search, so nobody can
 * browse other people's businesses), or open the link a shop sent them. A shop
 * they find, they can join: the client form (app/customer/join.tsx), and then
 * it is in their shops with its Book button - or Pending, at a shop that
 * approves new clients first.
 */
export default function BookScreen() {
  const router = useRouter();
  const home = useResource<Home>("/api/me/home");
  const data = home.data;
  // An older API answer has no saved list: that is an empty one, never a crash.
  const saved = data?.saved ?? [];
  const actions = useSavedShopActions();

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen title="Book" refreshing={home.refreshing} onRefresh={home.refresh}>
        {home.stale ? <StaleBanner onRetry={home.refresh} /> : null}
        {!data && home.loading ? (
          <Placeholder height={180} />
        ) : !data ? (
          <ErrorState {...errorCopy(home.error)} onRetry={home.refresh} />
        ) : data.shops.length > 0 || saved.length > 0 ? (
          <>
            <Txt variant="headline" accessibilityRole="header" style={styles.sub}>
              Your shops
            </Txt>
            {data.shops.length > 0 ? (
              <ShopList shops={data.shops} onOpen={(shop) => openStorefront(router, shop)} />
            ) : null}
            {saved.length > 0 ? (
              <View style={data.shops.length > 0 ? styles.gap : undefined}>
                <SavedShopList
                  shops={saved}
                  onOpen={actions.open}
                  onRemove={(shop) => actions.remove(shop, home.refresh)}
                />
              </View>
            ) : null}
          </>
        ) : (
          <Txt variant="subhead" tone="secondary">
            You haven't booked with a shop on ChairBack yet - or you booked with a different number or email. Find the shop below and join it, or add that number in Profile.
          </Txt>
        )}

        <FindShop home={data} />
        <OpenLink />
      </Screen>
    </KeyboardAvoidingView>
  );
}

interface Found {
  name: string;
  handle: string;
  logoUrl: string | null;
  town: string | null;
  pageUrl: string;
  bookUrl: string;
}

/** Where a found shop already stands with this customer, if anywhere. */
function standing(home: Home | undefined, handle: string): "client" | "pending" | null {
  if (!home) return null;
  if (home.shops.some((s) => s.handle === handle)) return "client";
  if ((home.saved ?? []).some((s) => s.handle === handle && s.pending)) return "pending";
  return null;
}

function FindShop({ home }: { home: Home | undefined }) {
  const router = useRouter();
  const { isDemo } = useCustomer();
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
      if (res.status === 404) {
        // One answer for every miss, matching the API's single refusal - it
        // must never hint that a shop exists but is private.
        setMessage("No shop with that name. Use the shop's full name, not a person's name - or paste the link they sent.");
        return;
      }
      if (!res.ok) {
        // Busy or down is not "no such shop": saying so would send them off
        // to re-check a name that was right.
        setMessage("We couldn't check that just now. Try again in a minute.");
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

  const state = found ? standing(home, found.handle) : null;

  function openFound() {
    if (!found) return;
    if (state || isDemo) {
      router.push({ pathname: "/customer/link", params: { url: found.pageUrl, name: found.name } });
      return;
    }
    router.push({
      pathname: "/customer/join",
      params: { handle: found.handle, name: found.name, logo: found.logoUrl ?? "", town: found.town ?? "" },
    });
  }

  return (
    <View>
      <SectionHeader title="Find a shop" />
      <Txt variant="subhead" tone="secondary" style={styles.sub}>
        Enter the shop's full name - the one on their door - or paste their link.
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
        <>
          <Group style={styles.gap}>
            <Row
              leading={<Avatar uri={found.logoUrl} name={found.name} size={44} />}
              title={found.name}
              subtitle={found.town}
              onPress={openFound}
              accessibilityHint={state || isDemo ? "Opens the shop's page" : "Opens the form to join this shop"}
            />
          </Group>
          {state === "client" ? (
            <Txt variant="footnote" tone="secondary" style={styles.gap} accessibilityLiveRegion="polite">
              Already in your shops.
            </Txt>
          ) : state === "pending" ? (
            <Txt variant="footnote" tone="secondary" style={styles.gap} accessibilityLiveRegion="polite">
              {`You asked to join. ${found.name} hasn't answered yet.`}
            </Txt>
          ) : isDemo ? (
            // The demo account is read-only on the server; say so rather than
            // offer a button that can only fail.
            <Txt variant="footnote" tone="secondary" style={styles.gap}>
              Sign in with your own number to join shops.
            </Txt>
          ) : (
            <Button label="Join shop" onPress={openFound} style={styles.gap} />
          )}
        </>
      ) : null}
    </View>
  );
}

/** A link a shop texted, emailed or printed - see linkTarget for which ones open. */
function OpenLink() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  function open() {
    const target = linkTarget(value);
    if (!target) {
      setMessage("That doesn't look like a link from a shop on ChairBack.");
      return;
    }
    setMessage(null);
    router.push({ pathname: "/customer/link", params: target });
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
