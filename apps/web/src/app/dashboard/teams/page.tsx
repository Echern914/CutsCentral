import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { getVocabulary } from "@/lib/vocab";
import { TeamsClient, type MyTeamsData } from "./TeamsClient";

export const metadata: Metadata = { title: "Teams" };

/**
 * The member's side of an independent team: the shops this business is on
 * (or waiting for), what each may see, and the way out. The owner's side of
 * the same links is the independent card on /dashboard/team.
 */
export default async function TeamsPage() {
  const [res, vocab] = await Promise.all([apiGet<MyTeamsData>("/api/teams"), getVocabulary()]);

  if (!res.ok || !res.data) {
    return (
      <main className="mx-auto w-full max-w-2xl px-5 py-8">
        <h1 className="font-display text-2xl">Teams</h1>
        <p className="mt-3 text-sm text-muted">
          Couldn&apos;t load your teams right now. Refresh to try again.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <TeamsClient initial={res.data} vocab={vocab} />
    </main>
  );
}
