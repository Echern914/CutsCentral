import Link from "next/link";
import { cap, useVocab } from "@/components/VocabProvider";
import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { BarberWalkIns } from "./BarberWalkIns";
import { BarberClients } from "./BarberClients";

export interface BarberRow {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  closed: boolean;
  clientName: string;
  service: string;
  color: string | null;
  checkInStatus: string | null;
  etaMinutes: number | null;
  runningLate: boolean;
  price: string | null;
}

export interface BarberHomeData {
  chair: { id: string; name: string } | null;
  shop: { name: string; timezone: string };
  today: BarberRow[];
  counts: { today: number; week: number; month: number };
  reason: string | null;
}

/**
 * The employee dashboard: one chair's day.
 *
 * A barber sees their own book, their own numbers, and their OWN clients -
 * no shop revenue, no colleagues' appointments, never the shop book. "Their
 * clients" (the people their chair has served) was a deliberate widening of
 * the original today-only boundary, decided with Eric for the rewards-access
 * arc. Every boundary is enforced server-side by /api/barber and
 * /api/barber/clients (which read the seat's staffId and ignore any
 * client-supplied one); this component just renders what comes back.
 *
 * Deliberately NOT a cut-down copy of the owner dashboard. Most of that page
 * is about running a business - at-risk clients, revenue trends, texting caps -
 * which is not a barber's job. Their question is "who's in my chair today?".
 */
export function BarberHome({
  data,
  barberName,
  avatarUrl,
}: {
  data: BarberHomeData;
  barberName: string;
  avatarUrl?: string | null;
}) {
  const vocab = useVocab();
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: data.shop.timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  const open = data.today.filter((r) => !r.closed);
  const next = open.find((r) => new Date(r.startsAt).getTime() >= Date.now());

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="flex flex-col items-center pt-2 text-center">
        <Avatar name={barberName} src={avatarUrl} size="lg" />
        <h1 className="mt-3 font-display text-3xl tracking-tight">{barberName}</h1>
        <p className="mt-1 text-sm text-muted">
          {data.chair ? `${data.chair.name} · ${data.shop.name}` : data.shop.name}
        </p>
      </header>

      {/* A seat with no chair linked can't have a book. Say so, and say who
          fixes it, rather than rendering an empty day that reads as broken. */}
      {data.reason === "no_chair_linked" && (
        <Card className="mt-6 border-gold/30 px-5 py-4">
          <p className="text-sm font-medium text-gold">Your {vocab.stationNoun} isn&rsquo;t set up yet</p>
          <p className="mt-1 text-xs text-muted">
            Ask the shop owner to link your login to your {vocab.stationNoun} on the Team page.
            Until then your appointments can&rsquo;t be shown here.
          </p>
        </Card>
      )}

      {data.chair && (
        <>
          <div className="mt-6 grid grid-cols-3 gap-2.5">
            <Stat label="Today" value={data.counts.today} />
            <Stat label="This week" value={data.counts.week} />
            <Stat label="Last 30 days" value={data.counts.month} />
          </div>

          {/* The live walk-in line (claim / ready / start / complete on their
              own chair). Self-loading; renders NOTHING when Walk-In Mode is
              off or dark, so every existing home screen is unchanged. */}
          <BarberWalkIns />

          {/* Their own clientele (served or booked on this chair), with the
              one action a barber keeps asking for: re-text a lost rewards
              link. Self-loading; renders nothing until they have clients. */}
          <BarberClients />

          <Card className="mt-6 overflow-hidden">
            <div className="flex items-baseline justify-between gap-3 border-b border-subtle px-5 py-4">
              <div>
                <h2 className="font-display text-lg">Your day</h2>
                <p className="text-xs text-muted">
                  {open.length === 0
                    ? "Nothing on the books."
                    : next
                      ? `Next up: ${timeFmt.format(new Date(next.startsAt))} · ${next.clientName || "Client"}`
                      : `${open.length} today.`}
                </p>
              </div>
            </div>

            {data.today.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted">
                No appointments today. Enjoy the quiet.
              </p>
            ) : (
              <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
                {data.today.map((r) => (
                  <li
                    key={r.id}
                    className={`flex items-center gap-3 px-5 py-3.5 ${r.closed ? "opacity-50" : ""}`}
                  >
                    <span
                      aria-hidden
                      className="h-8 w-1 shrink-0 rounded-full"
                      style={{ backgroundColor: r.color ?? "#3F3F46" }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-offwhite">
                        {timeFmt.format(new Date(r.startsAt))} ·{" "}
                        {r.clientName || "Client"}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {r.service}
                        {r.closed && ` · ${r.status.toLowerCase().replace("_", " ")}`}
                      </p>
                    </div>
                    {!r.closed && <CheckInBadge row={r} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <p className="mt-6 text-center text-xs text-muted">
        Questions about your schedule? Talk to the shop owner ·{" "}
        <Link href="/support" className="text-gold hover:underline">
          Help
        </Link>
      </p>
    </main>
  );
}

/** "On my way" / "running late" is the one live signal that changes their day. */
function CheckInBadge({ row }: { row: BarberRow }) {
  if (row.runningLate) {
    return (
      <span className="shrink-0 rounded-full border border-danger-soft/40 bg-danger-soft/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-danger-soft">
        Running late
      </span>
    );
  }
  if (row.checkInStatus === "ON_MY_WAY") {
    return (
      <span className="shrink-0 rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-soft">
        {row.etaMinutes ? `${row.etaMinutes} min out` : "On the way"}
      </span>
    );
  }
  if (row.checkInStatus === "ARRIVED") {
    return (
      <span className="shrink-0 rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-soft">
        Here
      </span>
    );
  }
  return null;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-subtle bg-charcoal-800 px-3 py-3 text-center">
      <p className="font-display text-2xl text-gold">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted">{label}</p>
    </div>
  );
}
