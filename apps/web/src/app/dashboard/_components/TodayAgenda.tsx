import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { resolveServiceColor } from "@chairback/config/serviceColor";
import { NAME_WRAP_CLS, initialsOf } from "./appointmentCardStyles";
import { SpecialChip } from "./SpecialChip";
import { chairNameFor, tellableChairs, type ChairLike } from "./chairView";
import { formatPrice } from "@/lib/serviceFields";
import { durationLabel, planToday, startsIn, type ScheduleItem } from "./todayPlan";

/** One row of today's agenda (the subset of /api/booking/agenda we render). */
export interface TodayRow {
  id: string;
  source: "appointment" | "visit" | "block";
  start: string; // ISO
  /** ISO; null when the source never said (an older synced visit). */
  end?: string | null;
  /** The chair it is on. Gaps are only drawn when the day has ONE chair. */
  staffId?: string | null;
  clientName: string;
  serviceName: string | null;
  serviceColor: string | null;
  price: number | null;
  status: "pending" | "upcoming" | "completed" | "canceled" | "no_show" | "blocked";
  addOns?: { id: string; name: string }[];
  /** Booked into one of the barber's specials - a chip by the name. */
  special?: boolean;
  /** ...and that special is outside his regular hours: "After hours". */
  afterHours?: boolean;
  premium?: boolean;
  /** A block that stops only SOME services, and which ones (AgendaRow twin). */
  blockServiceIds?: string[];
  blockScope?: string;
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

/** Where a row opens: its own sheet when the calendar can open one. */
function hrefFor(row: TodayRow): string {
  return row.source === "appointment"
    ? `/dashboard/booking?appointment=${encodeURIComponent(row.id)}`
    : "/dashboard/booking?view=day";
}

/**
 * Today, first thing on the dashboard (Studio redesign): what the day is
 * worth, who is next, what is waiting on the barber, then the day in order
 * with its open gaps. Rows come from the normalized agenda endpoint, so this
 * works identically for native-booking and synced (Acuity/Square) shops.
 *
 * `now` is a prop so the clock-based claims ("in 18 min", "left") are tested
 * against a fixed instant instead of whenever the suite happens to run.
 */
export function TodayAgenda({
  rows,
  timezone,
  now = Date.now(),
  staff = [],
}: {
  rows: TodayRow[];
  timezone: string;
  now?: number;
  /**
   * Everyone who works here. With two or more active, each booking says who
   * it is with; a one-person shop (or no list at all) reads exactly as before.
   */
  staff?: ChairLike[];
}) {
  const chairs = tellableChairs(staff);
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  const time = (iso: string | number) => timeFmt.format(new Date(iso));
  // "11:00 – 11:35 AM": the period once when both ends share it.
  const range = (row: TodayRow) => {
    const a = time(row.start);
    if (!row.end) return a;
    const b = time(row.end);
    const pa = a.slice(-2);
    return pa === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
  };

  const plan = planToday(rows, now);
  // 🔴 Blocked time (a lunch, an Acuity block) is not an appointment. It was
  // counted in "N appointments left" and drawn as a client row, initials and
  // all - "1 appointment left today" on a day with nothing booked.
  const bookings = rows.filter((r) => r.source !== "block");
  const next = plan.upNext;
  const firstRequest = plan.requests[0];

  return (
    <section aria-label="Today's schedule" className="mb-6 flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-2.5">
        <Stat
          label="Booked"
          value={plan.bookedUnknown ? "—" : formatPrice(plan.booked)}
          hint={plan.bookedUnknown ? "No prices on these bookings" : undefined}
        />
        <Stat label="Left today" value={String(plan.left)} />
        <Stat
          label="Open gaps"
          value={plan.openMin === null ? "—" : plan.openMin === 0 ? "None" : durationLabel(plan.openMin)}
          hint={plan.openMin === null ? "Some bookings have no end time" : undefined}
        />
      </dl>

      {firstRequest && (
        <Link
          href={hrefFor(firstRequest)}
          className="flex min-h-[56px] items-center justify-between gap-3 rounded-2xl border border-gold/40 bg-gold/10 px-4 py-3 transition-colors duration-150 ease-out hover:bg-gold/15"
        >
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-offwhite">
              {plan.requests.length === 1
                ? "1 request needs you"
                : `${plan.requests.length} requests need you`}
            </span>
            <span className="block truncate text-xs text-muted">
              {firstRequest.clientName} asked for {time(firstRequest.start)}
              {plan.requests.length > 1 ? ` · and ${plan.requests.length - 1} more` : ""}
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-sm font-semibold text-gold">
            Review →
          </span>
        </Link>
      )}

      {next && (
        <Card className="px-4 py-4 sm:px-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              {startsIn(next, now) === "Now" ? "With you now" : "Up next"}
            </h2>
            <span className="text-xs font-semibold tabular-nums text-gold">{startsIn(next, now)}</span>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-charcoal-700 text-sm font-semibold text-offwhite"
            >
              {initialsOf(next.clientName)}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`${NAME_WRAP_CLS} text-lg`}>{next.clientName}</p>
              <p className="text-sm text-muted [overflow-wrap:anywhere]">
                {[
                  next.serviceName,
                  chairNameFor(next, chairs),
                  range(next),
                  next.price !== null ? formatPrice(next.price) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <Link
              href={hrefFor(next)}
              className="flex min-h-[44px] shrink-0 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-on-primary transition-colors duration-150 ease-out hover:bg-primary/90"
            >
              Open
            </Link>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-baseline justify-between gap-3 border-b border-subtle px-4 py-3.5 sm:px-5">
          <div>
            <h2 className="font-display text-lg">Schedule</h2>
            <p className="text-xs text-muted">
              {bookings.length === 0
                ? "Nothing on the books."
                : `${plan.left} ${plan.left === 1 ? "appointment" : "appointments"} left today.`}
            </p>
          </div>
          <Link
            href="/dashboard/booking"
            className="flex min-h-[44px] shrink-0 items-center text-sm font-medium text-gold underline-offset-2 hover:underline"
          >
            Open calendar
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted sm:px-5">
            No appointments today. Enjoy the quiet — or share your booking link.
          </p>
        ) : (
          <ul className="divide-y divide-subtle">
            {plan.earlier > 0 && (
              // A busy day's finished bookings fold away so the list opens on
              // what is next. A native <details>: no client JS, and the rows
              // are still one tap away (and still in the page for search).
              <li>
                <details className="group">
                  <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150 ease-out hover:bg-charcoal-700/50 sm:px-5 [&::-webkit-details-marker]:hidden">
                    <span className="flex-1 font-medium text-offwhite">Earlier today</span>
                    <span className="text-xs tabular-nums text-muted">
                      {plan.earlierBookings} {plan.earlierBookings === 1 ? "appointment" : "appointments"}
                    </span>
                    <span aria-hidden className="text-muted transition-transform duration-150 ease-out group-open:rotate-180">
                      <ChevronMark />
                    </span>
                  </summary>
                  <ul className="divide-y divide-subtle border-t border-subtle">
                    {plan.schedule.slice(0, plan.earlier).map((item) => (
                      <ScheduleLine key={keyOf(item)} item={item} time={time} people={chairs} />
                    ))}
                  </ul>
                </details>
              </li>
            )}
            {plan.schedule.slice(plan.earlier).map((item) => (
              <ScheduleLine key={keyOf(item)} item={item} time={time} people={chairs} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

const keyOf = (item: ScheduleItem) =>
  item.kind === "row" ? `${item.row.source}:${item.row.id}` : `gap:${item.start}`;

function ChevronMark() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-subtle bg-charcoal-800 px-3 py-3 sm:px-4">
      <dt className="truncate text-xs text-muted">{label}</dt>
      <dd className="mt-1 font-display text-xl tabular-nums sm:text-2xl" title={hint}>
        {value}
      </dd>
    </div>
  );
}

const STATUS_WORD: Partial<Record<TodayRow["status"], string>> = {
  completed: "Done",
  canceled: "Canceled",
  no_show: "No-show",
};

function ScheduleLine({
  item,
  time,
  people,
}: {
  item: ScheduleItem;
  time: (iso: string | number) => string;
  /** The people to name on a row; empty when there is nobody to tell apart. */
  people: ChairLike[];
}) {
  if (item.kind === "gap") {
    // A past gap, or the last few minutes of one, is history, not an invitation.
    return (
      <li className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
        <span className="w-16 shrink-0 text-xs tabular-nums text-muted">{time(item.start)}</span>
        <span className="flex-1 text-sm text-muted">Open · {durationLabel(item.minutes)}</span>
        {item.fillable && (
          <Link
            href="/dashboard/booking?view=day"
            className="flex min-h-[44px] shrink-0 items-center text-sm font-semibold text-gold underline-offset-2 hover:underline"
          >
            Fill it
          </Link>
        )}
      </li>
    );
  }

  const r = item.row;
  if (r.source === "block") {
    return (
      <li className="flex gap-3 px-4 py-3 sm:px-5" style={{ opacity: 0.6 }}>
        <span className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted">{time(r.start)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted [overflow-wrap:anywhere]">{r.clientName}</p>
            <span className="shrink-0 rounded-md bg-charcoal-700 px-2.5 py-0.5 text-[10px] font-medium text-muted">
              Blocked
            </span>
          </div>
          {(r.blockServiceIds?.length ?? 0) > 0 && r.blockScope && (
            <p className="mt-0.5 text-[11px] text-muted [overflow-wrap:anywhere]">
              {r.blockScope}. Other services stay bookable.
            </p>
          )}
        </div>
      </li>
    );
  }

  // Same resolver as the calendar, so one service is one colour on both
  // surfaces - explicit choice first, then derived from the name.
  const stripe = resolveServiceColor({ explicitKey: r.serviceColor, serviceName: r.serviceName }).hex;
  const closed = CLOSED.has(r.status);
  const word = STATUS_WORD[r.status];
  const withWho = chairNameFor(r, people);
  return (
    <li style={{ opacity: closed ? 0.5 : undefined }}>
      <Link
        href={hrefFor(r)}
        className="flex min-h-[56px] gap-3 px-4 py-3 transition-colors duration-150 ease-out hover:bg-charcoal-700/50 sm:px-5"
      >
        <span className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted">{time(r.start)}</span>
        <span
          aria-hidden
          className="w-[3px] shrink-0 self-stretch rounded-full"
          style={{ backgroundColor: stripe ?? "transparent" }}
        />
        {/* Never truncated: the client's full name is the point. */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p
              className={`${NAME_WRAP_CLS} text-base`}
              style={{ textDecoration: closed ? "line-through" : undefined }}
            >
              {r.clientName}
            </p>
            {r.special && <SpecialChip afterHours={r.afterHours} premium={r.premium} />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {/* Who it is with, in a shop several people work. */}
            {withWho && (
              <span
                data-testid="chair-chip"
                className="max-w-[9rem] shrink-0 truncate rounded-full bg-charcoal-700 px-2 py-0.5 text-[11px] font-medium text-offwhite/85"
              >
                {withWho}
              </span>
            )}
            {r.serviceName && <span className="[overflow-wrap:anywhere]">{r.serviceName}</span>}
            {/* Add-on icons: the barber sees at a glance that this cut also
                has a beard trim, a wash, etc. Title carries the real name for
                anyone hovering / using a screen reader. */}
            {(r.addOns ?? []).map((a) => (
              <span key={a.id} title={a.name} aria-label={a.name} className="leading-none">
                {addOnIcon(a.name)}
              </span>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {r.status === "pending" ? (
            <span className="rounded-md bg-gold/15 px-2.5 py-0.5 text-[10px] font-semibold text-gold">
              Request
            </span>
          ) : (
            <>
              {r.price !== null && (
                <span className="block text-sm tabular-nums text-offwhite">{formatPrice(r.price)}</span>
              )}
              {word && <span className="block text-[11px] text-muted">{word}</span>}
            </>
          )}
        </div>
      </Link>
    </li>
  );
}
