import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  CADENCE_OPTIONS,
  type LoyaltyTierKey,
  type CadenceKey,
} from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { featureLocks, getBillingSummary } from "@/lib/billing";
import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { InstagramHandle } from "@/components/InstagramHandle";
import { displayPhone, mailtoUri, smsUri, telUri } from "@/lib/contactUri";
import { UpcomingVisits, type UpcomingRow } from "./UpcomingVisits";
import { BookingBlock } from "./BookingBlock";
import { ClientActions } from "./ClientActions";
import { ClientOffers } from "./ClientOffers";
import type { OffersList } from "../../offers/actions";
import { EditClient } from "./EditClient";
import { EmailMarketing, type ClientEmailMarketing } from "./EmailMarketing";
import { SavedCardPanel, type SavedCardFacts } from "./SavedCardPanel";
import { MergeClient } from "./MergeClient";
import { NotesEditor } from "./NotesEditor";
import { PunchHistory } from "./PunchHistory";
import { RebookPanel } from "./RebookPanel";
import { TierStanding, type ClientTier } from "./TierStanding";
import { VisitHistory } from "./VisitHistory";

interface ClientDetail {
  client: {
    id: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    /** Bare Instagram handle, when the client gave one. */
    instagram?: string | null;
    /** What the customer calls themselves in My ChairBack. Never the shop's own record. */
    appName?: string | null;
    /** The shop had no name for this client, so `name` above IS the app name. */
    nameFromApp?: boolean;
    phone: string | null;
    email: string | null;
    optedOut: boolean;
    /** Their yes to the shop's marketing email. Optional: an older API sends none. */
    emailMarketing?: ClientEmailMarketing;
    /** The card they asked the shop to keep for their future appointments. */
    savedCard?: SavedCardFacts | null;
    archived: boolean;
    /** When the shop blocked them from booking online, or null. Optional: an older API sends none. */
    bookingBlockedAt?: string | null;
    notes: string;
    source: string;
    magicToken: string;
    lastVisitAt: string | null;
    medianIntervalDays: number | null;
    nextExpectedAt: string | null;
    loyaltyTier: LoyaltyTierKey | null;
    preferredCadence: CadenceKey | null;
  };
  /** The tier under the shop's rules right now, and what the next one needs. */
  tier?: ClientTier;
  balance: number;
  cards: {
    id: string | null; // null = the default card
    name: string;
    emoji: string | null;
    accentColor: string | null;
    active: boolean; // archived cards can't take new punches
    balance: number;
  }[];
  rewards: {
    id: string;
    name: string;
    emoji: string | null;
    punchCost: number;
    cardTypeId: string | null;
    affordable: boolean;
  }[];
  rewardReady: boolean;
  promotions: { id: string; title: string }[];
  visits: { id: string; date: string; status: string; service: string | null }[];
  upcoming: UpcomingRow[];
  /** Shop timezone — upcoming appointments render in shop time, not the reader's. */
  timezone: string;
  nudges: { sentAt: string; status: string; resultedInBooking: boolean }[];
}

/**
 * A date in the SHOP's zone. This page renders on the server (UTC on Vercel),
 * so with no zone an evening visit read as the next day.
 */
function fmt(d: string | null, timeZone: string) {
  return d
    ? new Date(d).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" })
    : "None";
}

