import { ladderStates, type LadderState } from "@chairback/config/tierRules";
import type { RewardsData } from "./rewards/page";
import { surfaceStyle, type RewardsTheme } from "./theme";

/**
 * "YOUR STATUS": the whole tier ladder at this shop, so a client can see not
 * just their badge but every tier - what each one takes, what each one gets
 * them, which one they hold, and which is next. The header above keeps the
 * badge and the bar; this is the "how it works here" under it.
 *
 * Every figure is the shop's own (loyaltyView's `ladder`, built from the rules
 * and perks the shop wrote in its rewards settings). Nothing here is computed
 * from money or visits on the client - `takes` is the rule in words, and
 * `ladderStates` only compares the held tier with the ladder's order.
 *
 * Renders nothing for an API that predates the ladder, and nothing with
 * rewards off (the API sends an empty ladder then).
 */
export function YourStatus({ loyalty, theme: t }: { loyalty: RewardsData["loyalty"]; theme: RewardsTheme }) {
  const ladder = loyalty.ladder ?? [];
  if (ladder.length === 0) return null;
  const rows = ladderStates(ladder, loyalty.tier);
  const next = loyalty.nextTier;
  const requirements = next?.requirements ?? [];

  return (
    <div className="flex flex-col gap-4 p-4" style={surfaceStyle(t)} data-qa="your-status">
      {/* With more than one requirement, each one's standing - so "all" is
          visibly two things, and a finished one reads as done. One
          requirement is already the line under the bar above. */}
      {next && requirements.length > 1 && (
        <div className="flex flex-col gap-1.5" data-qa="your-status-requirements">
          <p className="text-xs font-medium" style={{ color: t.muted }}>
            To reach {next.label}
          </p>
          <ul className="flex flex-col gap-1">
            {requirements.map((r) => (
              <li key={r.kind} className="flex items-center gap-2 text-sm" style={{ color: r.met ? t.muted : t.text }}>
                <span aria-hidden className="w-4 text-center" style={{ color: r.met ? loyalty.color ?? t.accent : t.muted }}>
                  {r.met ? "✓" : "○"}
                </span>
                <span>
                  <span className="sr-only">{r.met ? "Done: " : "To go: "}</span>
                  {r.text}
                </span>
              </li>
            ))}
          </ul>
          {next.match === "any" && (
            <p className="text-xs" style={{ color: t.muted }}>
              Either one gets you there.
            </p>
          )}
        </div>
      )}

      <ol className="flex flex-col gap-2" aria-label="Every tier here, lowest first">
        {rows.map((rung) => (
          <li
            key={rung.tier}
            className="flex gap-3 rounded-lg px-3 py-2.5"
            style={rung.state === "here" ? { backgroundColor: `${rung.color}14`, border: `1px solid ${rung.color}55` } : { border: `1px solid ${t.border}` }}
            data-qa="your-status-rung"
            data-state={rung.state}
          >
            <span aria-hidden className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: rung.color }} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold" style={{ color: t.text }}>
                <span>{rung.label}</span>
                {MARK[rung.state] && (
                  <span className="text-xs font-medium" style={{ color: rung.state === "ahead" ? t.muted : rung.state === "here" ? rung.color : t.muted }}>
                    {MARK[rung.state]}
                  </span>
                )}
              </p>
              <p className="text-xs" style={{ color: t.muted }}>
                Takes {rung.takes}
              </p>
              {rung.perk && (
                <p className="mt-0.5 text-xs" style={{ color: t.text }}>
                  Gets you: {rung.perk}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {loyalty.tier && !next && (
        <p className="text-xs" style={{ color: t.muted }}>
          You hold the top tier here.
        </p>
      )}
    </div>
  );
}

/** What each rung says about where the client stands. "ahead" says nothing. */
const MARK: Record<LadderState, string | null> = {
  here: "You're here",
  reached: "Reached ✓",
  next: "Next",
  ahead: null,
};
