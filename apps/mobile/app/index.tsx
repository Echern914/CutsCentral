import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Redirect, router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Svg, {
  Circle,
  Defs,
  Path,
  Rect,
  RadialGradient,
  LinearGradient as SvgLinearGradient,
  Stop,
} from "react-native-svg";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE } from "@/src/config";

/**
 * First screen: a 3-way role picker ("Spotlight Hero" direction).
 *
 * A cinematic hero - a single centered gold scissor emblem inside a large soft
 * radial gold glow at the top, the wordmark beneath, then a sleek minimal stack
 * of full-width pill rows (each with a leading icon). The emblem fades/scales in
 * first, then the rows cascade.
 *
 * THREE roles, TWO destinations:
 *   - "I own a barbershop"      -> mode "barber"   -> /login -> /barber
 *   - "I manage multiple shops" -> mode "manager"  -> /login -> /barber  (same
 *                                                     dashboard; switcher later)
 *   - "I'm a customer"          -> mode "customer" -> /customer
 *
 * The choice is remembered: a returning user is sent straight to their mode on
 * next launch (they only see this picker the first time, or after switching
 * modes). A deep link (chairback://r/<token> or the universal link) bypasses
 * this entirely and lands in customer mode.
 *
 * The 3-way picker is LIVE (it no longer gates on a barber-mode flag).
 * Hooks run unconditionally (rules of hooks); the returning-user fast path is a
 * DECLARATIVE <Redirect> (mount-safe) rather than an imperative router.replace()
 * inside an on-mount effect - the imperative call can be silently dropped if it
 * fires before the Root Layout has mounted (the classic expo-router launch hang
 * this app's _layout.tsx explicitly warns about). If storage fails we SHOW the
 * picker rather than hang on a spinner.
 */

type Mode = "barber" | "manager" | "customer";

/**
 * Where each saved mode sends the user. Barber AND manager route to /login
 * first: the dashboard is a WebView and Google blocks OAuth inside embedded
 * WebViews, so they sign in NATIVELY on /login, which hands off to /barber (the
 * dashboard WebView) once authenticated. Manager shares the barber dashboard.
 */
const DESTINATION: Record<Mode, "/login" | "/customer"> = {
  barber: "/login",
  manager: "/login",
  customer: "/customer",
};

/** Narrow a stored value to a Mode (ignores any legacy/garbage string). */
function isMode(v: string | null): v is Mode {
  return v === "barber" || v === "manager" || v === "customer";
}

const COLORS = {
  bg: "#0A0A0B",
  surface: "rgba(20,20,22,0.72)",
  surfaceHi: "#1C1C1F",
  border: "rgba(245,245,244,0.08)",
  borderStrong: "rgba(245,245,244,0.14)",
  hairline: "#26262B",
  gold: "#D4AF37",
  goldSoft: "#E6C964",
  goldMuted: "#B8962F",
  goldDeep: "#8C6E1B",
  textPrimary: "#F5F5F4",
  textMuted: "#A1A1AA",
} as const;

const GOLD_GRADIENT = [COLORS.goldSoft, COLORS.gold, COLORS.goldMuted] as const;

export default function ModePicker() {
  // Three render states: still reading storage (Loading), redirect a returning
  // user (declarative <Redirect>), or show the picker. The effect only flips
  // state - it never navigates imperatively, so there is no on-mount launch-hang.
  const [redirectTo, setRedirectTo] = useState<"/login" | "/customer" | null>(
    null,
  );
  const [checking, setChecking] = useState(true);
  // Guards against a fast double-tap firing two writes + two navigations.
  const choosing = useRef(false);

  // Hooks must run unconditionally (rules of hooks), so this is declared before
  // any early return.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE.mode);
        if (!active) return;
        // Returning user: resolve to their destination and let the render path
        // below hand off to <Redirect>, so the picker never flashes.
        if (isMode(saved)) setRedirectTo(DESTINATION[saved]);
        else setChecking(false);
      } catch {
        // Storage failed - SHOW the picker rather than hang on a spinner.
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function choose(mode: Mode) {
    if (choosing.current) return; // ignore a double tap
    choosing.current = true;
    // Persisting the choice is best-effort; still route the user this session.
    AsyncStorage.setItem(STORAGE.mode, mode).catch(() => {});
    router.replace(DESTINATION[mode]);
  }

  if (redirectTo) return <Redirect href={redirectTo} />;
  if (checking) {
    // A quiet, on-brand hold (no jarring spinner) while we read the saved mode.
    return <Loading />;
  }
  return <Picker onChoose={choose} />;
}

/* ------------------------------------------------------------------ */
/* Loading hold                                                        */
/* ------------------------------------------------------------------ */

