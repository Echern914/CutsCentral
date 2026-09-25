import type { Metadata } from "next";
import { getVocabulary } from "@/lib/vocab";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { ReferralShare, type ReferralRow } from "./ReferralShare";
import { PartnerEarnings, type PartnerMe } from "./PartnerEarnings";

export const metadata: Metadata = { title: "Refer a {vocab.providerNoun}" };

interface ReferralData {
  code: string | null;
  referrals: ReferralRow[];
  earnedMonths: number;
  pendingCount: number;
  rewardDays: number;
}

export default async function ReferralsPage() {
  const vocab = await getVocabulary();
  // A partner (someone ChairBack pays for bringing businesses in) sees their
  // earnings here too. 404 for everyone else, and then nothing renders.
  const [res, partner] = await Promise.all([
    apiGet<ReferralData>("/api/dashboard/referrals"),
    apiGet<PartnerMe>("/api/partner/me"),
  ]);
  const data = res.data;
  const appBase = process.env.APP_BASE_URL ?? "";

  // A partner with no business here (or only a seat in someone else's) has no
  // shop link to share: this page is just their earnings. The shop-referral
  // copy and its "isn't ready yet" fallback are for owners, and would only
  // mislead them.
  if (partner.data && !data) {
    return (
      <main className="mx-auto w-full max-w-2xl px-5 py-8">
        <h1 className="mb-6 mt-1 font-display text-3xl tracking-tight">Your earnings</h1>
        <PartnerEarnings me={partner.data} />
        {res.status === 404 ? (
          <p className="text-sm text-muted">
            Run a business yourself?{" "}
            <Link href="/onboarding" className="text-gold hover:underline">
              Set it up
            </Link>
            .
          </p>
        ) : null}
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <Link
        href="/dashboard"
        className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
      >
        ← Dashboard
      </Link>
      <h1 className="mb-1 mt-1 font-display text-3xl tracking-tight">
        Refer a {vocab.providerNoun}
      </h1>
      <p className="mb-6 text-sm text-muted">
        Send your link. They get an extra month free, and you get a free month
        once they&rsquo;re a paying shop.
      </p>

      {partner.data ? <PartnerEarnings me={partner.data} /> : null}

      {data?.code ? (
        <ReferralShare
          appBase={appBase}
          code={data.code}
          rows={data.referrals}
          earnedMonths={data.earnedMonths}
          pendingCount={data.pendingCount}
          rewardDays={data.rewardDays}
        />
      ) : (
        <p className="rounded-2xl border border-subtle bg-charcoal-800 px-5 py-6 text-sm text-muted">
          Your referral link isn&rsquo;t ready yet. Refresh in a moment — if it
          keeps happening, get in touch from the{" "}
          <Link href="/support" className="text-gold hover:underline">
            help page
          </Link>
          .
        </p>
      )}
    </main>
  );
}
