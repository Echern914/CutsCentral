import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { ClientsControls } from "./ClientsControls";

interface ClientRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  optedOut: boolean;
  source: string;
  lastVisitAt: string | null;
  medianIntervalDays: number | null;
  balance: number;
}

interface ClientsResponse {
  clients: ClientRow[];
  total: number;
  page: number;
  pageCount: number;
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: { q?: string; sort?: string; filter?: string; page?: string };
}) {
  const qs = new URLSearchParams();
  for (const k of ["q", "sort", "filter", "page"] as const) {
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
        <Link href="/dashboard" className="text-xs text-muted hover:text-offwhite">
          ← Dashboard
        </Link>
        <div className="mt-1 flex items-baseline justify-between">
          <h1 className="font-display text-3xl tracking-tight">Clients</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">{data?.total ?? 0} total</span>
            <a
              href="/dashboard/export/clients"
              className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted hover:bg-charcoal-700"
            >
              Export CSV
            </a>
          </div>
        </div>
      </header>

      <ClientsControls />

      <Card className="overflow-hidden">
        {clients.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            No clients found. Use “Add client” for walk-ins, or connect Acuity to
            sync your appointment history.
          </p>
        ) : (
          <ul className="divide-y divide-subtle">
            {clients.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/dashboard/clients/${c.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-4 hover:bg-charcoal-700 sm:px-5"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-offwhite">
                      {c.name}
                      {c.source === "manual" && (
                        <span className="rounded-full bg-charcoal-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                          manual
                        </span>
                      )}
                      {c.optedOut && (
                        <span className="text-[10px] uppercase tracking-wide text-danger-soft">
                          opted out
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {c.phone ?? c.email ?? "no contact"}
                      {c.lastVisitAt
                        ? ` · last ${new Date(c.lastVisitAt).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <span className="shrink-0 font-display text-gold" title="Punch balance">
                    {c.balance}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          {page > 1 ? (
            <Link
              href={pageUrl(page - 1)}
              className="rounded-full border border-subtle px-4 py-2 text-xs text-offwhite hover:bg-charcoal-700"
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
              className="rounded-full border border-subtle px-4 py-2 text-xs text-offwhite hover:bg-charcoal-700"
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
