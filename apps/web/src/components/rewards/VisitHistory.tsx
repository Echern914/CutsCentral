import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";

/** Recent completed visits list. */
export function VisitHistory({
  visits,
}: {
  visits: { date: string; service: string | null }[];
}) {
  if (visits.length === 0) {
    return (
      <Card className="p-5 text-sm text-muted">No visits recorded yet.</Card>
    );
  }
  return (
    <Card className="divide-y divide-subtle">
      {visits.map((v, i) => (
        <div key={i} className="flex items-center justify-between px-5 py-3.5">
          <span className="text-sm text-offwhite">
            {v.service ?? "Visit"}
          </span>
          <LocalDate
            iso={v.date}
            options={{ month: "short", day: "numeric", year: "numeric" }}
            className="text-xs text-muted"
          />
        </div>
      ))}
    </Card>
  );
}
