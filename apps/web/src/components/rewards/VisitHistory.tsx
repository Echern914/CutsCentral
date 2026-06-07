import { Card } from "@/components/ui/Card";

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
          <span className="text-xs text-muted">
            {new Date(v.date).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
      ))}
    </Card>
  );
}
