import Link from "next/link";
import { apiGet } from "@/lib/api";
import { DemoTour } from "@/components/tour/DemoTour";
import { ClientsControls } from "./ClientsControls";
import { ClientsList, type ClientRow } from "./ClientsList";

interface ClientsResponse {
  clients: ClientRow[];
  total: number;
  page: number;
  pageCount: number;
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: { q?: string; sort?: string; filter?: string; tier?: string; page?: string };
}) {
  const qs = new URLSearchParams();
  for (const k of ["q", "sort", "filter", "tier", "page"] as const) {
    if (searchParams[k]) qs.set(k, searchParams[k]!);
  }
  const res = await apiGet<ClientsResponse>(`/api/dashboard/clients?${qs.toString()}`);
  const data = res.data;
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
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">{data?.total ?? 0} total</span>
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
