import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { StatusControl } from "./StatusControl";

interface RequestRow {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  message: string | null;
  preferredTime: string | null;
  status: "NEW" | "CONTACTED" | "CLOSED";
  createdAt: string;
}

function fullName(r: RequestRow): string {
  return [r.firstName, r.lastName].filter(Boolean).join(" ");
}

export default async function RequestsPage() {
  const res = await apiGet<{ requests: RequestRow[] }>("/api/dashboard/requests");
  const requests = res.data?.requests ?? [];
  const open = requests.filter((r) => r.status === "NEW").length;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <Link href="/dashboard" className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite">
        ← Dashboard
      </Link>
      <h1 className="mb-1 mt-1 font-display text-3xl tracking-tight">
        Appointment requests
      </h1>
      <p className="mb-6 text-sm text-muted">
        Leads from your public page&apos;s request form
        {open > 0 ? ` · ${open} new` : ""}.
      </p>

      <Card className="overflow-hidden">
        {requests.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            No requests yet. Turn on “Take appointment requests” on your{" "}
            <Link href="/dashboard/site" className="text-gold hover:underline">
              public page
            </Link>{" "}
            to start collecting them.
          </p>
        ) : (
          <ul className="divide-y divide-subtle">
            {requests.map((r) => (
              <li key={r.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-offwhite">
                      {fullName(r)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {[r.phone, r.email].filter(Boolean).join(" · ") ||
                        "no contact"}
                    </p>
                    {r.preferredTime && (
                      <p className="mt-1 text-xs text-muted">
                        Prefers: {r.preferredTime}
                      </p>
                    )}
                    {r.message && (
                      <p className="mt-1 text-sm text-offwhite/90">{r.message}</p>
                    )}
                    <p className="mt-1.5 text-[11px] text-muted/70">
                      {new Date(r.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <StatusControl id={r.id} status={r.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
