import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useResource } from "@/src/customer/CustomerProvider";
import { ApiError, errorCopy } from "@/src/customer/api";
import { displayPhone } from "@/src/customer/format";
import { joinDetailsMessage, TELL_APART_MESSAGE } from "@/src/customer/joinDetails";
import { useSavedShopActions } from "@/src/customer/savedShops";
import { color, radius, space, type } from "@/src/customer/theme";
import type { Profile } from "@/src/customer/types";
import { Avatar, Button, ErrorState, Group, Placeholder, Row, Separator, Tap, Txt } from "@/src/customer/ui";

/**
 * JOIN A SHOP - the client form, reached from a shop found on Book.
 *
 * First and last name are theirs to type (and become the account's name too,
 * so the greeting and every shop agree). A new client needs a last name OR an
 * Instagram handle so the shop can tell them apart - the API decides, because
 * a customer the shop already knows is never asked (src/customer/joinDetails.ts).
 * Phone and email are SHOWN, not typed:
 * they are the ones this account proved with a code, the only ones a shop is
 * ever given (the API's services/joinShop.ts says why). Changing one happens in
 * Profile, which proves the new one first.
 *
 * Joined: back to Book, where the shop now has its Book button. A shop that
 * approves new clients: back to Book, where it says Pending until they answer.
 */
export default function JoinScreen() {
  const router = useRouter();
  const { handle, name, logo, town } = useLocalSearchParams<{
    handle: string;
    name?: string;
    logo?: string;
    town?: string;
  }>();
  const me = useResource<{ profile: Profile }>("/api/me");
  const actions = useSavedShopActions();
  const shopName = name || "this shop";
  const profile = me.data?.profile;

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [instagram, setInstagram] = useState("");
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The names start as the account's, once - never over what they have typed.
  useEffect(() => {
    if (!profile || filled) return;
    setFirst(profile.firstName ?? "");
    setLast(profile.lastName ?? "");
    setInstagram(profile.instagram ?? "");
    setFilled(true);
  }, [profile, filled]);

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace("/customer/book");
  }

  async function join() {
    if (busy) return;
    if (!first.trim()) {
      setMessage(`Add your first name - it's how ${shopName} will know you.`);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const status = await actions.join(handle, first.trim(), last.trim(), instagram.trim());
      if (status === "needs_connecting") {
        setMessage(
          `${shopName} already has your number or email on file. Open the link they texted or emailed you to connect it, or ask them to send it.`,
        );
        return;
      }
      close();
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.kind === "not_found"
          ? `We can't find ${shopName} any more. Check the name with them, or use the link they sent.`
          : (err instanceof ApiError ? joinDetailsMessage(err.code) : null) ?? errorCopy(err).body,
      );
    } finally {
      setBusy(false);
    }
  }

  // Everything the shop is handed, said before the tap.
  const given = [
    "name",
    ...(instagram.trim() ? ["Instagram"] : []),
    ...(profile?.phone ? ["phone"] : []),
    ...(profile?.email ? ["email"] : []),
  ];
  const shared = given.length > 1 ? `${given.slice(0, -1).join(", ")} and ${given[given.length - 1]}` : "name";

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {/* An obvious way out, in the sheet's own bar - not only the swipe. */}
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Tap onPress={close} accessibilityLabel="Cancel" style={styles.cancel}>
              <Txt variant="body" tone="gold">
                Cancel
              </Txt>
            </Tap>
          ),
        }}
      />
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.shop}>
          <Avatar uri={logo || null} name={shopName} size={56} />
          <View style={styles.shopText}>
            <Txt variant="title2" accessibilityRole="header">
              {`Join ${shopName}`}
            </Txt>
            {town ? (
              <Txt variant="subhead" tone="secondary">
                {town}
              </Txt>
            ) : null}
          </View>
        </View>
        <Txt variant="body" tone="secondary" style={styles.lede}>
          You'll be on their client list, and they'll be in your shops, ready to book.
        </Txt>

        {!profile && me.loading ? (
          <Placeholder height={260} style={styles.gapLarge} />
        ) : !profile ? (
          <ErrorState {...errorCopy(me.error)} onRetry={me.refresh} />
        ) : (
          <>
            <Txt variant="footnoteStrong" tone="secondary" style={styles.label}>
              First name
            </Txt>
            <TextInput
              value={first}
              onChangeText={setFirst}
              placeholder="First name"
              placeholderTextColor={color.textTertiary}
              autoCapitalize="words"
              autoComplete="given-name"
              textContentType="givenName"
              maxLength={40}
              returnKeyType="next"
              accessibilityLabel="First name"
              style={styles.input}
            />
            <Txt variant="footnoteStrong" tone="secondary" style={styles.label}>
              Last name
            </Txt>
            <TextInput
              value={last}
              onChangeText={setLast}
              placeholder="Last name"
              placeholderTextColor={color.textTertiary}
              autoCapitalize="words"
              autoComplete="family-name"
              textContentType="familyName"
              maxLength={40}
              returnKeyType="next"
              accessibilityLabel="Last name"
              style={styles.input}
            />
            <Txt variant="footnoteStrong" tone="secondary" style={styles.label}>
              Instagram
            </Txt>
            <TextInput
              value={instagram}
              onChangeText={setInstagram}
              placeholder="@handle"
              placeholderTextColor={color.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              maxLength={200}
              returnKeyType="done"
              onSubmitEditing={() => void join()}
              accessibilityLabel="Instagram"
              style={styles.input}
            />
            <Txt variant="footnote" tone="secondary" style={styles.gapSmall}>
              {`${TELL_APART_MESSAGE}.`}
            </Txt>

            <Txt variant="footnoteStrong" tone="secondary" style={styles.label}>
              Your contact details
            </Txt>
            <Group style={styles.gapSmall}>
              <Row title={displayPhone(profile.phone) ?? "No phone yet"} subtitle="Phone" />
              <Separator />
              <Row title={profile.email ?? "No email yet"} subtitle="Email" />
            </Group>
            <Txt variant="footnote" tone="secondary" style={styles.gapSmall}>
              Only contacts you've confirmed with a code are shared. To change one, go to Profile.
            </Txt>

            {message ? (
              <Txt variant="subhead" accessibilityLiveRegion="polite" style={styles.gapLarge}>
                {message}
              </Txt>
            ) : null}
            <Button label="Join shop" busy={busy} onPress={() => void join()} style={styles.primary} />
            <Txt variant="caption" tone="tertiary" style={styles.gapSmall}>
              {`${shopName} gets your ${shared}. Joining doesn't sign you up for marketing texts.`}
            </Txt>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.s3, paddingBottom: space.s6 },
  shop: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  shopText: { flex: 1, flexShrink: 1 },
  lede: { marginTop: space.s2 },
  label: { marginTop: space.s3 },
  input: {
    marginTop: space.s1,
    minHeight: 52,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space.s2,
    color: color.text,
    fontSize: type.body.fontSize,
  },
  gapSmall: { marginTop: space.s1 },
  gapLarge: { marginTop: space.s3 },
  primary: { marginTop: space.s3, alignSelf: "stretch" },
  cancel: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.half },
});
