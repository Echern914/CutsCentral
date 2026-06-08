import Link from "next/link";
import { apiGet } from "@/lib/api";
import { ActivityFeed, type ActivityItem } from "../_components/ActivityFeed";

export default async function ActivityPage() {
  const res = await apiGet<{ items: ActivityItem[] }>("/api/dashboard/activity?limit=100");
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <Link href="/dashboard" className="text-xs text-muted hover:text-offwhite">
        ← Dashboard
      </Link>
      <h1 className="mb-6 mt-1 font-display text-3xl tracking-tight">Activity</h1>
      <ActivityFeed items={res.data?.items ?? []} />
    </main>
  );
}
