import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { initials } from "./format";
import { Check, Person } from "./icons";
import { color, radius, space } from "./theme";
import { tierProgressLine, type BestTier } from "./tierStatus";
import type { RewardProgram } from "./types";
import { Avatar, ProgressBar, Tap, Txt } from "./ui";

/**
 * The customer's status: who they are, the tier they wear, and what the next
 * one takes at each shop.
 *
 * 🔴 THE RING IS DECORATION, THE WORD IS THE FACT. The avatar's ring takes the
 * tier's colour, and the tier is always also written out beside it - colour
 * alone never carries status in this app (theme.ts).
 */

const AVATAR = 88;
const RING = 3;
const GAP = 3;

export function ProfileHero({ name, best, line }: { name: string | null; best: BestTier | null; line: string }) {
  const outer = AVATAR + 2 * (RING + GAP);
  return (
    <View
      style={styles.hero}
      accessible
      accessibilityLabel={[name ?? "Your profile", best ? `${best.label} member` : null, line].filter(Boolean).join(". ")}
    >
      <View
        style={[
          styles.ring,
          {
            width: outer,
            height: outer,
            borderRadius: outer / 2,
            borderColor: best?.color ?? color.hairlineStrong,
            borderWidth: best ? RING : StyleSheet.hairlineWidth,
          },
        ]}
      >
        <View style={styles.disc}>
          {name ? (
            <Text allowFontScaling={false} style={styles.initials}>
              {initials(name)}
            </Text>
          ) : (
            <Person size={34} color={color.textSecondary} />
          )}
        </View>
      </View>
      {best ? (
        <View style={[styles.badge, { borderColor: best.color }]}>
          <View style={[styles.dot, { backgroundColor: best.color }]} />
          <Txt variant="captionStrong">{best.label.toUpperCase()}</Txt>
        </View>
      ) : null}
      <Txt variant="title2" style={styles.name} numberOfLines={2}>
        {name ?? "Your profile"}
      </Txt>
      <Txt variant="subhead" tone="secondary" style={styles.line}>
        {line}
      </Txt>
    </View>
  );
}

/**
 * One shop's tier: the word, a bar toward the next one, what is left in the
 * shop's own terms, and - one tap away - the whole ladder there.
 */
export function TierStatusCard({ program, onOpen }: { program: RewardProgram; onOpen: () => void }) {
  const [ladderOpen, setLadderOpen] = useState(false);
  const tier = program.tier;
  const line = tierProgressLine(program);
  const requirements = tier.next?.requirements ?? [];
  const ladder = tier.ladder ?? [];
  const nextPerk = tier.next?.perk;

  return (
    <View style={styles.card}>
      <Tap
        onPress={onOpen}
        accessibilityLabel={[program.shop.name, tier.label ? `${tier.label} member` : "No tier yet", line].filter(Boolean).join(". ")}
        accessibilityHint="Opens your rewards"
        style={styles.cardTap}
      >
        <View style={styles.head}>
          <Avatar uri={program.shop.logoUrl} name={program.shop.name} size={36} />
          <Txt variant="headline" style={styles.flex} numberOfLines={1}>
            {program.shop.name}
          </Txt>
          <View style={styles.tierWord}>
            {tier.label ? <View style={[styles.dot, { backgroundColor: tier.color ?? color.gold }]} /> : null}
            <Txt variant="footnoteStrong" tone={tier.label ? "primary" : "secondary"}>
              {tier.label ?? "No tier yet"}
            </Txt>
          </View>
        </View>

        {tier.next && tier.fraction !== undefined ? (
          <ProgressBar fraction={tier.fraction} label={line ?? `Progress to ${tier.next.label}`} />
        ) : null}
        {line ? (
          <Txt variant="subhead" tone="secondary">
            {line}
          </Txt>
        ) : null}

        {/* With more than one requirement, each one's standing - so "all" is
            visibly two things, and a finished one reads as done. */}
        {requirements.length > 1 ? (
          <View style={styles.reqs}>
            {requirements.map((r) => (
              <View
                key={r.kind}
                style={styles.req}
                accessible
                accessibilityLabel={`${r.met ? "Done" : "To go"}: ${r.text}`}
              >
                {r.met ? <Check size={14} color={color.goldText} /> : <View style={styles.open} />}
                <Txt variant="footnote" tone={r.met ? "secondary" : "primary"} style={styles.flex}>
                  {r.text}
                </Txt>
              </View>
            ))}
            {tier.next?.match === "any" ? (
              <Txt variant="caption" tone="tertiary">
                Either one gets you there.
              </Txt>
            ) : null}
          </View>
        ) : null}

        {nextPerk ? (
          <Txt variant="footnote" tone="secondary">
            {`${tier.next!.label} gets: ${nextPerk}`}
          </Txt>
        ) : tier.perk ? (
          <Txt variant="footnote" tone="secondary">
            {`Your perk: ${tier.perk}`}
          </Txt>
        ) : null}
      </Tap>

      {ladder.length > 0 ? (
        <>
          <Tap
            onPress={() => setLadderOpen((open) => !open)}
            accessibilityLabel={`How tiers work at ${program.shop.name}`}
            accessibilityHint={ladderOpen ? "Hides the tiers" : "Shows what each tier takes"}
            style={styles.ladderToggle}
          >
            <Txt variant="footnote" tone="gold">
              {ladderOpen ? "Hide tiers" : "How tiers work here"}
            </Txt>
          </Tap>
          {ladderOpen ? (
            <View style={styles.ladder}>
              {ladder.map((rung) => {
                const held = rung.tier === tier.key;
                return (
                  <View
                    key={rung.tier}
                    style={styles.rung}
                    accessible
                    accessibilityLabel={`${rung.label}${held ? ", your tier" : ""}: ${rung.takes}${rung.perk ? `. Gets ${rung.perk}` : ""}`}
                  >
                    <View style={[styles.dot, styles.rungDot, { backgroundColor: rung.color }]} />
                    <View style={styles.flex}>
                      <Txt variant={held ? "footnoteStrong" : "footnote"}>
                        {held ? `${rung.label} · you're here` : rung.label}
                      </Txt>
                      <Txt variant="footnote" tone="secondary">
                        {rung.takes}
                      </Txt>
                      {rung.perk ? (
                        <Txt variant="caption" tone="tertiary">
                          {rung.perk}
                        </Txt>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  hero: { alignItems: "center", paddingTop: space.s2, paddingBottom: space.s3 },
  ring: { alignItems: "center", justifyContent: "center" },
  disc: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { color: color.text, fontSize: 32, fontWeight: "600", letterSpacing: 0.5 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: -12,
    paddingHorizontal: space.s1 + 2,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: color.bg,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  name: { marginTop: space.s2 - 4, textAlign: "center" },
  line: { marginTop: 2, textAlign: "center", maxWidth: 320 },

  card: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    marginBottom: space.s2 - 4,
    overflow: "hidden",
  },
  cardTap: { padding: space.s2, gap: space.s1 + 2 },
  head: { flexDirection: "row", alignItems: "center", gap: space.s2 - 4 },
  tierWord: { flexDirection: "row", alignItems: "center", gap: 6 },
  reqs: { gap: 6 },
  req: { flexDirection: "row", alignItems: "center", gap: space.s1 },
  open: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: color.textTertiary, marginHorizontal: 1 },
  ladderToggle: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.s2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  ladder: { paddingHorizontal: space.s2, paddingBottom: space.s2, gap: space.s2 - 4 },
  rung: { flexDirection: "row", gap: space.s1 + 2 },
  rungDot: { marginTop: 6 },
});
