import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { AffiliatesClient } from "./AffiliatesClient";

export const metadata: Metadata = { title: "Affiliates" };

/** GET /api/affiliate/status - the owner's standing, masked by the API. */
export interface AffiliateStatus {
  termsVersion: string;
  /** Whether the sign-up door is open right now (a separate kill switch). */
  applicationsOpen: boolean;
  application: {
    id: string;
    status: "PENDING" | "APPROVED" | "REJECTED";
    submittedAt: string;
    decidedAt: string | null;
    decisionReason: string | null;
    /** Derived from the fixed classification - never admin free text. */
    publicMessage: string | null;
  } | null;
  account: { code: string; status: "ACTIVE" | "SUSPENDED"; createdAt: string } | null;
}

export type ReferralStage =
  | "signed_up"
  | "first_payment"
  | "second_payment"
  | "hold"
  | "month_off"
  | "applied"
  | "reversed"
  | "expired"
  | "under_review";

/** GET /api/affiliate/overview - everything the dashboard screen renders. */
export interface AffiliateOverview {
  termsVersion: string;
  account: {
    code: string;
    status: "ACTIVE" | "SUSPENDED";
    createdAt: string;
    promotionStyles: string[];
    stylesChosenAt: string | null;
    suspensionMessage: string | null;
  };
  months: { earned: number; onTheWay: number; underReview: number; reversed: number; expired: number };
  clicks: { last7Days: number; last30Days: number; allTime: number };
  referrals: {
    id: string;
    /** "Business ••••1027" - the API never sends anything else about them. */
    label: string;
    stage: ReferralStage;
    signedUpAt: string;
    qualifyingInvoices: number;
    holdEndsAt: string | null;
    availableAt: string | null;
    expiresAt: string | null;
    reversedAt: string | null;
    reversalMessage: string | null;
  }[];
  rewards: {
    id: string;
    label: string;
    status: string;
    qualifiedAt: string;
    holdEndsAt: string;
    availableAt: string | null;
    expiresAt: string | null;
    reversedAt: string | null;
    reversalMessage: string | null;
  }[];
  policy: {
    attributionWindowDays: number;
    qualifyingInvoices: number;
    holdDays: number;
    expiryMonths: number;
  };
}

/**
 * The Affiliates tab. Four screens on one route, chosen from the API's view
 * of this owner: sign up -> waiting (or rejected) -> choose styles ->
 * dashboard. The page never decides anything the API does not already know.
 */
export default async function AffiliatesPage() {
  const [me, status] = await Promise.all([
    getMe(),
    apiGet<AffiliateStatus>("/api/affiliate/status"),
  ]);

  // Dark program: the API answers 404 before auth, the nav never showed the
  // tab, and a deep link lands on Home rather than on a dead screen.
  if (status.status === 404) redirect("/dashboard");

  if (status.status === 403) {
    return (
      <main className="mx-auto w-full max-w-xl px-5 py-16 text-center">
        <h1 className="font-display text-2xl">Only the owner can do this</h1>
        <p className="mt-2 text-sm text-muted">
          Affiliate sign-up and the affiliate link belong to the shop&rsquo;s owner
          account. Ask them to open this tab.
        </p>
        <Link href="/dashboard" className="mt-6 inline-block text-sm text-gold underline">
          Back to the dashboard
        </Link>
      </main>
    );
  }

  if (!status.ok || !status.data) {
    return (
      <main className="mx-auto w-full max-w-xl px-5 py-16 text-center">
        <h1 className="font-display text-2xl">Affiliates</h1>
        <p className="mt-2 text-sm text-muted">
          Couldn&rsquo;t load your affiliate standing right now. Try again in a moment.
        </p>
      </main>
    );
  }

  const overview = status.data.account
    ? await apiGet<AffiliateOverview>("/api/affiliate/overview")
    : null;

  return (
    <AffiliatesClient
      status={status.data}
      overview={overview?.data ?? null}
      appBase={process.env.APP_BASE_URL ?? ""}
      shopName={me.data?.activeShopName ?? "your shop"}
    />
  );
}
