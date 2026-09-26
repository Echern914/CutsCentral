import { useEffect, useState, type ReactNode } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { walletPassNative } from "@/modules/wallet-pass";
import { AppWebView } from "@/src/AppWebView";
import { WEB_ORIGIN } from "@/src/config";
import { parseAddWalletPassRequest } from "@/src/walletBridge";
import { errorCopy } from "./api";
import { color, space } from "./theme";
import { ErrorState, Placeholder, Tap, Txt } from "./ui";

/**
 * A shop's own web page (storefront, booking, manage) inside My ChairBack.
 *
 * It is the EXISTING page, byte for byte - the app never rebuilds a
 * storefront. What the app adds is the frame: a native bar with the shop's
 * name and a "Done" that always returns to My ChairBack, whatever the page
 * inside has navigated to. The URL is fetched on open (it carries this
 * customer's own link) and never cached.
 *
 * Only ChairBack's own origin is ever loaded as the first page: a URL that
 * arrived any other way is refused before the WebView sees it.
 *
 * 🔴 THE WALLET BRIDGE LIVES HERE, not in each screen. Every page a customer
 * can reach inside the app goes through this component - the storefront, the
 * booking flow, the manage page - and all three can offer an appointment pass.
 * Wiring it once here is what stops three screens growing three slightly
 * different copies of it. A page that posts anything else is unaffected: the
 * message is forwarded on untouched.
 */
export function WebPage({
  title,
  load,
  onClose,
  onMessage,
  banner,
}: {
  title: string;
  /** Resolve the page's URL (from the API, or a known link). */
  load: () => Promise<string>;
  onClose?: () => void;
  /** Bridge messages the page posts (e.g. "cb:deleted"). */
  onMessage?: (data: string) => void;
  /** A native strip above the page - used to offer connecting this profile. */
  banner?: ReactNode;
}) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    load()
      .then((u) => {
        if (!alive) return;
        if (!u.startsWith(`${WEB_ORIGIN}/`)) throw new Error("off_origin");
        setUrl(u);
      })
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  function done() {
    onClose?.();
    if (router.canGoBack()) router.back();
    else router.replace("/customer");
  }

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          title,
          headerLeft: () => (
            <Tap onPress={done} accessibilityLabel="Done" accessibilityHint="Returns to My ChairBack" style={styles.done}>
              <Txt variant="headline" tone="gold">
                Done
              </Txt>
            </Tap>
          ),
        }}
      />
      {banner}
      {url ? (
        <AppWebView
          source={{ uri: url }}
          style={styles.root}
          awaitsReady
          onMessage={(e) => {
            const raw = e.nativeEvent.data;
            // "Add to Apple Wallet", which the page cannot do for itself in a
            // WKWebView. parseAddWalletPassRequest builds the URL from OUR
            // origin and the token, so nothing the page says can point this
            // anywhere else.
            const pass = parseAddWalletPassRequest(raw, { webOrigin: WEB_ORIGIN });
            if (pass) {
              void addToWallet(pass.url);
              return;
            }
            onMessage?.(raw);
          }}
        />
      ) : error ? (
        <View style={styles.pad}>
          <ErrorState {...errorCopy(error)} onRetry={() => setAttempt((n) => n + 1)} />
        </View>
      ) : (
        <View style={styles.pad}>
          <Placeholder height={200} />
        </View>
      )}
    </View>
  );
}

/**
 * Hand a pass URL to PassKit.
 *
 * Silent on success - Wallet's own sheet is the confirmation, and a second
 * "Added!" on top of it would be noise. Silent on a DISMISS too: choosing not
 * to add a pass is not an error and must not be reported as one.
 *
 * 🔴 Speaks up only when the pass could not be offered at all, because the
 * alternative is a button that visibly does nothing. The likeliest cause in
 * production is the server being unable to sign (the WALLET_APPT_* ceremony),
 * and "not available right now" is the honest customer-facing version of that
 * without leaking which of the several reasons it was.
 */
async function addToWallet(url: string): Promise<void> {
  const native = walletPassNative();
  if (!native) {
    // An older build with no native half. The web page should not have offered
    // the button (it asks first), so this is a mismatch worth saying out loud
    // rather than a dead tap.
    Alert.alert("Update ChairBack", "Adding to Apple Wallet needs a newer version of the app.");
    return;
  }
  try {
    await native.presentPass(url);
  } catch {
    Alert.alert("Not available", "This appointment could not be added to Apple Wallet right now.");
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  pad: { padding: space.s3 },
  // Room inside the bar-button capsule iOS draws around a header item: with no
  // horizontal padding the capsule hugged the word and "Done" looked jammed
  // against its edges. Centered, so the word sits in the middle of it.
  done: { minHeight: 44, minWidth: 44, paddingHorizontal: space.s1 + 4, justifyContent: "center", alignItems: "center" },
});