interface LedgerEntry {
  id: string;
  at: string;
  earned: number;
  redeemed: number;
  runningBalance: number;
  note: string | null;
  card: { id: string; name: string; emoji: string | null; accentColor: string | null } | null;
  reversed: boolean;
  isCorrection: boolean;
  editable: boolean;
}

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const [res, ledgerRes, me, offersRes] = await Promise.all([
    apiGet<ClientDetail>(`/api/dashboard/clients/${params.id}`),
    apiGet<{ entries: LedgerEntry[] }>(`/api/dashboard/clients/${params.id}/ledger`),
    getMe(),
    // Offers & codes: { enabled: false } for every shop it isn't switched on for.
    apiGet<OffersList>(`/api/offers?clientId=${encodeURIComponent(params.id)}`),
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
  const { client, balance, cards, rewards, promotions, visits, nudges } = res.data;
  const upcoming = res.data.upcoming ?? [];
  const timezone = res.data.timezone ?? "UTC";
  const ledger = ledgerRes.data?.entries ?? [];
  // Gate for every punch/reward surface on this page (default true so a
  // transient /me failure never blanks a rewards shop's data).
  const rewardsOn = me.data?.rewardsEnabled ?? true;
  // Raising a tier by hand is an owner's or manager's call. An unknown role
  // (an API from before roles, or a failed /me) still offers it - the API
  // refuses anyone else with a 403, which the pill shows inline.
  const canChangeTier = (me.data?.shopRole ?? "OWNER") !== "BARBER";
  const appBase = process.env.APP_BASE_URL ?? "";
  const rewardsUrl = `${appBase}/r/${client.magicToken}`;
  const readyCount = rewards.filter((r) => r.affordable).length;
  const hasCards = cards.some((c) => c.id !== null);
  const balanceByCard = new Map(cards.map((c) => [c.id, c.balance]));

  // Rebook panel: whole days since the last completed visit, labeled with what
  // that visit was. Server-computed (this is a server component) so the number
  // can't drift on hydration.
  const daysSince = client.lastVisitAt
    ? Math.max(0, Math.floor((Date.now() - new Date(client.lastVisitAt).getTime()) / 86_400_000))
    : null;
  const lastService =
    visits.find((v) => v.status === "COMPLETED")?.service?.trim() || "visit";
  const overdue =
    client.nextExpectedAt !== null && new Date(client.nextExpectedAt).getTime() < Date.now();
  const tel = telUri(client.phone);
  const sms = smsUri(client.phone);
  const mail = mailtoUri(client.email);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5 sm:py-8">
      <Link
        href="/dashboard/clients"
        className="-ml-1 inline-flex min-h-[44px] items-center px-1 text-sm text-muted transition-colors duration-150 ease-out hover:text-offwhite"
      >
        ← Clients
      </Link>

      <header className="mb-5 mt-1 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3.5">
          {/* Clients have no photo (and no account to upload one from), so this
              is always the generated initials chip — it gives the page a face
              to anchor on instead of opening with bare text. */}
          <Avatar name={client.name} size="lg" className="!h-16 !w-16 !text-lg" />
          <div className="min-w-0 pt-1">
          <h1 className="break-words font-display text-[28px] leading-tight tracking-tight">
            {client.name}
            {client.archived && (
              <span className="ml-2 align-middle text-[10px] uppercase tracking-wide text-muted/80">
                archived
              </span>
            )}
          </h1>
          {/* The name the customer set in their own ChairBack app. Beside the
              shop's name, never over it - the shop's record belongs to the shop
              and to its sync source. Hidden when it just repeats the headline. */}
          {client.appName &&
            (client.nameFromApp ||
              client.appName.toLowerCase() !== client.name.toLowerCase()) && (
              <p className="mt-1 text-xs text-muted">
                {client.nameFromApp ? (
                  "Name from their ChairBack app"
                ) : (
                  <>
                    Name in their app: <span className="text-offwhite">{client.appName}</span>
                  </>
                )}
              </p>
            )}
          <TierStanding
            tier={res.data.tier}
            storedTier={client.loyaltyTier}
            clientId={client.id}
            canChange={canChangeTier}
          />
          <p className="mt-1 break-words text-sm text-muted">
            {displayPhone(client.phone) ?? "No phone"}
            {client.email ? ` · ${client.email}` : ""}
            {client.instagram && (
              <>
                {" · "}
                <InstagramHandle handle={client.instagram} />
              </>
            )}
            {client.optedOut && (
              <span className="ml-2 text-[10px] uppercase tracking-wide text-danger-soft">
                opted out
              </span>
            )}
            {client.bookingBlockedAt && (
              <span className="ml-2 text-[10px] uppercase tracking-wide text-danger-soft">
                blocked from booking
              </span>
            )}
          </p>
          </div>
        </div>
        {/* Right side: the "should I text them?" glance - days since their last
            cut with the Nudge button right under it. */}
        <RebookPanel
          clientId={client.id}
          daysSince={daysSince}
          serviceLabel={lastService}
          overdue={overdue}
          // A nudge goes to their ChairBack app first, which needs no phone
          // number and no text consent - the API says where it went, or why
          // it couldn't (no app, and texting off or not allowed). Not for a
          // client blocked from booking: a nudge says "time to book".
          canNudge={!client.bookingBlockedAt}
          // Starter or lapsed: nudges are Premium (the API refuses them).
          // Memoized summary - the layout already fetched it this render.
          premiumLocked={featureLocks(await getBillingSummary()).premium}
        />
      </header>

      {/* Reach them from your own phone. A hand-off to Phone, Messages or
          Mail: ChairBack sends nothing, so texting being off does not apply.
          Text is left out for someone who texted STOP. */}
      {(tel || (sms && !client.optedOut) || mail) && (
        <div className="mb-5 flex gap-2 sm:max-w-md [&>*]:flex-1">
          {tel && <ContactLink href={tel} label="Call" icon="call" />}
          {sms && !client.optedOut && <ContactLink href={sms} label="Text" icon="text" />}
          {mail && <ContactLink href={mail} label="Email" icon="email" />}
        </div>
      )}

      {client.archived && (
        <div className="mb-4 rounded-2xl border border-subtle bg-charcoal-800 px-5 py-3 text-sm text-muted">
          This client is archived — hidden from your active book, stats, and all
          texts. Their history is kept. Restore them under Profile and settings
          to bring them back.
        </div>
      )}

      <div className="mb-6">
        <ClientActions
          clientId={client.id}
          rewardsUrl={rewardsUrl}
          optedOut={client.optedOut}
          rewards={rewards}
          cards={cards}
          promotions={promotions}
          rewardsEnabled={rewardsOn}
        />
      </div>

      {/* Snapshot (punch/reward stats only exist for rewards shops). One strip,
          not four cards: it reads as one fact about one person. */}
      <Card className="overflow-hidden">
        {/* Every cell draws its own right and bottom hairline; the -1px
            margins push the outer ones under the card's clipped edge, so the
            lines only ever fall BETWEEN cells, at 2 or 4 across. */}
        <div
          className={`-mb-px -mr-px grid grid-cols-2 [&>*]:border-b [&>*]:border-r [&>*]:border-subtle ${
            rewardsOn ? "sm:grid-cols-4" : ""
          }`}
        >
          {rewardsOn && <Stat label="Punches" value={String(balance)} accent />}
          {rewardsOn && (
            <Stat label="Rewards ready" value={rewards.length === 0 ? "n/a" : String(readyCount)} />
          )}
          <Stat
            label="Comes every"
            value={
              client.medianIntervalDays
                ? `~${client.medianIntervalDays} days`
                : client.preferredCadence
                  ? CADENCE_OPTIONS[client.preferredCadence].short
                  : "n/a"
            }
          />
          <Stat label="Last visit" value={fmt(client.lastVisitAt, timezone)} />
        </div>

        {/* Per-card balances - only meaningful once the shop has custom cards. */}
        {rewardsOn && hasCards && (
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-subtle px-4 py-3">
            {cards.map((c) => (
              <li key={c.id ?? "default"} className="flex items-center gap-1.5 text-sm">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: c.accentColor ?? "#D4AF37" }}
                />
                <span className="text-muted">
                  {c.emoji ? `${c.emoji} ` : ""}
                  {c.name}
                </span>
                <span className="font-medium text-offwhite tabular-nums">{c.balance}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Where the balance stands against the menu - each reward measures
            against its OWN card's balance. */}
        {rewardsOn && rewards.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-subtle px-4 py-3">
            {rewards.map((r) => {
              const cardBalance = balanceByCard.get(r.cardTypeId) ?? 0;
              return (
                <li key={r.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-offwhite">
                    {r.emoji ? `${r.emoji} ` : ""}
                    {r.name}
                    <span className="text-muted"> · {r.punchCost}</span>
                  </span>
                  <span className={`shrink-0 text-xs ${r.affordable ? "font-semibold text-emerald-soft" : "text-muted"}`}>
                    {r.affordable ? "Ready" : `${r.punchCost - cardBalance} to go`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* What's coming, before what's been. The history below is past-only. */}
      <UpcomingVisits rows={upcoming} timezone={timezone} />

      <div className="mt-6">
        <NotesEditor clientId={client.id} initial={client.notes} />
      </div>

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
                  <span className="text-sm text-offwhite">{fmt(n.sentAt, timezone)}</span>
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

      {rewardsOn && (
        <div className="mt-6">
          <PunchHistory clientId={client.id} entries={ledger} />
        </div>
      )}

      {offersRes.data?.enabled && (
        <div className="mt-6">
          <ClientOffers
            list={offersRes.data}
            client={{ id: client.id, name: [client.firstName, client.lastName].filter(Boolean).join(" ") || "Client" }}
          />
        </div>
      )}

      {/* The record itself, below the person: edits, merges, consents, the
          saved card and the booking block are things you do now and then,
          not every time you open a client. */}
      <section aria-labelledby="client-settings" className="mt-8">
        <h2 id="client-settings" className="mb-3 font-display text-lg">
          Profile and settings
        </h2>
        <div className="flex flex-col gap-3">
          <EditClient
            clientId={client.id}
            firstName={client.firstName}
            lastName={client.lastName}
            phone={client.phone}
            email={client.email}
            instagram={client.instagram ?? null}
            archived={client.archived}
          />
          {/* Merge folds a duplicate INTO this client; it makes no sense to merge
              into an archived (hidden) record, so only offer it on active ones. */}
          {!client.archived && (
            <MergeClient clientId={client.id} clientName={client.name} />
          )}
          <EmailMarketing
            clientId={client.id}
            hasEmail={Boolean(client.email)}
            initial={client.emailMarketing}
            timezone={timezone}
          />
          {client.savedCard && <SavedCardPanel card={client.savedCard} timezone={timezone} />}
          <BookingBlock
            clientId={client.id}
            initial={client.bookingBlockedAt}
            upcoming={upcoming.length}
            timezone={timezone}
          />
        </div>
      </section>
    </main>
  );
}

/** One cell of the stats strip; the strip draws the dividers. */
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <p className="text-xs text-muted">{label}</p>
      <p
        className={`mt-0.5 truncate font-display text-xl tabular-nums ${accent ? "text-gold" : "text-offwhite"}`}
      >
        {value}
      </p>
    </div>
  );
}

const CONTACT_ICONS = {
  call: "M5.5 3.5h2.2l1.2 3.4-1.6 1.1a9 9 0 0 0 4.7 4.7l1.1-1.6 3.4 1.2v2.2a1.5 1.5 0 0 1-1.6 1.5A13 13 0 0 1 4 5.1a1.5 1.5 0 0 1 1.5-1.6Z",
  text: "M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5Z",
  email: "M3.5 5.5h13v9h-13ZM3.5 6l6.5 5 6.5-5",
} as const;

/** A tel:/sms:/mailto: hand-off, as a 44px button. */
function ContactLink({ href, label, icon }: { href: string; label: string; icon: keyof typeof CONTACT_ICONS }) {
  return (
    <a
      href={href}
      className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-subtle-strong bg-charcoal-800 px-3 text-sm font-semibold text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
    >
      <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0">
        <path
          d={CONTACT_ICONS[icon]}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </a>
  );
}
