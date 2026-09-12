import { useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Platform, StyleSheet, Switch, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { WEB_ORIGIN } from "@/src/config";
import { invalidate, useCustomer, useResource } from "@/src/customer/CustomerProvider";
import { Screen } from "@/src/customer/Screen";
import { ApiError, errorCopy } from "@/src/customer/api";
import { displayPhone } from "@/src/customer/format";
import { color, radius, space, type } from "@/src/customer/theme";
import type { Notifications, Profile } from "@/src/customer/types";
import { Button, ErrorState, Group, Placeholder, Row, SectionHeader, Separator, StaleBanner, Tap, Txt } from "@/src/customer/ui";

/**
 * PROFILE - the customer's own details and switches. Nothing here writes to a
 * shop's record except the per-shop text switch, which is the same consent
 * rule the shop's storefront applies (and only ever for that one shop).
 */
export default function ProfileScreen() {
  const router = useRouter();
  const { api, signOut, isDemo } = useCustomer();
  const profile = useResource<{ profile: Profile }>("/api/me");
  const me = profile.data?.profile;

  async function confirmDelete() {
    Alert.alert(
      "Delete your My ChairBack account?",
      "This removes your sign-in, your saved phones and your notification settings. Each shop keeps its own record of your visits; you can ask a shop to delete it from their page.",
      [
        { text: "Keep account", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: async () => {
            try {
              await api.send("DELETE", "/api/me");
              await signOut();
            } catch (err) {
              Alert.alert(errorCopy(err).title, errorCopy(err).body);
            }
          },
        },
      ],
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen title="Profile" refreshing={profile.refreshing} onRefresh={profile.refresh}>
        {profile.stale ? <StaleBanner onRetry={profile.refresh} /> : null}
        {isDemo ? (
          <View style={styles.demo}>
            <Txt variant="subheadStrong" tone="gold">
              You're looking at a demo
            </Txt>
            <Txt variant="footnote" tone="secondary">
              Nothing here is real, and changes are switched off. Sign in with your own number to see your appointments.
            </Txt>
          </View>
        ) : null}

        {!me && profile.loading ? (
          <Placeholder height={200} />
        ) : !me ? (
          <ErrorState {...errorCopy(profile.error)} onRetry={profile.refresh} />
        ) : (
          <>
            <NameEditor profile={me} disabled={isDemo} onSaved={profile.refresh} />
            <SectionHeader title="Sign-in" />
            <Group>
              <ContactEditor
                channel="sms"
                label="Mobile number"
                current={displayPhone(me.phone)}
                disabled={isDemo}
                onSaved={() => {
                  invalidate("/api/me");
                  void profile.refresh();
                }}
              />
              <Separator />
              <ContactEditor
                channel="email"
                label="Email"
                current={me.email}
                disabled={isDemo}
                onSaved={() => {
                  invalidate("/api/me");
                  void profile.refresh();
                }}
              />
            </Group>
            <Txt variant="footnote" tone="secondary" style={styles.footnote}>
              Shops find you by the number and email you give them. Adding both here brings every visit into one place.
            </Txt>
          </>
        )}

        <NotificationSettings disabled={isDemo} />

        <SectionHeader title="More" />
        <Group>
          <Row
            title="Help"
            subtitle="Questions about an appointment go to the shop"
            onPress={() => Linking.openURL(`${WEB_ORIGIN}/support`).catch(() => {})}
            accessibilityHint="Opens ChairBack support"
          />
          <Separator />
          <Row
            title="Switch to business mode"
            subtitle="For owners and team members"
            onPress={() => router.replace({ pathname: "/", params: { switching: "1" } })}
          />
          <Separator />
          <Row title="Sign out" onPress={() => void signOut()} chevron={false} />
        </Group>

        {!isDemo ? (
          <Tap onPress={confirmDelete} accessibilityLabel="Delete account" style={styles.delete}>
            <Txt variant="subhead" tone="secondary">
              Delete account
            </Txt>
          </Tap>
        ) : null}

        <Txt variant="caption" tone="tertiary" style={styles.version}>
          {`ChairBack ${Constants.expoConfig?.version ?? ""}`}
        </Txt>
      </Screen>
    </KeyboardAvoidingView>
  );
}

function NameEditor({ profile, disabled, onSaved }: { profile: Profile; disabled: boolean; onSaved: () => void }) {
  const { api } = useCustomer();
  const [first, setFirst] = useState(profile.firstName ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setFirst(profile.firstName ?? ""), [profile.firstName]);
  const dirty = first.trim() !== (profile.firstName ?? "");

  async function save() {
    setBusy(true);
    try {
      await api.send("PATCH", "/api/me", { firstName: first });
      invalidate("/api/me");
      onSaved();
    } catch (err) {
      Alert.alert(errorCopy(err).title, errorCopy(err).body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View>
      <Txt variant="footnoteStrong" tone="secondary" style={styles.fieldLabel}>
        What should we call you?
      </Txt>
      <TextInput
        value={first}
        onChangeText={setFirst}
        editable={!disabled}
        placeholder="First name"
        placeholderTextColor={color.textTertiary}
        autoCapitalize="words"
        textContentType="givenName"
        autoComplete="given-name"
        returnKeyType="done"
        onSubmitEditing={() => dirty && void save()}
        accessibilityLabel="First name"
        style={styles.input}
      />
      {dirty ? <Button label="Save name" variant="secondary" busy={busy} onPress={save} style={styles.gap} /> : null}
    </View>
  );
}

/** Add or change a phone or email: prove it with a code, like signing in. */
function ContactEditor({
  channel,
  label,
  current,
  disabled,
  onSaved,
}: {
  channel: "sms" | "email";
  label: string;
  current: string | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const { api } = useCustomer();
  const [step, setStep] = useState<"idle" | "enter" | "code">("idle");
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const field = channel === "sms" ? "phone" : "email";

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      await api.send("POST", "/api/me/contact/start", { channel, [field]: value });
      setStep("code");
    } catch (err) {
      const c = err instanceof ApiError ? err.code : null;
      setMessage(
        c === "phone_not_supported"
          ? "Texts go to US and Canadian numbers only. Add an email instead."
          : c === "invalid_phone"
            ? "That number doesn't look right."
            : c === "invalid_email"
              ? "That email doesn't look right."
              : errorCopy(err).body,
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.send<{ verified: boolean }>("POST", "/api/me/contact/verify", { channel, [field]: value, code });
      if (!res.verified) {
        setMessage("That code didn't work. Check it, or send a new one.");
        return;
      }
      setStep("idle");
      setValue("");
      setCode("");
      onSaved();
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.code === "in_use"
          ? `That ${channel === "sms" ? "number" : "email"} is already on another My ChairBack account. Sign in with it instead.`
          : errorCopy(err).body,
      );
    } finally {
      setBusy(false);
    }
  }

  if (step === "idle") {
    return (
      <Row
        title={label}
        subtitle={current ?? "Not added"}
        trailing={
          <Txt variant="subheadStrong" tone="gold">
            {current ? "Change" : "Add"}
          </Txt>
        }
        chevron={false}
        onPress={disabled ? undefined : () => setStep("enter")}
        accessibilityLabel={`${label}. ${current ?? "Not added"}`}
        accessibilityHint={current ? `Change your ${label.toLowerCase()}` : `Add your ${label.toLowerCase()}`}
      />
    );
  }

  return (
    <View style={styles.editor}>
      <Txt variant="subheadStrong">{step === "enter" ? `${current ? "New" : "Your"} ${label.toLowerCase()}` : "Enter the code"}</Txt>
      {step === "enter" ? (
        <TextInput
          value={value}
          onChangeText={setValue}
          autoFocus
          keyboardType={channel === "sms" ? "phone-pad" : "email-address"}
          textContentType={channel === "sms" ? "telephoneNumber" : "emailAddress"}
          autoComplete={channel === "sms" ? "tel" : "email"}
          autoCapitalize="none"
          placeholder={channel === "sms" ? "Mobile number" : "you@example.com"}
          placeholderTextColor={color.textTertiary}
          accessibilityLabel={label}
          style={styles.input}
        />
      ) : (
        <TextInput
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
          autoFocus
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete={channel === "sms" ? "sms-otp" : "one-time-code"}
          placeholder="6-digit code"
          placeholderTextColor={color.textTertiary}
          accessibilityLabel="Verification code"
          style={styles.input}
        />
      )}
      {message ? (
        <Txt variant="footnote" tone="secondary" accessibilityLiveRegion="polite">
          {message}
        </Txt>
      ) : null}
      <View style={styles.editorActions}>
        <Button
          label="Cancel"
          variant="plain"
          onPress={() => {
            setStep("idle");
            setMessage(null);
          }}
        />
        <Button
          label={step === "enter" ? "Send code" : "Verify"}
          variant="secondary"
          busy={busy}
          disabled={step === "enter" ? value.trim().length === 0 : code.length !== 6}
          onPress={step === "enter" ? start : verify}
          style={styles.flex}
        />
      </View>
    </View>
  );
}

function NotificationSettings({ disabled }: { disabled: boolean }) {
  const { api } = useCustomer();
  const prefs = useResource<Notifications>("/api/me/notifications");
  const [saving, setSaving] = useState(false);
  const data = prefs.data;

  async function patch(body: object) {
    setSaving(true);
    try {
      await api.send("PATCH", "/api/me/notifications", body);
      invalidate("/api/me/notifications");
      await prefs.refresh();
    } catch (err) {
      Alert.alert(errorCopy(err).title, errorCopy(err).body);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View>
      <SectionHeader title="Notifications" />
      {!data ? (
        prefs.loading ? <Placeholder height={120} /> : <ErrorState {...errorCopy(prefs.error)} onRetry={prefs.refresh} />
      ) : (
        <>
          <Group>
            <SwitchRow
              title="Push notifications"
              subtitle="Reminders and rewards from your shops"
              value={data.push.enabled}
              disabled={disabled || saving}
              onChange={(v) => void patch({ push: v })}
            />
          </Group>
          {data.texts.length > 0 ? (
            <>
              <Txt variant="footnoteStrong" tone="secondary" style={styles.subhead}>
                Texts from each shop
              </Txt>
              <Group>
                {data.texts.map((t, i) => (
                  <View key={t.key}>
                    {i > 0 ? <Separator /> : null}
                    <SwitchRow
                      title={t.shopName}
                      subtitle={!t.on && !t.canTurnOn ? "Add your mobile number to get texts" : null}
                      value={t.on}
                      disabled={disabled || saving || (!t.on && !t.canTurnOn)}
                      onChange={(v) => void patch({ texts: [{ key: t.key, on: v }] })}
                    />
                  </View>
                ))}
              </Group>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}

function SwitchRow({
  title,
  subtitle,
  value,
  disabled,
  onChange,
}: {
  title: string;
  subtitle?: string | null;
  value: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.flex}>
        <Txt variant="body">{title}</Txt>
        {subtitle ? (
          <Txt variant="footnote" tone="secondary">
            {subtitle}
          </Txt>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={title}
        trackColor={{ true: color.gold, false: color.surfaceRaised }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={color.surfaceRaised}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  demo: {
    padding: space.s2,
    borderRadius: radius.md,
    backgroundColor: color.goldTint,
    gap: space.half,
    marginBottom: space.s2,
  },
  fieldLabel: { marginBottom: space.s1 },
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
  gap: { marginTop: space.s1 + 4 },
  footnote: { marginTop: space.s1, paddingHorizontal: space.half },
  subhead: { marginTop: space.s2, marginBottom: space.s1 },
  editor: { padding: space.s2, gap: space.s1 + 4 },
  editorActions: { flexDirection: "row", alignItems: "center", gap: space.s1 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    minHeight: 56,
    paddingHorizontal: space.s2,
    paddingVertical: space.s1,
  },
  delete: { minHeight: 44, justifyContent: "center", alignSelf: "center", marginTop: space.s3 },
  version: { textAlign: "center", marginTop: space.s1 },
});
