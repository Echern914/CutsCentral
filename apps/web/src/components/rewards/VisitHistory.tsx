import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";

/** Recent completed visits, each annotated with the punches it earned. */
export function VisitHistory({
  visits,
  accent,
}: {
  visits: { date: string; service: string | null; punches: number | null }[];
  accent: string;
}) {
  if (visits.length === 0) {
    return (
      <Card className="p-5 text-sm text-muted">No visits recorded yet.</Card>
    );
  }
  return (
    <Card className="divide-y divide-subtle">
      {visits.map((v, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-sm text-offwhite">
              {v.service ?? "Visit"}
            </span>
            {v.punches != null && v.punches > 0 && (
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ color: accent, backgroundColor: `${accent}1A` }}
              >
                +{v.punches}
              </span>
            )}
          </div>
          <LocalDate
            iso={v.date}
            options={{ month: "short", day: "numeric", year: "numeric" }}
            className="shrink-0 text-xs text-muted"
          />
        </div>
      ))}
    </Card>
  );
}
