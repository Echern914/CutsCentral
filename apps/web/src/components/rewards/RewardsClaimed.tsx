import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";

/**
 * Rewards the client has redeemed. Rendered only when there's at least one (the
 * parent hides the whole section otherwise), so there's no empty state here.
 */
export function RewardsClaimed({
  redemptions,
  accent,
}: {
  redemptions: { date: string; reward: string | null; punches: number }[];
  accent: string;
}) {
  return (
    <Card className="divide-y divide-subtle">
      {redemptions.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden style={{ color: accent }}>
              🎉
            </span>
            <span className="truncate text-sm text-offwhite">
              {r.reward ?? "Reward"}
            </span>
          </div>
          <LocalDate
            iso={r.date}
            options={{ month: "short", day: "numeric", year: "numeric" }}
            className="shrink-0 text-xs text-muted"
          />
        </div>
      ))}
    </Card>
  );
}
