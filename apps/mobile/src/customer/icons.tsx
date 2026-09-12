import Svg, { Circle, Path, Rect } from "react-native-svg";

/**
 * Line icons in the app's house style (24-box, round caps, ~1.7 stroke) - the
 * same hand the role picker's icons are drawn in. Decorative by default:
 * every icon sits beside a word that says the same thing, so VoiceOver reads
 * the word and skips the drawing.
 */

type IconProps = { size?: number; color: string };

const STROKE = { strokeWidth: 1.7, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Frame({ size = 20, children }: { size?: number; children: React.ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {children}
    </Svg>
  );
}

export function ChevronRight({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Path d="M9 6l6 6-6 6" stroke={color} {...STROKE} />
    </Frame>
  );
}

export function MapPin({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" stroke={color} {...STROKE} />
      <Circle cx={12} cy={10} r={2.3} stroke={color} {...STROKE} />
    </Frame>
  );
}

export function Reschedule({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Rect x={3.5} y={5} width={17} height={15} rx={2.5} stroke={color} {...STROKE} />
      <Path d="M3.5 9.5h17M8 3v4M16 3v4" stroke={color} {...STROKE} />
      <Path d="M9.5 14.5h5m0 0-1.8-1.8m1.8 1.8-1.8 1.8" stroke={color} {...STROKE} />
    </Frame>
  );
}

export function Cancel({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Circle cx={12} cy={12} r={8.5} stroke={color} {...STROKE} />
      <Path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" stroke={color} {...STROKE} />
    </Frame>
  );
}

export function Details({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Rect x={4.5} y={3.5} width={15} height={17} rx={2.5} stroke={color} {...STROKE} />
      <Path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke={color} {...STROKE} />
    </Frame>
  );
}

export function Store({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Path d="M4 8.5 5 4h14l1 4.5" stroke={color} {...STROKE} />
      <Path d="M4 8.5a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0" stroke={color} {...STROKE} />
      <Path d="M5 11.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7.5M10 20v-5h4v5" stroke={color} {...STROKE} />
    </Frame>
  );
}

export function Check({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Path d="M5 12.5l4.2 4.2L19 7" stroke={color} {...STROKE} />
    </Frame>
  );
}

export function Person({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Circle cx={12} cy={8.5} r={3.6} stroke={color} {...STROKE} />
      <Path d="M5 19.5c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5" stroke={color} {...STROKE} />
    </Frame>
  );
}

export function Offline({ size, color }: IconProps) {
  return (
    <Frame size={size}>
      <Path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14.5 10.4A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.3-2.6M12 6a15 15 0 0 1 10 3.5" stroke={color} {...STROKE} />
      <Circle cx={12} cy={19.5} r={0.8} stroke={color} {...STROKE} />
    </Frame>
  );
}
