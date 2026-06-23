import { LocalDate } from "@/components/ui/LocalDate";
import { surfaceStyle, type RewardsTheme } from "@/app/r/[magicToken]/theme";

/** Recent completed visits, each annotated with the punches it earned. Renders
 *  against the shop's resolved theme so it matches the barber's identity. */
export function VisitHistory({
  visits,
  theme,
}: {
  visits: { date: string; service: string | null; punches: number | null }[];
  theme: RewardsTheme;
}) {
  if (visits.length === 0) {
    return (
      <div className="p-5 text-sm" style={{ ...surfaceStyle(theme), color: theme.muted }}>
        No visits recorded yet.
      </div>
    );
  }
  return (
    <div className="overflow-hidden" style={surfaceStyle(theme)}>
      {visits.map((v, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-3 px-5 py-3.5"
          style={i > 0 ? { borderTop: `1px solid ${theme.border}` } : undefined}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-sm">{v.service ?? "Visit"}</span>
            {v.punches != null && v.punches > 0 && (
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ color: theme.accent, backgroundColor: `${theme.accent}1A` }}
              >
                +{v.punches}
              </span>
            )}
          </div>
          <LocalDate
            iso={v.date}
            options={{ month: "short", day: "numeric", year: "numeric" }}
            className="shrink-0 text-xs"
            style={{ color: theme.muted }}
          />
        </div>
      ))}
    </div>
  );
}