function Loading() {
  // A slow gold pulse on a single dot - calmer than a spinner, on-brand.
  const pulse = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.root}>
      <Ambient />
      <SafeAreaView style={[styles.safe, styles.center]}>
        <Animated.View style={[styles.loadingDot, { opacity: pulse }]} />
      </SafeAreaView>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Picker                                                              */
/* ------------------------------------------------------------------ */

type Role = {
  mode: Mode;
  title: string;
  sub: string;
  label: string;
  hint: string;
  Icon: (props: { size: number; color: string }) => JSX.Element;
};

const ROLES: Role[] = [
  {
    mode: "barber",
    title: "I own a barbershop",
    sub: "Your chair, your clients, your dashboard.",
    label: "Continue as a barbershop owner",
    hint: "Opens the barbershop dashboard.",
    Icon: ScissorsIcon,
  },
  {
    mode: "manager",
    title: "I manage multiple shops",
    sub: "Oversee every location in one place.",
    label: "Continue as a multi-shop manager",
    hint: "Opens the multi-shop dashboard.",
    Icon: ShopsIcon,
  },
  {
    mode: "customer",
    title: "I'm a customer",
    sub: "Track your punches, rewards & visits.",
    label: "Continue as a customer",
    hint: "Opens your rewards and visits.",
    Icon: CustomerIcon,
  },
];

