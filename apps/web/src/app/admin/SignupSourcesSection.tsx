import { heardAboutLabel, type HeardAboutId } from "@chairback/config/heardAbout";
import { Card } from "@/components/ui/Card";

export interface SignupSources {
  days: number;
  answers: { id: HeardAboutId; total: number; recent: number }[];
  noAnswer: { total: number; recent: number };
}

/**
 * "How did you hear about us?", counted. Proportion bars like the top lists in
 * Activity, biggest first. A business with no answer stays out of the bars and
 * gets a line of its own: every business from before the question would otherwise
 * be the biggest bar and shrink the answers into slivers.
 */
export function SignupSourcesSection({ data }: { data: SignupSources }) {
  const rows = [...data.answers].sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const answered = rows.reduce((sum, r) => sum + r.total, 0);

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg">How did you hear about us?</h2>
        <span className="text-xs text-muted">All time · last {data.days} days</span>
      </div>
      <Card className="p-4">
        {answered === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            No answers yet. Owners are asked when they set up their business.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.id} title={`${heardAboutLabel(r.id)}: ${r.total} all time, ${r.recent} in the last ${data.days} days`}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate text-offwhite">{heardAboutLabel(r.id)}</span>
                  <span className="shrink-0 text-muted">
                    {r.total} · {r.recent}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-charcoal-700">
                  <div
                    className="h-full rounded-full bg-gold/70"
                    style={{ width: `${(r.total / max) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.noAnswer.total > 0 && (
          <p className="mt-3 text-xs text-muted">
            {data.noAnswer.total} {data.noAnswer.total === 1 ? "business has" : "businesses have"} no answer, including{" "}
            {data.noAnswer.recent} in the last {data.days} days. Businesses made before we asked have none.
          </p>
        )}
      </Card>
    </section>
  );
}
