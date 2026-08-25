import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { WEB_ORIGIN } from "@/src/config";
import { buildJoinStartUrl, inviteTokenFrom } from "@/src/joinFlow";
import {
  completeFromUrl,
  createAttempt,
  forgetAttempt,
  openJoinSession,
  rememberAttempt,
} from "@/src/joinAuth";

/**
 * "Join your shop" - how a barber who was INVITED to an existing shop gets into
 * the app.
 *
 * WHAT THIS IS NOT. It is not a sign-up screen. No account is created here, no
 * shop is created anywhere, and nothing is sold: an invited employee's account
 * is free, and the invitation had to already exist before this screen can do
 * anything at all. Account creation happens on ChairBack's own website, in the
 * system authentication browser, because Google blocks OAuth in embedded
 * WebViews and because App Store Guideline 3.1.1 keeps business registration
 * out of the app. See src/joinAuth.ts for the mechanics.
 *
 * THE ONE THING THE BARBER HAS TO DO is give us their invitation. They will
 * paste the link from their email; the code alone works too. Everything after
 * that tap is automatic, and they end up on their own calendar without signing
 * in a second time.
 */

const COLORS = {
  bg: "#0A0A0B",
  surface: "#161618",
  border: "rgba(245,245,244,0.10)",
  gold: "#D4AF37",
  goldMuted: "#B8962F",
  text: "#F5F5F4",
  muted: "#A1A1AA",
  danger: "#F87171",
} as const;

/**
 * Everything that can be true at once, as one value. The screen has a handful
 * of failure states and they are all resting states - none of them is a dead
 * end, every one leaves the field and the button usable.
 */
type Status =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "finishing" }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string };

export default function JoinScreen() {
  // Pre-filled when the barber got here by TAPPING the invitation link on their
  // phone (app/team/join.tsx), rather than by pasting it.
  const { invite: prefill } = useLocalSearchParams<{ invite?: string }>();
  const [invite, setInvite] = useState(prefill ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Guards a double tap from opening two browser sheets and two attempts.
  const busy = useRef(false);

  const start = useCallback(async () => {
    if (busy.current) return;
    const token = inviteTokenFrom(invite);
    if (!token) {
      setStatus({
        kind: "error",
        text: "That doesn't look like an invitation link. Paste the whole link from your email, or just the code at the end of it.",
      });
      return;
    }

    busy.current = true;
    setStatus({ kind: "opening" });
    try {
      const attempt = await createAttempt();
      await rememberAttempt(attempt);
      const result = await openJoinSession(
        buildJoinStartUrl({
          webOrigin: WEB_ORIGIN,
          token,
          state: attempt.state,
          codeChallenge: attempt.challenge,
        }),
      );

      if (result.kind === "canceled") {
        // They closed the sheet. Not a failure, and nothing was lost - the
        // invitation is still theirs to use.
        await forgetAttempt();
        setStatus({ kind: "note", text: "No problem - tap Continue when you're ready." });
        return;
      }
      if (result.kind === "failed") {
        await forgetAttempt();
        setStatus({
          kind: "error",
          text: "We couldn't open the sign-in page. Check your connection and try again.",
        });
        return;
      }

      setStatus({ kind: "finishing" });
      const completed = await completeFromUrl(result.url);
      if (completed === "joined") {
        router.replace("/barber");
        return;
      }
      setStatus({ kind: "error", text: COMPLETION_COPY[completed] });
    } finally {
      busy.current = false;
    }
  }, [invite]);

  const working = status.kind === "opening" || status.kind === "finishing";

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <Text style={styles.title}>Join your shop</Text>
            <Text style={styles.sub}>
              Your shop sends you an invitation by email. Paste that link below
              and we&apos;ll set up your access.
            </Text>

            <TextInput
              value={invite}
              onChangeText={(text) => {
                setInvite(text);
                if (status.kind === "error" || status.kind === "note") {
                  setStatus({ kind: "idle" });
                }
              }}
              placeholder="Paste your invitation link"
              placeholderTextColor={COLORS.muted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              inputMode="url"
              multiline
              editable={!working}
              accessibilityLabel="Invitation link or code"
              style={styles.input}
            />

            {status.kind === "error" && <Text style={styles.error}>{status.text}</Text>}
            {status.kind === "note" && <Text style={styles.note}>{status.text}</Text>}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Continue to secure sign-in"
              disabled={working}
              onPress={start}
              style={[styles.primary, working && styles.disabled]}
            >
              {working ? (
                <View style={styles.row}>
                  <ActivityIndicator color={COLORS.bg} size="small" />
                  <Text style={styles.primaryText}>
                    {status.kind === "opening" ? "Opening secure sign-in…" : "Finishing up…"}
                  </Text>
                </View>
              ) : (
                <Text style={styles.primaryText}>Continue</Text>
              )}
            </Pressable>

            <Text style={styles.reassurance}>
              Sign-in opens in a secure browser window so your password or Apple
              and Google details are never typed into this app.
            </Text>

            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace("/login")}
              disabled={working}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Back to sign in</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/**
 * What to say when the return trip didn't produce a session. None of these
 * blames the barber, and none of them says "contact support" - each one names
 * the next tap.
 */
const COMPLETION_COPY: Record<string, string> = {
  expired:
    "That sign-in took a little too long. Tap Continue to try again - your invitation is still good.",
  offline: "We couldn't reach ChairBack. Check your connection and tap Continue.",
  no_attempt: "Something interrupted that. Tap Continue to start again.",
  not_ours: "Something interrupted that. Tap Continue to start again.",
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  safe: { flex: 1 },
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, paddingVertical: 32 },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: "700",
    textAlign: "center",
  },
  sub: {
    color: COLORS.muted,
    // 16 is the floor on every field and body line here: below it, iOS Safari
    // and the in-app keyboard both zoom the view on focus.
    fontSize: 16,
    lineHeight: 23,
    textAlign: "center",
    marginTop: 10,
    marginBottom: 24,
  },
  input: {
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    color: COLORS.text,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    textAlignVertical: "top",
  },
  primary: {
    minHeight: 52,
    marginTop: 16,
    borderRadius: 14,
    backgroundColor: COLORS.gold,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  primaryText: { color: COLORS.bg, fontSize: 16, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  disabled: { backgroundColor: COLORS.goldMuted, opacity: 0.8 },
  secondary: {
    minHeight: 44,
    marginTop: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { color: COLORS.muted, fontSize: 16 },
  reassurance: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginTop: 18,
  },
  error: { color: COLORS.danger, fontSize: 16, lineHeight: 22, marginTop: 12 },
  note: { color: COLORS.muted, fontSize: 16, lineHeight: 22, marginTop: 12 },
});
