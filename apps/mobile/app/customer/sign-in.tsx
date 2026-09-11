import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_ORIGIN, STORAGE } from "@/src/config";
import { useCustomer } from "@/src/customer/CustomerProvider";
import { ApiError, errorCopy, publicPost } from "@/src/customer/api";
import { displayPhone } from "@/src/customer/format";
import { color, radius, space, type } from "@/src/customer/theme";
import { Button, Tap, Txt, Wordmark } from "@/src/customer/ui";

/**
 * Sign in to My ChairBack: a phone number (or an email) and a six-digit code.
 * No password, nothing to remember. The first good code creates the account;
 * every shop that has this number or email on file comes with it.
 *
 * Three doors stay open for anyone not ready to sign in: the link a shop sent
 * (opens that shop's page exactly as before), the demo, and the way back to
 * the business side.
 */
type Step = "contact" | "code" | "name";

export default function SignInScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signIn } = useCustomer();

  const [step, setStep] = useState<Step>("contact");
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [legacyToken, setLegacyToken] = useState<string | null>(null);

  // A customer updating from the one-shop app keeps a way to their shop.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE.lastToken)
      .then(setLegacyToken)
      .catch(() => setLegacyToken(null));
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown > 0]);

  const field = channel === "sms" ? "phone" : "email";

  async function sendCode() {
    if (busy || cooldown > 0 || !contact.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      await publicPost(API_ORIGIN, "/api/customer-auth/start", { channel, [field]: contact.trim() });
      setStep("code");
      setCode("");
      setCooldown(60);
    } catch (err) {
      const c = err instanceof ApiError ? err.code : null;
      if (c === "phone_not_supported") {
        setChannel("email");
        setContact("");
        setMessage("Texts go to US and Canadian numbers. Use your email instead.");
      } else if (c === "invalid_phone") setMessage("That number doesn't look right. Check it and try again.");
      else if (c === "invalid_email") setMessage("That email doesn't look right. Check it and try again.");
      else if (err instanceof ApiError && err.kind === "not_found") {
        // The server's switch is off: say so, and point at what still works.
        setMessage("Signing in isn't switched on yet. In the meantime, open the link your shop sent you.");
      } else setMessage(errorCopy(err).body);
    } finally {
      setBusy(false);
    }
  }

  async function verify(entered = code) {
    if (busy || entered.length !== 6) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await publicPost<{
        verified: boolean;
        token?: string;
        account?: { firstName: string | null; suggestedFirstName: string | null; isNew: boolean };
      }>(API_ORIGIN, "/api/customer-auth/verify", { channel, [field]: contact.trim(), code: entered });
      if (!res.verified || !res.token) {
        setMessage("That code didn't work. Check it, or send a new one.");
        return;
      }
      if (!res.account?.firstName) {
        // Ask what to call them before the home greets them by name.
        setPendingToken(res.token);
        setName(res.account?.suggestedFirstName ?? "");
        setStep("name");
        return;
      }
      await signIn(res.token);
    } catch (err) {
      setMessage(errorCopy(err).body);
    } finally {
      setBusy(false);
    }
  }

  async function finishName(skip: boolean) {
    if (!pendingToken) return;
    setBusy(true);
    try {
      if (!skip && name.trim()) {
        await fetch(`${API_ORIGIN}/api/me`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${pendingToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ firstName: name.trim() }),
        }).catch(() => null);
      }
      await signIn(pendingToken);
    } finally {
      setBusy(false);
    }
  }

  async function tryDemo() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await publicPost<{ token: string }>(API_ORIGIN, "/api/customer-auth/demo", {});
      await signIn(res.token, { demo: true });
    } catch (err) {
      setMessage(errorCopy(err).body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + space.s3, paddingBottom: insets.bottom + space.s4 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Wordmark size={22} />

        {step === "contact" ? (
          <View style={styles.block}>
            <Txt variant="largeTitle" accessibilityRole="header">
              Sign in
            </Txt>
            <Txt variant="body" tone="secondary" style={styles.lede}>
              Your appointments and rewards from every shop, in one place.
            </Txt>

            <Txt variant="footnoteStrong" tone="secondary" style={styles.label}>
              {channel === "sms" ? "Mobile number" : "Email"}
            </Txt>
            <TextInput
              key={channel}
              value={contact}
              onChangeText={setContact}
              onSubmitEditing={() => void sendCode()}
              autoFocus
              keyboardType={channel === "sms" ? "phone-pad" : "email-address"}
              textContentType={channel === "sms" ? "telephoneNumber" : "emailAddress"}
              autoComplete={channel === "sms" ? "tel" : "email"}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              placeholder={channel === "sms" ? "(555) 555-0123" : "you@example.com"}
              placeholderTextColor={color.textTertiary}
              accessibilityLabel={channel === "sms" ? "Mobile number" : "Email"}
              style={styles.input}
            />
            {message ? (
              <Txt variant="footnote" tone="secondary" accessibilityLiveRegion="polite" style={styles.message}>
                {message}
              </Txt>
            ) : null}
            <Button
              label={channel === "sms" ? "Text me a code" : "Email me a code"}
              busy={busy}
              disabled={!contact.trim()}
              onPress={() => void sendCode()}
              style={styles.primary}
            />
            <Button
              label={channel === "sms" ? "Use email instead" : "Use my mobile number instead"}
              variant="plain"
              onPress={() => {
                setChannel(channel === "sms" ? "email" : "sms");
                setContact("");
                setMessage(null);
              }}
            />
            <Txt variant="caption" tone="tertiary" style={styles.small}>
              {channel === "sms"
                ? "We'll text a one-time code to this number. Message and data rates may apply."
                : "We'll email a one-time code to this address."}
            </Txt>
          </View>
        ) : null}

        {step === "code" ? (
          <View style={styles.block}>
            <Txt variant="largeTitle" accessibilityRole="header">
              Enter the code
            </Txt>
            <Txt variant="body" tone="secondary" style={styles.lede}>
              {`We sent a 6-digit code to ${channel === "sms" ? (displayPhone(contact.trim().startsWith("+") ? contact.trim() : `+1${contact.replace(/\D/g, "").slice(-10)}`) ?? contact) : contact.trim()}.`}
            </Txt>
            <TextInput
              value={code}
              onChangeText={(v) => {
                const digits = v.replace(/\D/g, "").slice(0, 6);
                setCode(digits);
                if (digits.length === 6) void verify(digits);
              }}
              autoFocus
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete={channel === "sms" ? "sms-otp" : "one-time-code"}
              maxLength={6}
              placeholder="000000"
              placeholderTextColor={color.textTertiary}
              accessibilityLabel="6-digit code"
              style={[styles.input, styles.codeInput]}
            />
            {message ? (
              <Txt variant="footnote" tone="secondary" accessibilityLiveRegion="polite" style={styles.message}>
                {message}
              </Txt>
            ) : null}
            <Button label="Continue" busy={busy} disabled={code.length !== 6} onPress={() => void verify()} style={styles.primary} />
            <Button
              label={cooldown > 0 ? `Send a new code (${cooldown}s)` : "Send a new code"}
              variant="plain"
              disabled={cooldown > 0 || busy}
              onPress={() => void sendCode()}
            />
            <Button
              label={channel === "sms" ? "Change number" : "Change email"}
              variant="plain"
              onPress={() => {
                setStep("contact");
                setMessage(null);
              }}
            />
          </View>
        ) : null}

        {step === "name" ? (
          <View style={styles.block}>
            <Txt variant="largeTitle" accessibilityRole="header">
              What should we call you?
            </Txt>
            <Txt variant="body" tone="secondary" style={styles.lede}>
              Just your first name. Shops keep their own records - this is only for your home screen.
            </Txt>
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              autoCapitalize="words"
              textContentType="givenName"
              autoComplete="given-name"
              returnKeyType="done"
              onSubmitEditing={() => void finishName(false)}
              placeholder="First name"
              placeholderTextColor={color.textTertiary}
              accessibilityLabel="First name"
              style={styles.input}
            />
            <Button label="Continue" busy={busy} onPress={() => void finishName(false)} style={styles.primary} />
            <Button label="Skip" variant="plain" onPress={() => void finishName(true)} />
          </View>
        ) : null}

        {step === "contact" ? (
          <View style={styles.others}>
            {legacyToken ? (
              <Tap
                onPress={() => router.push({ pathname: "/customer/link", params: { token: legacyToken } })}
                accessibilityLabel="Open my shop's page without signing in"
                style={styles.other}
              >
                <Txt variant="subhead" tone="gold">
                  Open my shop's page without signing in
                </Txt>
              </Tap>
            ) : null}
            <Tap onPress={() => void tryDemo()} accessibilityLabel="Just looking? Try the demo" style={styles.other}>
              <Txt variant="subhead" tone="gold">
                Just looking? Try the demo
              </Txt>
            </Tap>
            <Tap
              onPress={() => router.replace({ pathname: "/", params: { switching: "1" } })}
              accessibilityLabel="I own or work at a business"
              accessibilityHint="Opens the welcome screen to choose business mode"
              style={styles.other}
            >
              <Txt variant="subhead" tone="secondary">
                I own or work at a business
              </Txt>
            </Tap>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.bg },
  content: { paddingHorizontal: space.s3, flexGrow: 1 },
  block: { marginTop: space.s5 },
  lede: { marginTop: space.s1, marginBottom: space.s3 },
  label: { marginBottom: space.s1 },
  input: {
    ...type.title3,
    color: color.text,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space.s2,
    paddingVertical: space.s1 + 6,
    minHeight: 56,
  },
  codeInput: { letterSpacing: 8, textAlign: "center", ...type.title1 },
  message: { marginTop: space.s1 + 2 },
  primary: { marginTop: space.s3 },
  small: { marginTop: space.s1, textAlign: "center" },
  others: { marginTop: space.s5, alignItems: "center", gap: space.half },
  other: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.s2 },
});
