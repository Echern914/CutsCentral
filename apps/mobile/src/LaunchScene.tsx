import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, {
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { launchSceneTiming, shouldPlayLaunchScene } from "./launchSceneRules";

/**
 * The opening: a short cut from the static splash into the app.
 *
 * ── The rule this is built around ───────────────────────────────────────────
 *
 * 🔴 IT MAY NEVER MAKE THE APP SLOWER TO USE. A barber opening this between
 * clients to see who is next does not want a film. So:
 *
 *  - FRAME ONE IS THE SPLASH. The native splash (assets/splash.png) is the
 *    chair-back mark centred on charcoal with a soft gold glow; this overlay's
 *    first frame draws exactly that, at the same size, so the handoff from the
 *    static image to this component is invisible. A mismatch here reads as a
 *    pop, and a pop reads as a bug.
 *  - IT PLAYS OVER TIME THAT WAS ALREADY BEING SPENT. Behind it the dashboard
 *    WebView is loading; that used to be a bare spinner on black. The scene is
 *    hard-capped at ~1.1s and then leaves whether or not the page is ready -
 *    the WebView's own loading state takes over underneath. Nothing waits on
 *    the scene, so on a cold start it costs nothing; a warm one never sees it.
 *  - COLD START ONLY. A module-level flag (see ./launchSceneRules.ts) means it plays
 *    once per process: foregrounding the app never replays it.
 *  - IT IS UNTOUCHABLE. `pointerEvents="none"`, so even if a tap lands during
 *    the last frames it reaches whatever is underneath.
 *  - REDUCE MOTION IS HONOURED. With the system setting on, the sweep is
 *    skipped and the overlay simply cross-fades out.
 *
 * ── What it does, in three beats (~1,150 ms) ────────────────────────────────
 *
 *  1. A blade of light sweeps left-to-right across the mark - the clipper
 *     catching the light. It is a narrow gold gradient bar, masked to the mark
 *     by being drawn in the same gold and clipped to the SVG viewport.
 *  2. The mark lifts by a few points and the wordmark fades up beneath it in
 *     the brand face, with the same gold underline the role picker uses.
 *  3. The whole overlay fades out over the app.
 *
 * No new native dependency: react-native-svg and RN's Animated, both already
 * in the binary. (Lottie would mean a fresh CocoaPod in the same week the
 * build system changes - the wrong week for it.)
 */

const BG = "#0A0A0B";
const GOLD = "#D4AF37";
const GOLD_SOFT = "#F4D67A";
const GOLD_DEEP = "#A6841F";

/** The mark's own coordinate space - identical to assets/icon.svg. */
const VIEWBOX = 1024;

const AnimatedRect = Animated.createAnimatedComponent(Rect);

export function LaunchScene({ onDone }: { onDone: () => void }) {
  const [visible, setVisible] = useState(() => shouldPlayLaunchScene());
  const { width } = useWindowDimensions();

  // The splash shows the 1024-box mark at 40% of the screen's width (Expo's
  // "contain" on a 1284px square canvas). Match it, so frame one lines up.
  const markSize = Math.round(width * 0.4);

  const sweep = useRef(new Animated.Value(0)).current; // 0 -> 1, left to right
  const lift = useRef(new Animated.Value(0)).current; // 0 -> 1, mark rises
  const word = useRef(new Animated.Value(0)).current; // 0 -> 1, wordmark in
  const fade = useRef(new Animated.Value(1)).current; // 1 -> 0, overlay out

  useEffect(() => {
    if (!visible) {
      onDone();
      return;
    }
    let cancelled = false;
    (async () => {
      let reduceMotion = false;
      try {
        reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
      } catch {
        /* treat as off */
      }
      if (cancelled) return;
      const t = launchSceneTiming(reduceMotion);

      const outro = Animated.timing(fade, {
        toValue: 0,
        duration: t.fadeOutMs,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      });

      const seq = reduceMotion
        ? Animated.sequence([Animated.delay(t.holdMs), outro])
        : Animated.sequence([
            Animated.delay(t.holdMs),
            // Beat 1: the blade of light. Native driver can't animate SVG
            // props, so this one runs on the JS thread - a single 1D value
            // over half a second, which is nothing.
            Animated.timing(sweep, {
              toValue: 1,
              duration: t.sweepMs,
              easing: Easing.inOut(Easing.cubic),
              useNativeDriver: false,
            }),
            // Beat 2: lift and the wordmark, together.
            Animated.parallel([
              Animated.timing(lift, {
                toValue: 1,
                duration: t.liftMs,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
              }),
              Animated.timing(word, {
                toValue: 1,
                duration: t.liftMs,
                delay: 60,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
              }),
            ]),
            Animated.delay(t.settleMs),
            // Beat 3: out.
            outro,
          ]);

      seq.start(({ finished }) => {
        if (cancelled) return;
        // Whether it finished or was interrupted, the overlay is done. The
        // hard cap is the sum of the timings above; nothing here can extend it.
        void finished;
        setVisible(false);
        onDone();
      });
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount by design; the drivers are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  // The sweep travels across the mark's box plus its own width on each side,
  // so it enters from fully off the left edge and leaves fully off the right.
  const bladeWidth = VIEWBOX * 0.22;
  const bladeX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-bladeWidth, VIEWBOX],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.root, { opacity: fade }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          styles.center,
          {
            transform: [
              {
                translateY: lift.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, -Math.round(markSize * 0.18)],
                }),
              },
            ],
          },
        ]}
      >
        <Svg width={markSize} height={markSize} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
          <Defs>
            {/* The same gold and glow as icon.svg / splash.png. */}
            <LinearGradient id="ls-gold" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={GOLD_SOFT} />
              <Stop offset="0.5" stopColor={GOLD} />
              <Stop offset="1" stopColor={GOLD_DEEP} />
            </LinearGradient>
            <RadialGradient id="ls-glow" cx="50%" cy="42%" r="55%">
              <Stop offset="0" stopColor={GOLD} stopOpacity={0.25} />
              <Stop offset="1" stopColor={GOLD} stopOpacity={0} />
            </RadialGradient>
            {/* The blade: transparent - bright - transparent, narrow. */}
            <LinearGradient id="ls-blade" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
              <Stop offset="0.5" stopColor="#FFF4C2" stopOpacity={0.55} />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
            </LinearGradient>
          </Defs>

          <Rect width={VIEWBOX} height={VIEWBOX} fill="url(#ls-glow)" />

          {/* The chair-back mark, geometry lifted verbatim from icon.svg so it
              is the same shape the splash showed a frame ago. */}
          <Rect
            x={372}
            y={250}
            width={280}
            height={320}
            rx={70}
            fill="none"
            stroke="url(#ls-gold)"
            strokeWidth={44}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Rect x={452} y={186} width={120} height={60} rx={30} fill="url(#ls-gold)" />
          <Path
            d="M328 612 H696 a36 36 0 0 1 36 36 v40 a36 36 0 0 1 -36 36 H328 a36 36 0 0 1 -36 -36 v-40 a36 36 0 0 1 36 -36 Z"
            fill="url(#ls-gold)"
          />
          <Rect x={486} y={724} width={52} height={92} rx={14} fill="url(#ls-gold)" />
          <Path
            d="M388 838 H636"
            stroke="url(#ls-gold)"
            strokeWidth={46}
            strokeLinecap="round"
          />

          {/* Beat 1. Drawn last so it passes OVER the gold; it is clipped by
              the SVG viewport, which is why it never shows outside the mark's
              box, and its soft edges keep it reading as light rather than a
              bar. */}
          <AnimatedRect
            x={bladeX}
            y={0}
            width={bladeWidth}
            height={VIEWBOX}
            fill="url(#ls-blade)"
          />
        </Svg>

        <Animated.View
          style={[
            styles.wordBlock,
            {
              opacity: word,
              transform: [
                {
                  translateY: word.interpolate({
                    inputRange: [0, 1],
                    outputRange: [10, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <Text style={styles.wordmark} allowFontScaling={false}>
            ChairBack
          </Text>
          <View style={styles.underline} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BG,
    zIndex: 10,
    elevation: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { alignItems: "center", justifyContent: "center" },
  wordBlock: { alignItems: "center", marginTop: 6 },
  wordmark: {
    color: GOLD_SOFT,
    // The brand display face, already loaded by the root layout. If it failed
    // to load the layout revealed the app anyway and this falls back to the
    // system face - a slightly plainer word, not a broken launch.
    fontFamily: "BricolageGrotesque_700Bold",
    fontSize: 34,
    letterSpacing: 0.5,
    textShadowColor: "rgba(212,175,55,0.35)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  underline: {
    height: 2,
    width: 72,
    borderRadius: 2,
    marginTop: 8,
    backgroundColor: GOLD,
    opacity: 0.9,
  },
});
