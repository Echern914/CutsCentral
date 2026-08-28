import { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppWebView } from "@/src/AppWebView";
import { router, useLocalSearchParams } from "expo-router";
import * as Linking from "expo-linking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { rewardsUrl, API_ORIGIN, DEMO_REWARDS_TOKEN, STORAGE } from "@/src/config";
import { registerCustomerPush } from "@/src/push";
import { ModeSwitchBar } from "@/src/ModeSwitchBar";

/**
 * Customer mode: a WebView of the existing /r/[magicToken] rewards page - the
 * SAME page customers see on the web, so there is no second UI to maintain.
 *
 * Identity (a customer has no password): the magic token comes from
 *  1. a deep link (chairback://r/<token> or the https universal link), else
 *  2. the last token we saw (stored), else
 *  3. a "text me my link" fallback that POSTs to the public resolver so the
 *     barber's system texts them their link, which then deep-links back in.
 * Once we have a token we register the device for native push, keyed to it.
 */
export default function CustomerScreen() {
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [phone, setPhone] = useState("");
  // The in-app recovery machine: enter phone -> verify -> choose business.
  const [recStep, setRecStep] = useState<"phone" | "code" | "choose">("phone");
  const [recCode, setRecCode] = useState("");
  const [recProof, setRecProof] = useState<string | null>(null);
  const [recShops, setRecShops] = useState<
    { selectionId: string; name: string; city: string | null; region: string | null; industry: string }[]
  >([]);
  const [recMsg, setRecMsg] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const [linkErr, setLinkErr] = useState<string | null>(null);
  // Demonstration mode (App Review Guideline 2.1a): browse the seeded demo
  // client's rewards page. Deliberately NOT persisted (a relaunch returns to
  // the real entry screen) and NEVER push-registered (the shared demo client
  // must not accumulate reviewers' device tokens).
  const [demoActive, setDemoActive] = useState(false);
  const registered = useRef(false);

  // Resolve a token from the deep link that launched/opened us, the route param,
  // or storage. Listen for links that arrive while the app is already open too.
  const adopt = useCallback(async (t: string) => {
    setToken(t);
    await AsyncStorage.setItem(STORAGE.lastToken, t);
  }, []);

  useEffect(() => {
    (async () => {
      // CRITICAL: every await here is wrapped so that resolving ALWAYS settles.
      // If getInitialURL() or AsyncStorage ever throws/hangs, an unguarded await
      // would leave `resolving` true forever - a permanent launch spinner that
      // never even reaches the error screen. try/finally guarantees we exit the
      // loading state no matter what.
      try {
        if (params.token) {
          await adopt(params.token);
          return;
        }
        let initial: string | null = null;
        try {
          initial = await Linking.getInitialURL();
        } catch {
          initial = null;
        }
        const fromLink = initial ? parseToken(initial) : null;
        if (fromLink) {
          await adopt(fromLink);
          return;
        }
        let saved: string | null = null;
        try {
          saved = await AsyncStorage.getItem(STORAGE.lastToken);
        } catch {
          saved = null;
        }
        if (saved) setToken(saved);
      } finally {
        setResolving(false);
      }
    })();
    const sub = Linking.addEventListener("url", ({ url }) => {
      const t = parseToken(url);
      if (t) adopt(t);
    });
    return () => sub.remove();
  }, [params.token, adopt]);

  // Register for native push once we know who this is. Fire-and-forget, and
  // .catch'd so a push failure can never surface as an unhandled rejection.
  useEffect(() => {
    if (token && !registered.current) {
      registered.current = true;
      registerCustomerPush(token).catch(() => {});
    }
  }, [token]);

  // Direct entry: the customer pastes the rewards link (or just the token) they
  // already have. No SMS/Twilio needed - this is the cold-start path that works
  // even before texting is live, and the recovery path when a text goes missing.
  // parseToken() accepts a full https/chairback URL; we also accept a bare token.
  async function openPastedLink() {
    setLinkErr(null);
    const raw = linkInput.trim();
    if (!raw) { setLinkErr("Paste your rewards link."); return; }
    // A full URL → pull the token out of /r/<token>; otherwise treat the input
    // as the bare token itself (what's after /r/).
    const t = parseToken(raw) ?? (/^[A-Za-z0-9_-]+$/.test(raw) ? raw : null);
    if (!t) { setLinkErr("That doesn't look like a rewards link."); return; }
    await adopt(t);
  }

  /**
   * Verified recovery, in-app: prove the phone, then choose the business.
   *
   * This REPLACED "text me my link", which asked the API to pick a shop for a
   * bare phone number - and the API picked "most recently active", which could
   * be a different shop than the one whose card the customer wanted. Now no
   * shop is ever chosen for them: they verify, see their own shops, and tap
   * one. The copy on the code step is deliberately noncommittal ("if that
   * number's on file...") - the app never learns whether a number exists until
   * its owner proves it.
   */
  async function recoveryStart() {
    setRecMsg(null);
    const p = phone.trim();
    if (!p) { setRecMsg("Enter your mobile number."); return; }
    const res = await fetch(`${API_ORIGIN}/api/rewards-recovery/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: p }),
    }).catch(() => null);
    if (!res || !res.ok) { setRecMsg("Something went wrong. Please try again."); return; }
    setRecCode("");
    setRecStep("code");
  }

  async function recoveryVerify() {
    setRecMsg(null);
    const res = await fetch(`${API_ORIGIN}/api/rewards-recovery/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phone.trim(), code: recCode.trim() }),
    }).catch(() => null);
    const data = res && res.ok ? ((await res.json()) as { verified: boolean; proof?: string }) : null;
    if (!data?.verified || !data.proof) {
      setRecMsg("That code didn't work. Check it, or send a fresh one.");
      return;
    }
    const list = await fetch(`${API_ORIGIN}/api/rewards-recovery/shops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof: data.proof }),
    }).catch(() => null);
    const shops = list && list.ok ? ((await list.json()) as { shops: typeof recShops }).shops : null;
    if (!shops) { setRecMsg("Something went wrong. Please try again."); return; }
    setRecProof(data.proof);
    setRecShops(shops);
    setRecStep("choose");
  }

  async function recoveryChoose(selectionId: string) {
    if (!recProof) return;
    setRecMsg(null);
    const res = await fetch(`${API_ORIGIN}/api/rewards-recovery/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof: recProof, selectionId }),
    }).catch(() => null);
    const data = res && res.ok ? ((await res.json()) as { ok: boolean; url?: string }) : null;
    const t = data?.url ? parseToken(data.url) : null;
    if (!t) { setRecMsg("Something went wrong. Please try again."); return; }
    // The selected shop's rewards credential - adopted exactly like a pasted
    // link, because it IS the same credential.
    await adopt(t);
  }

  if (resolving) {
    return (
      <View style={styles.center}><ActivityIndicator color="#fff" /></View>
    );
  }

  if (token || demoActive) {
    return (
      <SafeAreaView style={styles.flex} edges={["top"]}>
        {/* The way back to the picker — a customer who is also a barber gets
            to their chair from here. */}
        <ModeSwitchBar label="Customer" />
        {/* A real token always wins over the demo (a customer with their own
            link never sees demo chrome). */}
        {!token && (
          <View style={styles.demoBar}>
            <Text style={styles.demoBarText}>Demo shop — nothing here is real</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Exit the demo"
              onPress={() => setDemoActive(false)}
            >
              <Text style={styles.demoBarExit}>Done</Text>
            </Pressable>
          </View>
        )}
        {/* awaitsReady: the rewards page posts "cb:ready" when its real UI mounts,
            so the spinner clears on that - not on the streamed loading shell. */}
        <AppWebView
          source={{ uri: rewardsUrl(token ?? DEMO_REWARDS_TOKEN) }}
          style={styles.flex}
          awaitsReady
          onMessage={(e) => {
            // The rewards page posts "cb:deleted" after a self-serve data
            // deletion: this magic link is now dead (it would 404 on reload), so
            // forget it and drop back to the entry screen instead of reopening it.
            // (The demo client refuses deletion server-side; clearing demoActive
            // here is just belt-and-suspenders.)
            if (e.nativeEvent.data === "cb:deleted") {
              AsyncStorage.removeItem(STORAGE.lastToken).catch(() => {});
              setToken(null);
              setDemoActive(false);
            }
          }}
        />
      </SafeAreaView>
    );
  }

  // No token yet. Three ways in:
  //  1. PASTE the rewards link the barber texted (primary - works with no SMS).
  //  2. "Text me my link" (fallback - needs texting to be live).
  //  3. Browse the demo shop (no link needed - also App Review's way in).
  //
  // The form must stay reachable when the on-screen keyboard opens. A plain RN
  // View does NOT avoid the keyboard, so without this the "Text me my link"
  // button (below the focused field) is covered with no way to reach it - the
  // App Review 2.1(a) reject ("no button to continue was visible" on iPad).
  // KeyboardAvoidingView lifts the content; the ScrollView guarantees every
  // control is scrollable into view on any screen size; flexGrow+center keeps
  // today's centered look when it fits. keyboardShouldPersistTaps="handled" is
  // required so the FIRST tap on a button fires onPress instead of only
  // dismissing the keyboard.
  return (
    <SafeAreaView style={styles.flex}>
      {/* Without this the entry screen is a DEAD END: a barber who switched to
          customer mode and has no magic link yet could not get back. */}
      <ModeSwitchBar label="Customer" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <Text style={styles.title}>Your rewards</Text>
          <Text style={styles.sub}>
            Paste the rewards link your barber texted you:
          </Text>
          <TextInput
            value={linkInput}
            onChangeText={setLinkInput}
            placeholder="getchairback.com/r/..."
            placeholderTextColor="#6b6b70"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />
          {linkErr && <Text style={styles.note}>{linkErr}</Text>}
          <Pressable style={styles.button} onPress={openPastedLink}>
            <Text style={styles.buttonText}>Open my rewards</Text>
          </Pressable>

          <View style={styles.divider}>
            <View style={styles.line} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.line} />
          </View>

          {recStep === "phone" && (
            <>
              <Text style={styles.sub}>Don&apos;t have the link? Verify your number:</Text>
              <TextInput
                value={phone}
                onChangeText={setPhone}
                placeholder="Your mobile number"
                placeholderTextColor="#6b6b70"
                keyboardType="phone-pad"
                style={styles.input}
              />
              {recMsg && <Text style={styles.note}>{recMsg}</Text>}
              <Pressable style={[styles.button, styles.buttonSecondary]} onPress={recoveryStart}>
                <Text style={styles.buttonSecondaryText}>Text me a code</Text>
              </Pressable>
            </>
          )}
          {recStep === "code" && (
            <>
              <Text style={styles.sub}>
                If that number&apos;s on file, we just texted a 6-digit code.
              </Text>
              <TextInput
                value={recCode}
                onChangeText={(v) => setRecCode(v.replace(/\D/g, ""))}
                placeholder="6-digit code"
                placeholderTextColor="#6b6b70"
                keyboardType="number-pad"
                maxLength={6}
                style={styles.input}
              />
              {recMsg && <Text style={styles.note}>{recMsg}</Text>}
              <Pressable style={[styles.button, styles.buttonSecondary]} onPress={recoveryVerify}>
                <Text style={styles.buttonSecondaryText}>Verify</Text>
              </Pressable>
              <Pressable style={styles.demoLink} onPress={recoveryStart}>
                <Text style={styles.demoLinkText}>Send a fresh code</Text>
              </Pressable>
            </>
          )}
          {recStep === "choose" && (
            <>
              <Text style={styles.sub}>
                {recShops.length === 0
                  ? "We couldn't find rewards for this number. If your shop uses ChairBack, ask them to add it to your profile."
                  : "Choose your business:"}
              </Text>
              {recShops.map((shop) => (
                <Pressable
                  key={shop.selectionId}
                  style={[styles.button, styles.buttonSecondary]}
                  onPress={() => recoveryChoose(shop.selectionId)}
                >
                  <Text style={styles.buttonSecondaryText}>
                    {shop.name}
                    {shop.city ? ` \u2014 ${shop.city}${shop.region ? ", " + shop.region : ""}` : ""}
                  </Text>
                </Pressable>
              ))}
              {recMsg && <Text style={styles.note}>{recMsg}</Text>}
              <Pressable style={styles.demoLink} onPress={() => setRecStep("phone")}>
                <Text style={styles.demoLinkText}>Different number</Text>
              </Pressable>
            </>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try the demo rewards page"
            style={styles.demoLink}
            onPress={() => setDemoActive(true)}
          >
            <Text style={styles.demoLinkText}>Just looking? Try the demo →</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            style={styles.back}
            onPress={() =>
              // "switching=1" asks the picker to SHOW itself instead of
              // auto-routing this returning user straight back here - without
              // deleting the saved role, which is what used to make the picker
              // a dead end. See src/mode.ts.
              router.replace({ pathname: "/", params: { switching: "1" } })
            }
          >
            <Text style={styles.backText}>← Not a customer? Go back</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Pull the magic token out of chairback://r/<token> or https://host/r/<token>. */
function parseToken(url: string): string | null {
  const m = url.match(/\/r\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#0A0A0B" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0B" },
  // flexGrow lets the content center when it fits but grow/scroll when the
  // keyboard shrinks the viewport, so no control is ever unreachable.
  scrollContent: { padding: 24, flexGrow: 1, justifyContent: "center" },
  title: { color: "#fff", fontSize: 26, fontWeight: "700" },
  sub: { color: "#8a8a8f", fontSize: 14, marginTop: 8, marginBottom: 20 },
  input: { backgroundColor: "#151517", borderWidth: 1, borderColor: "#26262b", borderRadius: 12, color: "#fff", padding: 14, fontSize: 16 },
  note: { color: "#8a8a8f", fontSize: 13, marginTop: 10 },
  button: { backgroundColor: "#fff", borderRadius: 12, padding: 15, alignItems: "center", marginTop: 16 },
  buttonText: { color: "#0A0A0B", fontSize: 16, fontWeight: "600" },
  buttonSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#26262b" },
  buttonSecondaryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  divider: { flexDirection: "row", alignItems: "center", marginVertical: 28 },
  line: { flex: 1, height: 1, backgroundColor: "#26262b" },
  dividerText: { color: "#6b6b70", fontSize: 13, marginHorizontal: 12 },
  demoLink: { marginTop: 24, alignSelf: "center" },
  demoLinkText: { color: "#D4AF37", fontSize: 14, fontWeight: "600" },
  demoBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "#151517",
    borderBottomWidth: 1,
    borderBottomColor: "#26262b",
  },
  demoBarText: { color: "#8a8a8f", fontSize: 12 },
  demoBarExit: { color: "#D4AF37", fontSize: 13, fontWeight: "600" },
  back: { marginTop: 28, alignSelf: "center" },
  backText: { color: "#6b6b70", fontSize: 13 },
});
