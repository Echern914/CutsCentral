import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { walletPassNative } from "@/modules/wallet-pass";
import { radius, space } from "./theme";
import { Tap, Txt } from "./ui";

/**
 * Apple Wallet in My ChairBack - the shell half, shared by every screen that
 * offers an appointment pass: the shop's pages in a WebView (WebPage.tsx, via
 * the page bridge) and the native View details screen.
 *
 * The RULES (which URL may reach PassKit, when the badge shows) live in
 * src/walletBridge.ts, pure and tested. This file is only the wiring to
 * PassKit and the badge itself.
 */

/**
 * Does this build, on this device, have a way to add a pass at all?
 * False on Android, in a build from before the PassKit module (#451), and on a
 * phone where Wallet is restricted. Never throws.
 */
export function nativeCanAddPasses(): boolean {
  const native = walletPassNative();
  if (!native) return false;
  try {
    return native.canAddPasses();
  } catch {
    return false;
  }
}

/** The honest customer-facing version of "the pass could not be offered". */
export function walletUnavailableAlert(): void {
  Alert.alert("Not available", "This appointment could not be added to Apple Wallet right now.");
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
export async function presentWalletPass(url: string): Promise<void> {
  const native = walletPassNative();
  if (!native) {
    // An older build with no native half. The caller should not have offered
    // the button (it asks first), so this is a mismatch worth saying out loud
    // rather than a dead tap.
    Alert.alert("Update ChairBack", "Adding to Apple Wallet needs a newer version of the app.");
    return;
  }
  try {
    await native.presentPass(url);
  } catch {
    walletUnavailableAlert();
  }
}

/**
 * "Add to Apple Wallet" - the same badge the web shows (components/
 * AddToWallet.tsx): Apple's black badge, the layered-cards Wallet mark, and
 * the two-line "Add to / Apple Wallet" wording. Black in both themes, as
 * Apple's badge always is.
 */
export function AddToWalletBadge({ onPress, busy }: { onPress: () => void; busy?: boolean }) {
  return (
    <View style={styles.wrap}>
      <Tap
        onPress={onPress}
        disabled={busy}
        dimWhenDisabled={false}
        accessibilityLabel="Add this appointment to Apple Wallet"
        accessibilityHint="Opens Apple Wallet's add sheet"
        style={styles.badge}
        testID="add-to-apple-wallet"
      >
        {busy ? (
          <ActivityIndicator color="#FFFFFF" style={styles.mark} />
        ) : (
          <Svg width={30} height={23} viewBox="0 0 26 20" style={styles.mark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Rect x={1} y={0.5} width={24} height={5.5} rx={2} fill="#D9A946" />
            <Rect x={1} y={4.5} width={24} height={5.5} rx={2} fill="#DE5B4F" />
            <Rect x={1} y={8.5} width={24} height={5.5} rx={2} fill="#4CA5DF" />
            <Path d="M1 13.5 h24 v3 a3 3 0 0 1 -3 3 h-18 a3 3 0 0 1 -3 -3 z" fill="#4CAF50" />
          </Svg>
        )}
        <View>
          <Txt variant="caption" style={styles.small}>
            Add to
          </Txt>
          <Txt variant="headline" style={styles.big}>
            Apple Wallet
          </Txt>
        </View>
      </Tap>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center" },
  badge: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: space.s1 + 2,
    paddingHorizontal: space.s2 + 4,
    paddingVertical: space.s1,
    borderRadius: radius.md,
    backgroundColor: "#000000",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#A6A6A6",
  },
  mark: { width: 30, height: 23 },
  small: { color: "#FFFFFF", opacity: 0.85 },
  big: { color: "#FFFFFF" },
});