function Picker({ onChoose }: { onChoose: (mode: Mode) => void }) {
  const { width } = useWindowDimensions();
  const contentWidth = Math.min(width - 40, 440);

  // Spotlight Hero entrance: the emblem leads (index 0), the wordmark block
  // follows (index 1), then each row cascades (indices 2..n). One driver per
  // block keeps it declarative and cheap. The emblem additionally SCALES in.
  const drivers = useMemo(
    () => Array.from({ length: ROLES.length + 2 }, () => new Animated.Value(0)),
    [],
  );

  useEffect(() => {
    const animations = drivers.map((d, i) =>
      Animated.spring(d, {
        toValue: 1,
        delay: 80 + i * 95,
        // Low-stiffness, well-damped spring -> subtle, tasteful settle.
        stiffness: 90,
        damping: 17,
        mass: 0.9,
        useNativeDriver: true,
      }),
    );
    Animated.parallel(animations).start();
  }, [drivers]);

  // Fade + small upward translate; the emblem also scales 0.9 -> 1.
  const fadeUp = (i: number, lift = 10) => ({
    opacity: drivers[i],
    transform: [
      {
        translateY: drivers[i].interpolate({
          inputRange: [0, 1],
          outputRange: [lift, 0],
        }),
      },
    ],
  });

  const emblemEntrance = {
    opacity: drivers[0],
    transform: [
      {
        scale: drivers[0].interpolate({
          inputRange: [0, 1],
          outputRange: [0.9, 1],
        }),
      },
      {
        translateY: drivers[0].interpolate({
          inputRange: [0, 1],
          outputRange: [8, 0],
        }),
      },
    ],
  };

  return (
    <View style={styles.root}>
      <Ambient />
      <SafeAreaView style={styles.safe}>
        <View style={[styles.content, { width: contentWidth }]}>
          {/* --- Spotlight hero: emblem in a soft radial gold glow --- */}
          <View style={styles.hero}>
            <Animated.View style={[styles.emblemWrap, emblemEntrance]}>
              {/* Large soft radial gold glow behind the emblem (the spotlight). */}
              <View style={styles.spotlight} pointerEvents="none">
                <SoftGlow size={300} opacity={0.5} />
              </View>
              <EmblemDisc />
            </Animated.View>

            <Animated.View style={[styles.wordmarkBlock, fadeUp(1)]}>
              <Text style={styles.eyebrow}>WELCOME TO</Text>
              <Text
                style={styles.wordmark}
                accessibilityRole="header"
                allowFontScaling={false}
              >
                ChairBack
              </Text>
              <LinearGradient
                colors={GOLD_GRADIENT}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.wordmarkUnderline}
              />
              <Text style={styles.tagline}>
                One app for the chair, the chain, and the client.
              </Text>
            </Animated.View>
          </View>

          {/* --- Sleek minimal selection: full-width pill rows --- */}
          <View style={styles.choices}>
            {ROLES.map((role, idx) => (
              <Animated.View key={role.mode} style={fadeUp(idx + 2)}>
                <RoleRow role={role} onPress={() => onChoose(role.mode)} />
              </Animated.View>
            ))}
          </View>

          <Text style={styles.footnote}>You can switch anytime.</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Emblem - a gold-gradient scissor mark on a glassy disc              */
/* ------------------------------------------------------------------ */

function EmblemDisc() {
  return (
    <View style={styles.emblemDisc}>
      {/* Faint top sheen to fake a glass surface. */}
      <View style={styles.emblemSheen} pointerEvents="none" />
      <Svg width={56} height={56} viewBox="0 0 24 24">
        <Defs>
          <SvgLinearGradient id="emblemGold" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={COLORS.goldSoft} />
            <Stop offset="0.55" stopColor={COLORS.gold} />
            <Stop offset="1" stopColor={COLORS.goldMuted} />
          </SvgLinearGradient>
        </Defs>
        <Circle cx={6} cy={6} r={3} stroke="url(#emblemGold)" {...ICON} />
        <Circle cx={6} cy={18} r={3} stroke="url(#emblemGold)" {...ICON} />
        <Path d="M8.12 8.12 20 20" stroke="url(#emblemGold)" {...ICON} />
        <Path d="M14.8 14.8 20 4" stroke="url(#emblemGold)" {...ICON} />
        <Path d="M8.12 15.88 12 12" stroke="url(#emblemGold)" {...ICON} />
      </Svg>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Role row - full-width pill, lights up gold on press                 */
/* ------------------------------------------------------------------ */

function RoleRow({ role, onPress }: { role: Role; onPress: () => void }) {
  const { Icon } = role;
  // Press feedback: subtle scale + a gold wash that fades in.
  const scale = useRef(new Animated.Value(1)).current;
  const glow = useRef(new Animated.Value(0)).current;

  const animateTo = (toScale: number, toGlow: number) => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: toScale,
        stiffness: 220,
        damping: 22,
        mass: 0.6,
        useNativeDriver: true,
      }),
      Animated.timing(glow, {
        toValue: toGlow,
        duration: 160,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={role.label}
      accessibilityHint={role.hint}
      onPress={onPress}
      onPressIn={() => animateTo(0.98, 1)}
      onPressOut={() => animateTo(1, 0)}
      style={styles.rowPressable}
    >
      <Animated.View style={[styles.row, { transform: [{ scale }] }]}>
        {/* Top sheen on the pill to fake a glass surface. */}
        <View style={styles.rowSheen} pointerEvents="none" />

        {/* Gold wash that fades in on press - "lights up gold". */}
        <Animated.View style={[styles.rowGlow, { opacity: glow }]} pointerEvents="none">
          <LinearGradient
            colors={
              ["rgba(212,175,55,0.16)", "rgba(212,175,55,0.04)", "transparent"] as const
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>

        {/* Leading icon in a quiet glass chip. */}
        <View style={styles.iconChip}>
          <View style={styles.iconChipSheen} pointerEvents="none" />
          <Icon size={22} color={COLORS.goldSoft} />
        </View>

        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{role.title}</Text>
          <Text style={styles.rowSub}>{role.sub}</Text>
        </View>

        <ChevronIcon size={18} color={COLORS.textMuted} />
      </Animated.View>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Ambient backdrop - two opposing soft gold glows + faint vignette    */
/* ------------------------------------------------------------------ */

function Ambient() {
  const { width, height } = useWindowDimensions();
  const blob = Math.max(width, height) * 0.95;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Top-right warm glow. */}
      <View style={[styles.ambientBlob, { top: -blob * 0.42, right: -blob * 0.34 }]}>
        <SoftGlow size={blob} opacity={0.42} />
      </View>
      {/* Bottom-left warm glow (dimmer, for balance). */}
      <View style={[styles.ambientBlob, { bottom: -blob * 0.48, left: -blob * 0.36 }]}>
        <SoftGlow size={blob} opacity={0.34} />
      </View>
      {/* Faint vignette to settle the edges. */}
      <LinearGradient
        colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.45)"] as const}
        start={{ x: 0.5, y: 0.25 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

/**
 * A true soft radial gold glow via react-native-svg's RadialGradient (a real
 * falloff, vs a linear blob). Used both for the ambient corners and the hero
 * spotlight behind the emblem.
 */
function SoftGlow({ size, opacity }: { size: number; opacity: number }) {
  // Unique per instance: react-native-svg resolves url(#id) within each <Svg>'s
  // own defs scope, but a shared id is a latent footgun if instances ever share
  // a single <Svg>. useId() keeps each gradient distinct (colons stripped - not
  // valid in an SVG id reference).
  const id = `glow${useId().replace(/:/g, "")}`;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={COLORS.gold} stopOpacity={opacity} />
          <Stop offset="0.55" stopColor={COLORS.gold} stopOpacity={opacity * 0.35} />
          <Stop offset="1" stopColor={COLORS.gold} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
    </Svg>
  );
}

/* ------------------------------------------------------------------ */
/* House-style line icons (Lucide-like; 24-box, stroke=accent, ~1.6)   */
/* ------------------------------------------------------------------ */

const ICON = {
  strokeWidth: 1.6,
  fill: "none",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function ScissorsIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={6} cy={6} r={3} stroke={color} {...ICON} />
      <Circle cx={6} cy={18} r={3} stroke={color} {...ICON} />
      <Path d="M8.12 8.12 20 20" stroke={color} {...ICON} />
      <Path d="M14.8 14.8 20 4" stroke={color} {...ICON} />
      <Path d="M8.12 15.88 12 12" stroke={color} {...ICON} />
    </Svg>
  );
}

function ShopsIcon({ size, color }: { size: number; color: string }) {
  // A multi-store mark: awning roofline over a storefront with a door.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M4 7.5 5 4h14l1 3.5" stroke={color} {...ICON} />
      <Path
        d="M4 7.5a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0"
        stroke={color}
        {...ICON}
      />
      <Path d="M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" stroke={color} {...ICON} />
      <Path d="M10 20v-5h4v5" stroke={color} {...ICON} />
    </Svg>
  );
}

function CustomerIcon({ size, color }: { size: number; color: string }) {
  // A person inside a loyalty-card frame: customer + rewards.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={2.5} y={5} width={19} height={14} rx={2.5} stroke={color} {...ICON} />
      <Circle cx={9} cy={11} r={2} stroke={color} {...ICON} />
      <Path d="M5.5 16c.5-1.7 2-2.6 3.5-2.6S12 14.3 12.5 16" stroke={color} {...ICON} />
      <Path d="M15 10h4M15 13h2.5" stroke={color} {...ICON} />
    </Svg>
  );
}

function ChevronIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M9 6l6 6-6 6" stroke={color} {...ICON} />
    </Svg>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  safe: { flex: 1, alignItems: "center", justifyContent: "center" },
  center: { alignItems: "center", justifyContent: "center" },
  loadingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.gold,
    shadowColor: COLORS.gold,
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
  },

  content: { paddingHorizontal: 4 },

  // Hero / spotlight
  hero: { alignItems: "center", marginBottom: 34 },
  emblemWrap: {
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 22,
  },
  spotlight: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  emblemDisc: {
    width: 108,
    height: 108,
    borderRadius: 54,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    overflow: "hidden",
    // Faked gold glow (mirrors the web's box glow).
    shadowColor: COLORS.gold,
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  emblemSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(245,245,244,0.16)",
  },

  wordmarkBlock: { alignItems: "center" },
  eyebrow: {
    color: COLORS.textMuted,
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: "600",
    marginBottom: 8,
  },
  wordmark: {
    color: COLORS.goldSoft,
    // The real brand display face (matches the web --font-display). The font
    // file IS the bold weight, so we do NOT also set fontWeight (that can force
    // faux-bold / a system fallback on Android). If the font fails to load,
    // _layout still reveals the app and this falls back to the system face.
    fontFamily: "BricolageGrotesque_700Bold",
    fontSize: 46,
    letterSpacing: 0.5,
    textShadowColor: "rgba(212,175,55,0.35)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  wordmarkUnderline: {
    height: 2,
    width: 96,
    borderRadius: 2,
    marginTop: 10,
    opacity: 0.9,
  },
  tagline: {
    color: COLORS.textMuted,
    fontSize: 14,
    marginTop: 16,
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 300,
  },

  // Choices
  choices: { width: "100%", gap: 12 },

  rowPressable: { borderRadius: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
    // Quiet elevation so the glass pills lift off the ambient bg.
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
  rowSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(245,245,244,0.10)",
  },
  rowGlow: { ...StyleSheet.absoluteFillObject, borderRadius: 18 },

  iconChip: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surfaceHi,
    borderWidth: 1,
    borderColor: "rgba(212,175,55,0.22)",
    overflow: "hidden",
  },
  iconChipSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(245,245,244,0.14)",
  },

  rowText: { flex: 1, marginLeft: 14, marginRight: 8 },
  rowTitle: {
    color: COLORS.textPrimary,
    fontSize: 16.5,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  rowSub: { color: COLORS.textMuted, fontSize: 12.5, marginTop: 3, lineHeight: 17 },

  footnote: {
    color: COLORS.textMuted,
    opacity: 0.6,
    fontSize: 11,
    letterSpacing: 1.5,
    textAlign: "center",
    marginTop: 26,
    textTransform: "uppercase",
  },

  // Ambient
  ambientBlob: { position: "absolute" },
});
