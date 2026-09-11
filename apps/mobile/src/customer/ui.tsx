import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from "react-native";
import { color, radius, space, statusColor, TOUCH, type, type TypeStyle, WORDMARK_FONT } from "./theme";
import { initials } from "./format";
import { ChevronRight, Offline, Person } from "./icons";
import type { CustomerStatus } from "./types";

/**
 * The pieces every My ChairBack screen is built from. Deliberately few:
 * one text component on the iOS type scale, one grouped list (the thing most
 * of this app is made of, as in Settings and Wallet), one avatar that falls
 * back to a monogram when a shop has no photo, one button family.
 */

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * True at the larger Dynamic Type sizes (roughly XXXL and up), where rows of
 * side-by-side controls must stack instead - the iOS pattern at accessibility
 * sizes. React Native reports the user's text scale as `fontScale`.
 */
export function useLargeText(): boolean {
  return useWindowDimensions().fontScale >= 1.3;
}

/** True when the person has asked the system for less motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduced(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function Txt({
  variant = "body",
  tone = "primary",
  style,
  ...rest
}: TextProps & {
  variant?: TypeStyle;
  tone?: "primary" | "secondary" | "tertiary" | "gold" | "onGold";
}) {
  const toneColor = {
    primary: color.text,
    secondary: color.textSecondary,
    tertiary: color.textTertiary,
    gold: color.goldText,
    onGold: color.onGold,
  }[tone];
  return <Text {...rest} style={[type[variant], { color: toneColor }, style]} />;
}

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <Text
      accessibilityRole="header"
      accessibilityLabel="ChairBack"
      // The mark is a logo, not prose: it holds its size so the header row
      // stays one row at every text size.
      allowFontScaling={false}
      style={{ fontFamily: WORDMARK_FONT, fontSize: size, color: color.goldText, letterSpacing: 0.2 }}
    >
      ChairBack
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Pressable surfaces
// ---------------------------------------------------------------------------

/** A pressable with the house press feedback: a quiet surface shift, no bounce. */
export function Tap({
  onPress,
  children,
  style,
  pressedStyle,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = "button",
  disabled,
  dimWhenDisabled = true,
  testID,
}: {
  onPress?: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: "button" | "link";
  disabled?: boolean;
  /** False when the caller draws its own disabled look. */
  dimWhenDisabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        style,
        pressed && (pressedStyle ?? styles.pressed),
        disabled && dimWhenDisabled && styles.disabled,
      ]}
    >
      {children}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  busy,
  disabled,
  accessibilityHint,
  icon,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "plain";
  busy?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  // A disabled primary is drawn neutral, not as dimmed gold (which reads as a
  // muddy brown and still looks like "the" action).
  const inactivePrimary = variant === "primary" && disabled;
  const base = inactivePrimary
    ? styles.btnPrimaryDisabled
    : variant === "primary"
      ? styles.btnPrimary
      : variant === "secondary"
        ? styles.btnSecondary
        : styles.btnPlain;
  const tone = inactivePrimary ? "tertiary" : variant === "primary" ? "onGold" : variant === "plain" ? "gold" : "primary";
  return (
    <Tap
      onPress={busy ? undefined : onPress}
      disabled={disabled}
      dimWhenDisabled={!inactivePrimary}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      style={[styles.btn, base, style]}
      pressedStyle={variant === "primary" ? styles.btnPrimaryPressed : styles.pressed}
    >
      {busy ? (
        <ActivityIndicator color={variant === "primary" ? color.onGold : color.goldText} />
      ) : (
        <View style={styles.btnInner}>
          {icon}
          <Txt variant="headline" tone={tone} style={styles.btnLabel}>
            {label}
          </Txt>
        </View>
      )}
    </Tap>
  );
}

// ---------------------------------------------------------------------------
// Grouped lists
// ---------------------------------------------------------------------------

export function SectionHeader({
  title,
  action,
  onAction,
  actionHint,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  actionHint?: string;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Txt variant="title3" accessibilityRole="header" style={styles.flexShrink}>
        {title}
      </Txt>
      {action && onAction ? (
        <Tap onPress={onAction} accessibilityLabel={action} accessibilityHint={actionHint} style={styles.sectionAction}>
          <Txt variant="subhead" tone="gold">
            {action}
          </Txt>
        </Tap>
      ) : null}
    </View>
  );
}

/** An inset rounded container; rows inside are separated by hairlines. */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.group, style]}>{children}</View>;
}

export function Separator({ inset = space.s2 }: { inset?: number }) {
  return <View style={[styles.separator, { marginLeft: inset }]} />;
}

export function Row({
  leading,
  title,
  subtitle,
  trailing,
  onPress,
  chevron = Boolean(onPress),
  accessibilityLabel,
  accessibilityHint,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: string | null;
  trailing?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const body = (
    <View style={styles.row}>
      {leading}
      <View style={styles.rowText}>
        <Txt variant="body" numberOfLines={2}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt variant="subhead" tone="secondary" numberOfLines={2}>
            {subtitle}
          </Txt>
        ) : null}
      </View>
      {trailing}
      {chevron ? <ChevronRight size={16} color={color.textTertiary} /> : null}
    </View>
  );
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  }
  return (
    <Tap
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? [title, subtitle].filter(Boolean).join(". ")}
      accessibilityHint={accessibilityHint}
      pressedStyle={styles.rowPressed}
    >
      {body}
    </Tap>
  );
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The shop's (or barber's) real photo, else a monogram in the brand's quiet
 * gold. A failed image falls back too - a broken-image box is never shown.
 */
