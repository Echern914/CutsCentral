import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";

interface NudgeRow {
  who: string;
  at: string;
  status: string;
  resultedInBooking: boolean;
}

export default async function NudgesPage() {
  const res = await apiGet<{ nudges: NudgeRow[] }>("/api/dashboard/nudges");
  const nudges = res.data?.nudges ?? [];
  const sent = nudges.filter((n) => n.status === "SENT").length;
  const converted = nudges.filter((n) => n.resultedInBooking).length;
  const rate = sent > 0 ? Math.round((converted / sent) * 100) : 0;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <Link href="/dashboard" className="text-xs text-muted hover:text-offwhite">
        ← Dashboard
      </Link>
      <h1 className="mb-1 mt-1 font-display text-3xl tracking-tight">Nudge history</h1>
      <p className="mb-6 text-sm text-muted">
        {sent} sent · {converted} led to a rebooking
        {sent > 0 ? ` · ${rate}% conversion` : ""}
      </p>

      <Card className="overflow-hidden">
        {nudges.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            No nudges sent yet.
          </p>
        ) : (
          <ul className="divide-y divide-subtle">
            {nudges.map((n, i) => (
              <li key={i} className="flex items-center justify-between px-5 py-3.5">
                <div>
                  <p className="text-sm text-offwhite">{n.who}</p>
                  <p className="text-xs text-muted">
                    {new Date(n.at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {n.resultedInBooking && (
                    <span className="rounded-full bg-emerald-soft/15 px-2.5 py-1 text-[10px] uppercase tracking-wide text-emerald-soft">
                      rebooked
                    </span>
                  )}
                  <span
                    className={`text-xs ${
                      n.status === "SENT"
                        ? "text-muted"
                        : n.status === "FAILED"
                          ? "text-danger-soft"
                          : "text-muted/60"
                    }`}
                  >
                    {n.status.toLowerCase()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
