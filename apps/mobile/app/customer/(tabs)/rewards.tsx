import { useResource } from "@/src/customer/CustomerProvider";
import { Screen } from "@/src/customer/Screen";
import { errorCopy } from "@/src/customer/api";
import { RewardProgramCard } from "@/src/customer/sections";
import type { RewardProgram } from "@/src/customer/types";
import { EmptyState, ErrorState, Placeholder, StaleBanner, Txt } from "@/src/customer/ui";
import { space } from "@/src/customer/theme";

/**
 * Rewards, one shop at a time. Each program is that shop's own - its card,
 * its menu, its tier - and balances are never added across shops. A shop that
 * doesn't offer rewards simply isn't here; there is no zero-value card.
 */
export default function RewardsScreen() {
  const rewards = useResource<{ programs: RewardProgram[] }>("/api/me/rewards");
  const programs = rewards.data?.programs;

  return (
    <Screen title="Rewards" refreshing={rewards.refreshing} onRefresh={rewards.refresh}>
      {rewards.stale ? <StaleBanner onRetry={rewards.refresh} /> : null}
      {!programs && rewards.loading ? (
        <Placeholder height={260} />
      ) : !programs ? (
        <ErrorState {...errorCopy(rewards.error)} onRetry={rewards.refresh} />
      ) : programs.length === 0 ? (
        <EmptyState
          title="No rewards yet"
          body="When a shop you visit runs a rewards program, your progress shows up here."
        />
      ) : (
        <>
          <Txt variant="subhead" tone="secondary" style={{ marginBottom: space.s2 }}>
            Each shop runs its own rewards. Ask for a ready reward at your next visit.
          </Txt>
          {programs.map((p) => (
            <RewardProgramCard key={p.shop.key} program={p} />
          ))}
        </>
      )}
    </Screen>
  );
}
