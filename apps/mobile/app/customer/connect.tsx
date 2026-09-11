import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { invalidate, useCustomer } from "@/src/customer/CustomerProvider";
import { ApiError, errorCopy } from "@/src/customer/api";
import { color, radius, space, type } from "@/src/customer/theme";
import { Button, Txt } from "@/src/customer/ui";

/**
 * CONNECT THE RIGHT PROFILE.
 *
 * A shop has a profile carrying this customer's number or email, and so does
 * somebody else - a parent and a child on one phone is the ordinary case. The
 * app refuses to guess which is theirs, and shows nothing from either until
 * they settle it with the one thing only the right person has: the link that
 * shop already sent them.
 *
 * 🔴 WHAT THIS SCREEN MUST NEVER DO is offer a list of names to choose from.
 * Recognising a name is not being that person, and the names themselves are
 * the other customer's business. The API sends neither, which is why this
 * screen could not show them even if it wanted to.
 */
export default function ConnectScreen() {
  const router = useRouter();
  const { api } = useCustomer();
  const { shop } = useLocalSearchParams<{ shop?: string }>();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function connect() {
    const value = link.trim();
    if (busy || !value) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.send("POST", "/api/me/profiles/claim", { link: value });
      // The home, shops, rewards and history all change with this.
      invalidate("/api/me");
      if (router.canGoBack()) router.back();
      else router.replace("/customer");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === "claimed_elsewhere") {
        setMessage(
          "That profile is already connected to another ChairBack account. Ask the shop to help sort it out.",
        );
      } else if (code === "too_many") {
        setMessage("You've connected as many profiles as one account can hold.");
      } else if (err instanceof ApiError && err.kind === "not_found") {
        // One answer for "no such link", "not your contact" and "already
        // archived": a link that opens nothing must not become a way to find
        // out whose it is.
        setMessage(
          "That link doesn't match a profile we can connect. Check you pasted all of it, or ask the shop to send it again.",
        );
      } else {
        setMessage(errorCopy(err).body);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Txt variant="largeTitle" accessibilityRole="header">
          Connect your profile
        </Txt>
        <Txt variant="body" tone="secondary" style={styles.lede}>
          {shop
            ? `More than one profile at ${shop} uses your contact details, so we don't open any of them on that alone.`
            : "More than one profile at this shop uses your contact details, so we don't open any of them on that alone."}
        </Txt>
        <Txt variant="body" tone="secondary" style={styles.lede}>
          Open the rewards link the shop texted or emailed you and it connects here. You can also paste it below.
        </Txt>

        <Txt variant="footnoteStrong" tone="secondary" style={styles.label}>
          Your link
        </Txt>
        <TextInput
          value={link}
          onChangeText={setLink}
          onSubmitEditing={() => void connect()}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          placeholder="getchairback.com/r/…"
          placeholderTextColor={color.textTertiary}
          accessibilityLabel="The link your shop sent you"
          style={styles.input}
        />
        {message ? (
          <Txt variant="footnote" tone="secondary" accessibilityLiveRegion="polite" style={styles.message}>
            {message}
          </Txt>
        ) : null}
        <Button
          label="Connect"
          busy={busy}
          disabled={!link.trim()}
          onPress={() => void connect()}
          style={styles.primary}
        />
        <Txt variant="caption" tone="tertiary" style={styles.small}>
          Nothing from either profile is shown until one is connected - not appointments, not rewards, not names.
        </Txt>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.s3, gap: space.s1 },
  lede: { marginTop: space.s1 },
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
  message: { marginTop: space.s2 },
  primary: { marginTop: space.s3, alignSelf: "stretch" },
  small: { marginTop: space.s3 },
});
