import Link from "next/link";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { DemoTour } from "@/components/tour/DemoTour";
import { BroadcastCard, type BroadcastDraft } from "./BroadcastCard";
import type { Promo } from "../promotions/page";
import { draftTiersFromParam, promoBroadcastDraft } from "../promotions/promoDraft";
import { ClientsControls } from "./ClientsControls";
import { ClientsList, type ClientRow } from "./ClientsList";
import { SavedByCard, type SavedByPerson } from "./SavedByCard";
import { JoinRequestsCard, type JoinRequest } from "./JoinRequestsCard";

interface ClientsResponse {
  clients: ClientRow[];
  total: number;
  page: number;
  pageCount: number;
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: {
    q?: string;
    sort?: string;
    filter?: string;
    tier?: string;
    page?: string;
    /** "Email or notify" on a promo: which promo to write out, aimed at which tiers. */
    promo?: string;
    tiers?: string;
  };
}) {
  const qs = new URLSearchParams();
  for (const k of ["q", "sort", "filter", "tier", "page"] as const) {
    if (searchParams[k]) qs.set(k, searchParams[k]!);
  }
  const [res, dupes, savedBy, me] = await Promise.all([
    apiGet<ClientsResponse>(`/api/dashboard/clients?${qs.toString()}`),
    apiGet<{ total: number }>("/api/dashboard/clients/duplicates"),
    apiGet<{ total: number; people: SavedByPerson[]; requests?: JoinRequest[] }>("/api/dashboard/saved-by"),
    // Memoized per render - the layout already fetched it.
    getMe(),
  ]);
  const data = res.data;
  // Written from the shop's own promo, looked up here rather than carried in
  // the link, so the words in the box are always ones the barber wrote.
  let draft: BroadcastDraft | null = null;
  if (searchParams.promo) {
    const promos = await apiGet<{ promotions: Promo[] }>("/api/promos");
    const promo = promos.data?.promotions.find((p) => p.id === searchParams.promo);
    if (promo) draft = { ...promoBroadcastDraft(promo), tiers: draftTiersFromParam(searchParams.tiers) };
  }
  const duplicateGroups = dupes.data?.total ?? 0;
  const clients = data?.clients ?? [];
  const page = data?.page ?? 1;
  const pageCount = data?.pageCount ?? 1;

  function pageUrl(p: number) {
    const next = new URLSearchParams(qs.toString());
    next.set("page", String(p));
    return `/dashboard/clients?${next.toString()}`;
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-5">
      <header className="mb-6">
        <Link href="/dashboard" className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite">
          ← Dashboard
        </Link>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
          <h1 className="font-display text-3xl tracking-tight">Clients</h1>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">{data?.total ?? 0} total</span>
            {duplicateGroups > 0 && (
              <Link
                href="/dashboard/clients/duplicates"
                className="rounded-full border border-gold/40 px-3 py-1.5 text-xs text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
              >
                {duplicateGroups === 1
                  ? "1 possible duplicate"
                  : `${duplicateGroups} possible duplicates`}
              </Link>
            )}
            <a
              href="/dashboard/export/clients"
              className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
            >
              Export CSV
            </a>
          </div>
        </div>
      </header>

      {/* Barber-side guided tour. data-tour: keep in sync with
          packages/config/src/demoTour.ts */}
      <DemoTour tour="dashboard" route="clients" />
      {/* One message to the whole book, or one loyalty group. Above the list
          because it is about all of them, not about the row you tapped.
          Unknown rewards state reads as ON, like the nav: the API refuses a
          tier audience for a rewards-off shop regardless. */}
      <div className="mb-5">
        <BroadcastCard
          key={searchParams.promo ?? "blank"}
          rewardsEnabled={me.data?.rewardsEnabled ?? true}
          draft={draft}
        />
      </div>
      {/* People asking to join from the app (a shop that approves new clients
          first). Above everything else here: someone is waiting on an answer. */}
      {savedBy.data?.requests && savedBy.data.requests.length > 0 && (
        <div className="mb-5">
          <JoinRequestsCard requests={savedBy.data.requests} />
        </div>
      )}
      {/* People who added the shop in their app. Nothing renders until someone
          has, or if this read fails - it is a nice-to-know, never a reason the
          client list can't load. */}
      {savedBy.data && savedBy.data.total > 0 && (
        <div className="mb-5">
          <SavedByCard total={savedBy.data.total} people={savedBy.data.people} />
        </div>
      )}

      <ClientsControls />

      {/* Keyed by the query so selection state resets when the visible rows
          change - otherwise bulk actions could hit clients from a previous page. */}
      <div data-tour="client-book">
        <ClientsList key={qs.toString() || "all"} clients={clients} />
      </div>

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          {page > 1 ? (
            <Link
              href={pageUrl(page - 1)}
              className="rounded-full border border-subtle px-4 py-2 text-xs text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
            >
              ← Prev
            </Link>
          ) : (
            <span className="rounded-full border border-subtle px-4 py-2 text-xs text-muted/40">
              ← Prev
            </span>
          )}
          <span className="text-xs text-muted">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link
              href={pageUrl(page + 1)}
              className="rounded-full border border-subtle px-4 py-2 text-xs text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
            >
              Next →
            </Link>
          ) : (
            <span className="rounded-full border border-subtle px-4 py-2 text-xs text-muted/40">
              Next →
            </span>
          )}
        </div>
      )}
    </main>
  );
}
