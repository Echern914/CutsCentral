import { LocalDate } from "@/components/ui/LocalDate";
import { surfaceStyle, type RewardsTheme } from "@/app/r/[magicToken]/theme";

/**
 * Rewards the client has redeemed. Rendered only when there's at least one (the
 * parent hides the whole section otherwise), so there's no empty state here.
 * Theme-driven so it matches the barber's identity.
 */
export function RewardsClaimed({
  redemptions,
  theme,
}: {
  redemptions: { date: string; reward: string | null; punches: number }[];
  theme: RewardsTheme;
}) {
  return (
    <div className="overflow-hidden" style={surfaceStyle(theme)}>
      {redemptions.map((r, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-3 px-5 py-3.5"
          style={i > 0 ? { borderTop: `1px solid ${theme.border}` } : undefined}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden style={{ color: theme.accent }}>
              🎉
            </span>
            <span className="truncate text-sm">{r.reward ?? "Reward"}</span>
          </div>
          <LocalDate
            iso={r.date}
            options={{ month: "short", day: "numeric", year: "numeric" }}
            className="shrink-0 text-xs"
            style={{ color: theme.muted }}
          />
        </div>
      ))}
    </div>
  );
}
