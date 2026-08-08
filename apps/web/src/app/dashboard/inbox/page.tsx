import Link from "next/link";
import { apiGet } from "@/lib/api";
import { featureLocks, getBillingSummary } from "@/lib/billing";
import { Card } from "@/components/ui/Card";
import { UpgradeCallout } from "../_components/UpgradeCallout";

interface ConversationRow {
  id: string;
  phone: string;
  status: "active" | "escalated" | "closed";
  clientName: string | null;
  lastMessageAt: string;
}

const STATUS_LABEL: Record<ConversationRow["status"], string> = {
  active: "AI handling",
  escalated: "Needs you",
  closed: "Closed",
};

const STATUS_CLASS: Record<ConversationRow["status"], string> = {
  active: "text-muted",
  escalated: "text-gold",
  closed: "text-muted/60",
};

export default async function InboxPage() {
  const res = await apiGet<{
    conversations: ConversationRow[];
    escalatedCount: number;
  }>("/api/dashboard/receptionist/conversations");
  // Sequential on purpose — memoized fetch; keeps apiGet's generic intact
  // (the dual-React `cache` typing hole would otherwise any-poison the tuple).
  const locks = featureLocks(await getBillingSummary());
  const conversations = res.data?.conversations ?? [];
  const escalated = res.data?.escalatedCount ?? 0;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <Link
        href="/dashboard"
        className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
      >
        ← Dashboard
      </Link>
      <h1 className="mb-1 mt-1 font-display text-3xl tracking-tight">Text inbox</h1>
      <p className="mb-6 text-sm text-muted">
        Every conversation your AI receptionist is having
        {escalated > 0 ? ` · ${escalated} need${escalated === 1 ? "s" : ""} you` : ""}.
        Open one to read it or take over.
      </p>

      {locks.premiumAi && (
        <div className="mb-6">
          <UpgradeCallout tier="pro_ai">
            The Inbox fills when your AI receptionist answers client texts —
            it&apos;s part of the Premium AI plan.
          </UpgradeCallout>
        </div>
      )}

      <Card className="overflow-hidden">
        {conversations.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            No conversations yet. Conversations start when your{" "}
            <Link href="/dashboard/receptionist" className="text-gold hover:underline">
              AI receptionist
            </Link>{" "}
            answers a client&apos;s text — every thread lands here for you to read
            or take over.
          </p>
        ) : (
          <ul className="divide-y divide-subtle">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/dashboard/inbox/${c.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-4 transition-colors duration-150 ease-out hover:bg-charcoal-700/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-offwhite">
                      {c.clientName ?? c.phone}
                    </p>
                    {c.clientName && (
                      <p className="mt-0.5 text-xs text-muted">{c.phone}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`text-xs font-medium ${STATUS_CLASS[c.status]}`}>
                      {STATUS_LABEL[c.status]}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted/70">
                      {new Date(c.lastMessageAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
