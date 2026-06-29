import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  LOYALTY_TIERS,
  CADENCE_OPTIONS,
  type LoyaltyTierKey,
  type CadenceKey,
} from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { ClientActions } from "./ClientActions";
import { EditClient } from "./EditClient";
import { MergeClient } from "./MergeClient";
import { NotesEditor } from "./NotesEditor";
import { PunchHistory } from "./PunchHistory";
import { VisitHistory } from "./VisitHistory";

interface ClientDetail {
  client: {
    id: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
    optedOut: boolean;
    archived: boolean;
    notes: string;
    source: string;
    magicToken: string;
    lastVisitAt: string | null;
    medianIntervalDays: number | null;
    nextExpectedAt: string | null;
    loyaltyTier: LoyaltyTierKey | null;
    preferredCadence: CadenceKey | null;
  };
  balance: number;
  rewards: {
    id: string;
    name: string;
    emoji: string | null;
    punchCost: number;
    affordable: boolean;
  }[];
  rewardReady: boolean;
  promotions: { id: string; title: string }[];
  visits: { id: string; date: string; status: string; service: string | null }[];
  nudges: { sentAt: string; status: string; resultedInBooking: boolean }[];
}

function fmt(d: string | null) {
  return d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "None";
}

interface LedgerEntry {
  id: string;
  at: string;
  earned: number;
  redeemed: number;
  runningBalance: number;
  note: string | null;
  reversed: boolean;
  isCorrection: boolean;
  editable: boolean;
}

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const [res, ledgerRes] = await Promise.all([
    apiGet<ClientDetail>(`/api/dashboard/clients/${params.id}`),
    apiGet<{ entries: LedgerEntry[] }>(`/api/dashboard/clients/${params.id}/ledger`),
  ]);
  if (res.status === 404) notFound();
  // A dropped/stale/revoked session (e.g. a token minted before a tokenVersion
  // bump) returns 401 on either call - send them to log back in rather than
  // dead-ending, matching the dashboard's behavior. (The layout catches this for
  // the whole dashboard too; this is defense in depth for the parallel calls.)
  if (res.status === 401 || ledgerRes.status === 401) redirect("/login");
  // Any other failure (5xx, transient network) throws so error.tsx renders its
  // "Try again" card instead of a no-way-forward message.
  if (!res.ok || !res.data) throw new Error("Failed to load client");
  const { client, balance, rewards, promotions, visits, nudges } = res.data;
  const ledger = ledgerRes.data?.entries ?? [];
  const appBase = process.env.APP_BASE_URL ?? "";
  const rewardsUrl = `${appBase}/r/${client.magicToken}`;
  const readyCount = rewards.filter((r) => r.affordable).length;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <Link href="/dashboard/clients" className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite">
        ← All clients
      </Link>

      <header className="mb-6 mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">
            {client.name}
            {client.archived && (
              <span className="ml-2 align-middle text-[10px] uppercase tracking-wide text-muted/80">
                archived
              </span>
            )}
          </h1>
          {client.loyaltyTier && (
            <span
              className="mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{
                color: LOYALTY_TIERS[client.loyaltyTier].color,
                backgroundColor: `${LOYALTY_TIERS[client.loyaltyTier].color}1A`,
              }}
              title="Loyalty tier (by lifetime completed visits)"
            >
              {LOYALTY_TIERS[client.loyaltyTier].label} member
            </span>
          )}
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
          rewards={rewards}
          promotions={promotions}
        />
      </header>

      {client.archived && (
        <div className="mb-4 rounded-2xl border border-subtle bg-charcoal-800 px-5 py-3 text-sm text-muted">
          This client is archived — hidden from your active book, stats, and all
          texts. Their history is kept. Restore them below to bring them back.
        </div>
      )}

      <div className="mb-6 flex flex-col gap-3">
        <EditClient
          clientId={client.id}
          firstName={client.firstName}
          lastName={client.lastName}
          phone={client.phone}
          email={client.email}
          archived={client.archived}
        />
        {/* Merge folds a duplicate INTO this client; it makes no sense to merge
            into an archived (hidden) record, so only offer it on active ones. */}
        {!client.archived && (
          <MergeClient clientId={client.id} clientName={client.name} />
        )}
      </div>

      {/* Snapshot */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Punch balance" value={String(balance)} accent />
        <Stat
          label="Rewards ready"
          value={rewards.length === 0 ? "n/a" : String(readyCount)}
        />
        <Stat
          label="Visits every"
          value={
            client.medianIntervalDays
              ? `~${client.medianIntervalDays}d`
              : client.preferredCadence
                ? CADENCE_OPTIONS[client.preferredCadence].short
                : "n/a"
          }
        />
        <Stat label="Last visit" value={fmt(client.lastVisitAt)} />
      </div>

      {/* Where the balance stands against the menu */}
      {rewards.length > 0 && (
        <Card className="mt-4 px-5 py-3.5">
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
            {rewards.map((r) => (
              <li key={r.id} className="text-xs">
                <span className={r.affordable ? "text-emerald-soft" : "text-muted"}>
                  {r.emoji ? `${r.emoji} ` : ""}
                  {r.name} · {r.punchCost}
                  {r.affordable ? ", ready" : ` (${r.punchCost - balance} to go)`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {/* Visit history (per-row edit/delete) */}
        <VisitHistory clientId={client.id} visits={visits} />

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
        <PunchHistory clientId={client.id} entries={ledger} />
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
