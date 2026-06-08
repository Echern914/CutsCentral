import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Leaderboard, type Leader } from "../_components/Leaderboard";

export default async function LeaderboardPage() {
  const res = await apiGet<{ leaders: Leader[] }>("/api/dashboard/leaderboard?limit=100");
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <Link href="/dashboard" className="text-xs text-muted hover:text-offwhite">
        ← Dashboard
      </Link>
      <h1 className="mb-6 mt-1 font-display text-3xl tracking-tight">Leaderboard</h1>
      <Leaderboard leaders={res.data?.leaders ?? []} />
    </main>
  );
}
