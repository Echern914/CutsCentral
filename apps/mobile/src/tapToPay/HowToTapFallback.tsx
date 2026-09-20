import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

/**
 * Our own "How to Tap" instructions, for iOS versions without Apple's overlay.
 *
 * 🔴 A FALLBACK, NEVER A SUBSTITUTE. On iOS 18+ Apple's ProximityReaderDiscovery
 * content is the requirement and this screen must not appear - it is not
 * localized for the merchant's region and Apple does not keep it current. It
 * exists so a barber on an older supported iPhone is still taught how to hold
 * the card, rather than being shown nothing.
 *
 * The instructions describe what actually happens on an iPhone: the reader is
 * at the TOP of the device, near the camera, and the card must stay there until
 * the phone confirms - moving away at the first vibration is the single most
 * common reason a tap fails.
 */
export function HowToTapFallback({
  visible,
  onDismiss,
}: {
  visible: boolean;
  /** Resolves the caller's promise: the barber has read it. */
  onDismiss: () => void;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onDismiss}
    >
      <View style={styles.sheet}>
        <Text style={styles.title}>How to take a tap</Text>

        <View style={styles.steps}>
          <Step
            n="1"
            title="Hold the card to the top of this iPhone"
            body="The reader is at the top edge, near the camera. A card, phone or watch all work."
          />
          <Step
            n="2"
            title="Keep it there until the phone says so"
            body="Wait for the checkmark. Moving away at the first vibration is the usual reason a tap does not go through."
          />
          <Step
            n="3"
            title="Some cards ask for a PIN"
            body="If a keypad appears, hand the phone to the customer and let them enter it themselves."
          />
        </View>

        <Text style={styles.footnote}>
          Nothing is charged until you confirm the amount on the checkout screen.
        </Text>

        <Pressable style={styles.button} onPress={onDismiss} accessibilityRole="button">
          <Text style={styles.buttonText}>Got it</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{n}</Text>
      </View>
      <View style={styles.stepText}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: "#0A0A0B", padding: 24, gap: 24 },
  title: { color: "#F5F5F4", fontSize: 26, fontWeight: "700", marginTop: 12 },
  steps: { gap: 20 },
  step: { flexDirection: "row", gap: 14 },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#C8A24A",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#0A0A0B", fontWeight: "700" },
  stepText: { flex: 1, gap: 4 },
  stepTitle: { color: "#F5F5F4", fontSize: 16, fontWeight: "600" },
  stepBody: { color: "#A1A1AA", fontSize: 14, lineHeight: 20 },
  footnote: { color: "#A1A1AA", fontSize: 13, lineHeight: 18 },
  button: {
    marginTop: "auto",
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: "#C8A24A",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: "#0A0A0B", fontSize: 17, fontWeight: "700" },
});
