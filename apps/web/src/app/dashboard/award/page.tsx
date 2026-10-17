import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { getVocabulary } from "@/lib/vocab";
import { awardTitle } from "@chairback/config/providerAward";
import { Card } from "@/components/ui/Card";
import { ApplyForAward } from "./ApplyForAward";
import type { AwardMe } from "./actions";

export const metadata: Metadata = { title: "Provider of the Month" };

/**
 * PROVIDER OF THE MONTH - the shop owner applies with the stats they choose
 * and a few words; ChairBack picks the winner, whose page then shows it.
 */
export default async function AwardPage() {
  const [me, vocab] = await Promise.all([getMe(), getVocabulary()]);
  const title = awardTitle(vocab.providerNoun);
  if (me.data?.shopRole && me.data.shopRole !== "OWNER") {
    return (
      <main className="mx-auto w-full max-w-2xl px-5 py-8">
        <h1 className="font-display text-3xl tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">The shop&apos;s owner applies, from their own account.</p>
      </main>
    );
  }
  const res = await apiGet<AwardMe>("/api/awards/me");
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load this page. Try again in a moment.</main>;
  }
  const d = res.data;
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted">
          Each month ChairBack picks a {vocab.providerNoun} to celebrate. The winner&apos;s page shows it to every
          client who opens it, with how they won and why, through the month after. Apply with the numbers you&apos;re
          proud of and a few words about you.
        </p>
      </header>

      {d.won.length > 0 && (
        <div className="mb-6 flex flex-col gap-3">
          {d.won.map((w) => (
            <Card key={w.month} className="border-gold/40 p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-gold">
                🏆 {w.title} · {w.monthLabel}
              </p>
              <p className="mt-1 text-sm font-semibold text-offwhite">{w.headline}</p>
              <p className="mt-1 whitespace-pre-line text-sm text-offwhite/80">{w.description}</p>
            </Card>
          ))}
        </div>
      )}

      <ApplyForAward me={d} />
    </main>
  );
}
