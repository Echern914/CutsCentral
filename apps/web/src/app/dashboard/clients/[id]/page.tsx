import Link from "next/link";
import { notFound } from "next/navigation";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { ClientActions } from "./ClientActions";
import { NotesEditor } from "./NotesEditor";

interface ClientDetail {
  client: {
    id: string;
    name: string;
    firstName: string | null;
    phone: string | null;
    email: string | null;
    optedOut: boolean;
    notes: string;
    source: string;
    magicToken: string;
    lastVisitAt: string | null;
    medianIntervalDays: number | null;
    nextExpectedAt: string | null;
  };
  balance: number;
  rewardThreshold: number;
  rewardReady: boolean;
  visits: { date: string; status: string; service: string | null }[];
  nudges: { sentAt: string; status: string; resultedInBooking: boolean }[];
}

function fmt(d: string | null) {
  return d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
}

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const res = await apiGet<ClientDetail>(`/api/dashboard/clients/${params.id}`);
  if (res.status === 404) notFound();
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load client.</main>;
  }
  const { client, balance, rewardThreshold, rewardReady, visits, nudges } = res.data;
  const appBase = process.env.APP_BASE_URL ?? "";
  const rewardsUrl = `${appBase}/r/${client.magicToken}`;
  const towardNext = balance % rewardThreshold;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <Link href="/dashboard/clients" className="text-xs text-muted hover:text-offwhite">
        ← All clients
      </Link>

      <header className="mb-6 mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">{client.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {client.phone ?? "no phone"}
            {client.email ? ` · ${client.email}` : ""}
            {client.optedOut && (
              <span className="ml-2 text-[10px] uppercase tracking-wide text-danger-soft">
                opted out
              </span>
            )}
          </p>
        </div>
        <ClientActions
          clientId={client.id}
          rewardsUrl={rewardsUrl}
          optedOut={client.optedOut}
          hasPhone={Boolean(client.phone)}
          rewardReady={rewardReady}
          rewardLabel="Free Cut"
        />
      </header>

      {/* Snapshot */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Punches" value={`${towardNext}/${rewardThreshold}`} accent />
        <Stat label="Total earned" value={String(balance)} />
        <Stat label="Visits every" value={client.medianIntervalDays ? `~${client.medianIntervalDays}d` : "—"} />
        <Stat label="Last visit" value={fmt(client.lastVisitAt)} />
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {/* Visit history */}
        <Card className="overflow-hidden">
          <div className="border-b border-subtle px-5 py-3">
            <h2 className="font-display text-lg">Visits</h2>
          </div>
          {visits.length === 0 ? (
            <p className="px-5 py-5 text-sm text-muted">No visits yet.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-subtle overflow-y-auto">
              {visits.map((v, i) => (
                <li key={i} className="flex items-center justify-between px-5 py-3">
                  <span className="text-sm text-offwhite">{v.service ?? "Visit"}</span>
                  <span className="text-xs text-muted">
                    {fmt(v.date)} · {v.status.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Nudge history */}
        <Card className="overflow-hidden">
          <div className="border-b border-subtle px-5 py-3">
            <h2 className="font-display text-lg">Nudges</h2>
          </div>
          {nudges.length === 0 ? (
            <p className="px-5 py-5 text-sm text-muted">No nudges sent.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-subtle overflow-y-auto">
              {nudges.map((n, i) => (
                <li key={i} className="flex items-center justify-between px-5 py-3">
                  <span className="text-sm text-offwhite">{fmt(n.sentAt)}</span>
                  <span className="text-xs text-muted">
                    {n.status.toLowerCase()}
                    {n.resultedInBooking && (
                      <span className="ml-2 text-emerald-soft">rebooked</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <NotesEditor clientId={client.id} initial={client.notes} />
      </div>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 font-display text-xl ${accent ? "text-gold" : "text-offwhite"}`}>
        {value}
      </p>
    </Card>
  );
}
