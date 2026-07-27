import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { serviceColorHex } from "@chairback/config/constants";

/** One row of today's agenda (the subset of /api/booking/agenda we render). */
export interface TodayRow {
  id: string;
  source: "appointment" | "visit" | "block";
  start: string; // ISO
  clientName: string;
  serviceName: string | null;
  serviceColor: string | null;
  price: number | null;
  status: "pending" | "upcoming" | "completed" | "canceled" | "no_show" | "blocked";
  addOns?: { id: string; name: string }[];
}

/**
 * Add-on name -> icon. Barbers name their own add-ons, so match on keywords
 * rather than an exact list: the first entry whose keyword appears in the
 * lowercased name wins, and anything unmatched falls back to a neutral dot.
 * Ordered most-specific first ("beard trim" must not match a bare "trim").
 */
const ADD_ON_ICONS: { keywords: string[]; icon: string }[] = [
  { keywords: ["beard", "goatee"], icon: "🧔" },
  { keywords: ["shave", "razor", "hot towel"], icon: "🪒" },
  { keywords: ["line up", "lineup", "edge", "shape"], icon: "📐" },
  { keywords: ["wash", "shampoo", "rinse"], icon: "💧" },
  { keywords: ["color", "dye", "bleach", "tint"], icon: "🎨" },
  { keywords: ["style", "blow", "dry"], icon: "💨" },
  { keywords: ["brow", "eyebrow"], icon: "👁️" },
  { keywords: ["mask", "facial", "face"], icon: "🧖" },
  { keywords: ["kid", "child"], icon: "🧒" },
  { keywords: ["wax"], icon: "🕯️" },
];

/** The icon for an add-on name; a neutral dot when nothing matches. */
export function addOnIcon(name: string): string {
  const n = name.toLowerCase();
  for (const { keywords, icon } of ADD_ON_ICONS) {
    if (keywords.some((k) => n.includes(k))) return icon;
  }
  return "•";
}

/** Statuses that are done/void — dimmed, and excluded from the "left today" count. */
const CLOSED = new Set(["completed", "canceled", "no_show"]);

/**
 * Today's appointments, first thing on the dashboard: when a barber opens the
 * app this is what they land on, so the day reads at a glance before any of the
 * analytics below. Rows come from the normalized agenda endpoint, so this works
 * identically for native-booking and synced (Acuity/Square) shops.
 */
export function TodayAgenda({
  rows,
  timezone,
}: {
  rows: TodayRow[];
  timezone: string;
}) {
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  const remaining = rows.filter((r) => !CLOSED.has(r.status)).length;

  return (
    <Card className="mb-6 overflow-hidden" >
      <div className="flex items-baseline justify-between gap-3 border-b border-subtle px-5 py-4">
        <div>
          <h2 className="font-display text-lg">Today</h2>
          <p className="text-xs text-muted">
            {rows.length === 0
              ? "Nothing on the books."
              : `${remaining} ${remaining === 1 ? "appointment" : "appointments"} left today.`}
          </p>
        </div>
        <Link
          href="/dashboard/booking"
          className="shrink-0 text-xs font-medium text-muted transition-colors hover:text-offwhite"
        >
          Full calendar →
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          No appointments today. Enjoy the quiet — or share your booking link.
        </p>
      ) : (
        <ul className="divide-y divide-subtle">
          {rows.map((r) => {
            const stripe = serviceColorHex(r.serviceColor);
            const closed = CLOSED.has(r.status);
            return (
              <li
                key={r.id}
                className="flex items-start gap-3 px-5 py-3"
                style={{
                  borderLeft: stripe ? `3px solid ${stripe}` : undefined,
                  opacity: closed ? 0.5 : undefined,
                }}
              >
                <span className="w-16 shrink-0 pt-0.5 text-sm tabular-nums text-muted">
                  {timeFmt.format(new Date(r.start))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span
                      className="block truncate text-sm font-medium"
                      style={{ textDecoration: closed ? "line-through" : undefined }}
                    >
                      {r.clientName}
                    </span>
                    {r.price !== null && (
                      <span className="shrink-0 text-sm text-muted">${r.price}</span>
                    )}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    {r.serviceName && (
                      <span className="text-xs text-muted">{r.serviceName}</span>
                    )}
                    {/* Add-on icons: the barber sees at a glance that this cut
                        also has a beard trim, a wash, etc. Title carries the
                        real name for anyone hovering / using a screen reader. */}
                    {(r.addOns ?? []).map((a) => (
                      <span
                        key={a.id}
                        title={a.name}
                        aria-label={a.name}
                        className="text-xs leading-none"
                      >
                        {addOnIcon(a.name)}
                      </span>
                    ))}
                    {r.status === "pending" && (
                      <span className="rounded-full border border-gold/40 px-1.5 py-0.5 text-[10px] font-medium text-gold">
                        Request
                      </span>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
