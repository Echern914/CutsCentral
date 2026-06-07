import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";

interface ClientRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  optedOut: boolean;
  lastVisitAt: string | null;
  medianIntervalDays: number | null;
  balance: number;
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const q = searchParams.q?.trim() ?? "";
  const res = await apiGet<{ clients: ClientRow[] }>(
    `/api/dashboard/clients${q ? `?q=${encodeURIComponent(q)}` : ""}`,
  );
  const clients = res.data?.clients ?? [];

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/dashboard" className="text-xs text-muted hover:text-offwhite">
            ← Dashboard
          </Link>
          <h1 className="mt-1 font-display text-3xl tracking-tight">Clients</h1>
        </div>
      </header>

      <form className="mb-5" action="/dashboard/clients" method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by name, phone, or email…"
          className="w-full rounded-xl border border-subtle bg-charcoal-800 px-4 py-3 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50"
        />
      </form>

      <Card className="overflow-hidden">
        {clients.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            {q ? "No clients match that search." : "No clients yet. They appear as appointments sync from Acuity."}
          </p>
        ) : (
          <ul className="divide-y divide-subtle">
            {clients.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/dashboard/clients/${c.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-charcoal-700"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-offwhite">
                      {c.name}
                      {c.optedOut && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-danger-soft">
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
                  <span className="shrink-0 font-display text-gold">{c.balance}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">
        Showing {clients.length} {clients.length === 1 ? "client" : "clients"}
        {clients.length === 200 ? " (max)" : ""}. Number on the right is punch balance.
      </p>
    </main>
  );
}
