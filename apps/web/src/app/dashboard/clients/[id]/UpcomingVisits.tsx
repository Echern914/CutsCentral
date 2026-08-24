import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { NAME_WRAP_CLS } from "../../_components/appointmentCardStyles";

export interface UpcomingRow {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  service: string;
  staff: string;
  /** Decimal serialized as a string, or null when the service had no price. */
  price: string | null;
}

/**
 * What this client has coming up.
 *
 * The visit history below it is a past-only ledger, so without this the page
 * could list everything a client had ever done and still not mention that
 * they're booked in tomorrow morning. Times render in the SHOP's timezone —
 * a barber checking their book from a different zone needs the time the client
 * actually walks in at.
 */
export function UpcomingVisits({
  rows,
  timezone,
}: {
  rows: UpcomingRow[];
  timezone: string;
}) {
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 border-b border-subtle px-5 py-4">
        <div>
          <h2 className="font-display text-lg">Upcoming</h2>
          <p className="text-xs text-muted">
            {rows.length === 0
              ? "Nothing booked yet."
              : `${rows.length} on the books.`}
          </p>
        </div>
        <Link
          href="/dashboard/booking?tab=Appointments"
          className="shrink-0 text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
        >
          Calendar →
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          When this client books, their next visit shows here.
        </p>
      ) : (
        <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
          {rows.map((r) => (
            <li key={r.id} className="px-5 py-3.5">
              {/* Whose page this is is never in question here, so the SERVICE
                  is the headline - but it wraps and never truncates, the same
                  rule the client name gets on every other card. */}
              <div className="flex items-start justify-between gap-3">
                <p className={`${NAME_WRAP_CLS} flex-1 text-[15px]`}>{r.service}</p>
                <StatusBadge status={r.status} />
              </div>
              <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
                {dayFmt.format(new Date(r.startsAt))} ·{" "}
                {timeFmt.format(new Date(r.startsAt))} · {r.staff}
                {r.price !== null && ` · ${formatPrice(r.price)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * PENDING holds the slot but still needs the barber to approve it, so it reads
 * as an action ("Needs approval"), not a neutral state — that difference is the
 * whole reason request-before-booking shops need this list.
 */
function StatusBadge({ status }: { status: string }) {
  if (status === "PENDING") {
    return (
      <span className="shrink-0 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-gold">
        Needs approval
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-soft">
      Confirmed
    </span>
  );
}

/** "45" -> "$45", "45.50" -> "$45.50". Trailing ".00" is noise on a price chip. */
function formatPrice(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n)) return `$${price}`;
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}
