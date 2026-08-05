import type { Metadata } from "next";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { ReferralShare, type ReferralRow } from "./ReferralShare";

export const metadata: Metadata = { title: "Refer a barber" };

interface ReferralData {
  code: string | null;
  referrals: ReferralRow[];
  earnedMonths: number;
  pendingCount: number;
  rewardDays: number;
}

export default async function ReferralsPage() {
  const res = await apiGet<ReferralData>("/api/dashboard/referrals");
  const data = res.data;
  const appBase = process.env.APP_BASE_URL ?? "";

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <Link
        href="/dashboard"
        className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
      >
        ← Dashboard
      </Link>
      <h1 className="mb-1 mt-1 font-display text-3xl tracking-tight">
        Refer a barber
      </h1>
      <p className="mb-6 text-sm text-muted">
        Send your link. They get an extra month free, and you get a free month
        once they&rsquo;re a paying shop.
      </p>

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
