"use client";

import { useState } from "react";
import Link from "next/link";
import type { GoalSuggestion, SuggestMetric, SuggestPeriod } from "@chairback/config/insightsStats";
import { pluralServiceNoun } from "@chairback/config/constants";
import { resolveHref } from "@chairback/config/features";
import { Card, CardHeader } from "@/components/ui/Card";
import type { Goal, StatsData } from "./page";
import { saveGoalAction } from "./actions";

/**
 * WHERE YOU CAN GO - one suggested goal per metric, straight under the numbers
 * it comes from.
 *
 * The suggestion is arithmetic over the shop's own history (see suggestGoal in
 * @chairback/config/insightsStats): the recent average plus a 10-15% stretch,
 * never more than 15%. No model, no other shop's data. One tap saves it as the
 * ordinary goal through the existing goals API, and the goal stays editable.
 *
 * The "how" is the growth tools this shop has running, and a link to switching
 * on the ones that are off. Only rendered for Premium (the API sends no
 * suggestions or levers to a Starter shop), so nothing here promises a tool the
 * shop's plan does not include.
 */
export function GoalSuggestions({
  suggestions,
  period,
  goals,
  levers,
  serviceNoun,
  onSaved,
}: {
  suggestions: GoalSuggestion[];
  period: SuggestPeriod;
  goals: Goal[] | null;
  levers: StatsData["levers"];
  serviceNoun: string;
  onSaved: () => Promise<void>;
}) {
  const nounPlural = pluralServiceNoun(serviceNoun);
  const metrics: SuggestMetric[] = ["revenue", "visits"];
  const running = [
    levers?.rebookPush ? "rebooking nudges" : null,
    levers?.rewards ? "rewards" : null,
    levers?.autoFill ? "auto-fill" : null,
  ].filter((x): x is string => x !== null);
  const rewardsHref = resolveHref("punch-cards") ?? "/dashboard/rewards";
  const settingsHref = resolveHref("booking-rules") ?? "/dashboard/booking?tab=Settings";

  return (
    <Card className="p-5">
      <CardHeader
        title={`Suggested goals for next ${period}`}
        subtitle="From your own numbers: your recent average plus a small stretch. An estimate to aim at, not a promise. Change the number any time."
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {metrics.map((metric) => (
          <SuggestionCell
            key={`${metric}:${period}`}
            metric={metric}
            period={period}
            suggestion={suggestions.find((s) => s.metric === metric && s.period === period) ?? null}
            currentTarget={goals?.find((g) => g.metric === metric && g.period === period)?.target ?? null}
            running={running}
            nounPlural={nounPlural}
            onSaved={onSaved}
          />
        ))}
      </div>
      {levers && (!levers.rewards || !levers.autoFill) && (
        <div className="mt-4 rounded-xl border border-subtle px-4 py-3" data-testid="growth-levers">
          <p className="text-xs font-medium text-offwhite">Help it along</p>
          <ul className="mt-1.5 flex flex-col gap-1.5 text-xs text-muted">
            {!levers.rewards && (
              <li>
                <Link href={rewardsHref} className="text-gold underline-offset-2 hover:underline">
                  Turn on rewards
                </Link>{" "}
                so every visit earns toward a reward, which brings clients back sooner.
              </li>
            )}
            {!levers.autoFill && (
              <li>
                <Link href={settingsHref} className="text-gold underline-offset-2 hover:underline">
                  Fill cancellations automatically
                </Link>{" "}
                so a time someone gives up goes to your best clients first.
              </li>
            )}
          </ul>
        </div>
      )}
    </Card>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

function SuggestionCell({
  metric,
  period,
  suggestion,
  currentTarget,
  running,
  nounPlural,
  onSaved,
}: {
  metric: SuggestMetric;
  period: SuggestPeriod;
  suggestion: GoalSuggestion | null;
  currentTarget: number | null;
  running: string[];
  nounPlural: string;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = metric === "revenue" ? "Revenue" : nounPlural.charAt(0).toUpperCase() + nounPlural.slice(1);
  const amount = (n: number) => (metric === "revenue" ? money(n) : `${n.toLocaleString("en-US")} ${nounPlural}`);

  if (!suggestion) {
    return (
      <div className="flex flex-col rounded-xl border border-subtle p-4" data-testid={`suggest-${metric}`}>
        <p className="text-[11px] uppercase tracking-wide text-muted">{title} · next {period}</p>
        <p className="mt-1 text-sm text-muted">
          Not enough history yet. After two {period}s with bookings, a suggestion shows here.
        </p>
      </div>
    );
  }

  const already = currentTarget === suggestion.target;
  const why =
    `Your last ${suggestion.periodsAveraged} ${period}s averaged ${amount(suggestion.average)}. ` +
    (running.length > 0
      ? `With ${joinWords(running)} running, ${amount(suggestion.target)} is within reach (about ${suggestion.liftPct}% more).`
      : `${amount(suggestion.target)} is within reach (about ${suggestion.liftPct}% more).`);

  async function use() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const r = await saveGoalAction({ metric, period, target: suggestion!.target });
      if (!r.ok) {
        setError("Couldn't save that goal. Try again.");
        return;
      }
      await onSaved();
      setSaved(true);
    } catch {
      setError("Couldn't save that goal. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col rounded-xl border border-subtle p-4" data-testid={`suggest-${metric}`}>
      <p className="text-[11px] uppercase tracking-wide text-muted">{title} · next {period}</p>
      <p className="mt-1 font-display text-2xl tabular-nums text-offwhite">{amount(suggestion.target)}</p>
      <p className="mt-1 text-xs leading-snug text-muted">{why}</p>
      {currentTarget !== null && !already && (
        <p className="mt-1 text-[11px] text-muted">Your goal now: {amount(currentTarget)}.</p>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <button
          type="button"
          onClick={() => void use()}
          disabled={saving || already}
          className="rounded-full bg-gold px-3 py-1.5 text-xs font-semibold text-on-gold transition-opacity disabled:opacity-50"
        >
          {saving ? "Saving…" : already ? "This is your goal" : "Use this goal"}
        </button>
        {saved && !error && (
          <span role="status" className="text-[11px] text-emerald-soft">
            Saved. Edit it in your goals below.
          </span>
        )}
        {error && (
          <span role="alert" className="text-[11px] text-danger-soft">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