export function Avatar({
  uri,
  name,
  size = 44,
  shape = "rounded",
}: {
  uri: string | null | undefined;
  name: string;
  size?: number;
  shape?: "rounded" | "circle";
}) {
  const [failed, setFailed] = useState(false);
  const r = shape === "circle" ? size / 2 : Math.round(size * 0.24);
  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
        accessible={false}
        style={{ width: size, height: size, borderRadius: r, backgroundColor: color.surfaceRaised }}
      />
    );
  }
  return (
    <View
      accessible={false}
      style={[styles.monogram, { width: size, height: size, borderRadius: r }]}
    >
      <Text allowFontScaling={false} style={[styles.monogramText, { fontSize: Math.round(size * 0.36) }]}>
        {initials(name) || "·"}
      </Text>
    </View>
  );
}

/** The circular profile control in the home header. */
export function ProfileButton({ name, onPress }: { name: string | null; onPress: () => void }) {
  return (
    <Tap
      onPress={onPress}
      accessibilityLabel="Profile"
      accessibilityHint="Your details, notifications and sign-out"
      style={styles.profileHit}
    >
      <View style={styles.profileDisc}>
        {name ? (
          <Text allowFontScaling={false} style={styles.profileText}>
            {initials(name)}
          </Text>
        ) : (
          <Person size={18} color={color.textSecondary} />
        )}
      </View>
    </Tap>
  );
}

// ---------------------------------------------------------------------------
// Status and progress
// ---------------------------------------------------------------------------

/** A status is a WORD with a small dot - the colour never carries it alone. */
export function StatusLabel({ status, label }: { status: CustomerStatus; label: string }) {
  return (
    <View style={styles.status} accessible accessibilityLabel={`Status: ${label}`}>
      <View style={[styles.statusDot, { backgroundColor: statusColor[status] }]} />
      <Txt variant="footnoteStrong" tone="secondary">
        {label}
      </Txt>
    </View>
  );
}

export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={styles.track}
    >
      <View style={[styles.fill, { width: `${clamped * 100}%` }]} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Txt variant="title3" style={styles.center}>
        {title}
      </Txt>
      {body ? (
        <Txt variant="subhead" tone="secondary" style={[styles.center, styles.emptyBody]}>
          {body}
        </Txt>
      ) : null}
      {action && onAction ? <Button label={action} onPress={onAction} style={styles.emptyAction} /> : null}
    </View>
  );
}

export function ErrorState({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <View style={styles.empty} accessibilityLiveRegion="polite">
      <Txt variant="title3" style={styles.center}>
        {title}
      </Txt>
      <Txt variant="subhead" tone="secondary" style={[styles.center, styles.emptyBody]}>
        {body}
      </Txt>
      <Button label="Try again" variant="secondary" onPress={onRetry} style={styles.emptyAction} />
    </View>
  );
}

/** Shown above cached content when the latest refresh couldn't reach us. */
export function StaleBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <Tap
      onPress={onRetry}
      accessibilityLabel="You're offline. Showing what was last loaded. Tap to try again."
      style={styles.banner}
    >
      <Offline size={18} color={color.textSecondary} />
      <Txt variant="footnote" tone="secondary" style={styles.flexShrink}>
        Offline - showing what was last loaded. Tap to try again.
      </Txt>
    </Tap>
  );
}

/**
 * A loading placeholder the shape of what's coming. A slow opacity breath
 * says "working"; under Reduce Motion it simply holds still.
 */
export function Placeholder({ height, style }: { height: number; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);
  return (
    <Animated.View
      accessible={false}
      style={[{ height, borderRadius: radius.lg, backgroundColor: color.surface, opacity: reduced ? 0.8 : pulse }, style]}
    />
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.4 },
  flexShrink: { flexShrink: 1 },
  center: { textAlign: "center" },

  btn: {
    minHeight: TOUCH + 6,
    borderRadius: radius.md,
    paddingHorizontal: space.s2,
    paddingVertical: space.s1 + 2,
    alignItems: "center",
    justifyContent: "center",
  },
  btnInner: { flexDirection: "row", alignItems: "center", gap: space.s1 },
  btnLabel: { textAlign: "center" },
  btnPrimary: { backgroundColor: color.gold },
  btnPrimaryPressed: { backgroundColor: "#C19F31" },
  btnPrimaryDisabled: {
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  btnSecondary: {
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
  },
  btnPlain: { backgroundColor: "transparent", minHeight: TOUCH },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    marginTop: space.s4,
    marginBottom: space.s1,
  },
  sectionAction: { minHeight: TOUCH, minWidth: TOUCH, alignItems: "flex-end", justifyContent: "center" },

  group: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    overflow: "hidden",
  },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: color.hairlineStrong },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2 - 4,
    minHeight: TOUCH + 12,
    paddingHorizontal: space.s2,
    paddingVertical: space.s1 + 2,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowPressed: { backgroundColor: color.surfacePressed },

  monogram: {
    backgroundColor: color.goldTint,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(212,175,55,0.28)",
  },
  monogramText: { color: color.goldText, fontWeight: "700" },

  profileHit: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" },
  profileDisc: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  profileText: { color: color.text, fontSize: 13, fontWeight: "600" },

  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },

  track: { height: 6, borderRadius: 3, backgroundColor: color.surfaceRaised, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3, backgroundColor: color.gold },

  empty: { alignItems: "center", paddingVertical: space.s4, paddingHorizontal: space.s3 },
  emptyBody: { marginTop: space.s1, maxWidth: 320 },
  emptyAction: { marginTop: space.s3, alignSelf: "stretch" },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s1,
    minHeight: TOUCH,
    paddingHorizontal: space.s2,
    paddingVertical: space.s1,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    marginBottom: space.s2,
  },
});
