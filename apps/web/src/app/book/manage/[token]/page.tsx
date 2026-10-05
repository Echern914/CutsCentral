import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import type { RequestedReason } from "@chairback/config/customerStatus";
import { apiPublicGet } from "@/lib/api";
import { GetTheApp } from "@/components/GetTheApp";
import { appleItunesApp } from "@/lib/appBanner";
import { ManageClient } from "./ManageClient";

/** What the page shows about a tip - see ManageData.tip. */
export type TipView =
  | {
      state: "open";
      /** 15/20/25% of the visit's price in cents; [] for an unpriced visit. */
      presets: { percent: number; cents: number }[];
      minCents: number;
      maxCents: number;
      /** When tipping closes (ISO). */
      closesAt: string;
    }
  | { state: "processing"; amountCents: number }
  | { state: "paid"; amountCents: number }
  | { state: "refunded"; amountCents: number };

export interface ManageData {
  status: "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW" | "PENDING";
  /**
   * Set only while status is PENDING: who the customer is waiting on. Optional
   * because an older API deploy does not send it - the page then still says
   * "Requested", just without naming the reason.
   */
  requested?: { reason: RequestedReason } | null;
  /**
   * A booking still waiting on its card (or payment): the SAME card step,
   * reopened, so a customer who left it can finish. Only while the hold is
   * live. Optional because an older API does not send it.
   */
  finish?: {
    kind: "setup" | "payment";
    clientSecret: string;
    amountCents: number;
    isDeposit: boolean;
    balanceDueCents: number;
    /** When the time goes back on sale. */
    expiresAt: string;
    /** Card on file: they agreed the shop may charge it for the service. */
    serviceChargeConsent: boolean;
    /** Taken on non-refundable terms. Optional = an older API. */
    nonRefundable?: boolean;
  } | null;
  /** The card never arrived before the hold ran out: this was never a booking. */
  neverBooked?: boolean;
  /**
   * The card the client asked this shop to keep for their future appointments
   * (brand and last four only), shown with the way to take it off. Optional:
   * an older API does not send it.
   */
  savedCard?: { brand: string | null; last4: string | null } | null;
  firstName: string;
  startsAt: string;
  endsAt: string;
  shop: {
    name: string;
    timezone: string;
    slug: string | null;
    /** Formatted by the API from the one formatter; null when the shop has not published one. */
    address: string | null;
    mapsUrl: string | null;
    /** The owner's note for clients ("Please arrive 10 minutes early"). Optional = older API. */
    clientNote?: string | null;
  };
  service: { name: string; durationMin: number };
  staff: { name: string };
  canCancel: boolean;
  canReschedule: boolean;
  /**
   * Non-null: cancelling keeps this much - a deposit taken on non-refundable
   * terms. The page asks before it cancels. Optional = an older API.
   */
  nonRefundable?: { amountCents: number } | null;
  /**
   * A tip after the visit (the API's services/tips.ts TipView). Null or
   * absent = no tip card: the visit is not finished, the shop does not take
   * tips online, or an older API. The server decides; the page only renders.
   */
  tip?: TipView | null;
  // A standing appointment: later visits still on the books (null = not a series).
  series: { remaining: number } | null;
  // Check-in ("On my way"). open is computed server-side (60 min before start
  // through 15 min after) so this component does no timezone math.
  checkin: {
    open: boolean;
    status: "en_route" | "arrived" | null;
    etaMinutes: number | null;
    runningLate: boolean;
  };
  // The barber's "come early" nudges for this appointment (newest first) and
  // whether the one-tap decline was already sent.
  nudges: { body: string | null; sentAt: string }[];
  nudgeReplied: boolean;
  /**
   * May this page offer Add to Apple Wallet? The API answers it, because both
   * halves live there: whether a pass can be SIGNED at all (the WALLET_APPT_*
   * env) and whether THIS appointment deserves one (BOOKED, never a PENDING
   * request). Optional because an older API deploy does not send it - the page
   * then simply shows no badge, which is the safe direction to fail.
   */
  walletPass?: { appointment: boolean } | null;
  /**
   * The customer's permission for the shop to charge their saved card for the
   * service, when they gave one - and whether they have since stopped it.
   * Optional: an older API does not send it, and the page then offers nothing.
   */
  serviceCharge?: {
    card: { brand: string | null; last4: string | null };
    withdrawnAt: string | null;
  } | null;
}

export const metadata: Metadata = {
  other: { ...appleItunesApp() },
  title: `Manage your appointment · ${APP_NAME}`,
  robots: { index: false },
};

async function getData(token: string): Promise<ManageData | null> {
  const res = await apiPublicGet<ManageData>(
    `/api/book/manage/${encodeURIComponent(token)}`,
  );
  return res.ok ? res.data : null;
}

export default async function ManagePage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams?: { tip?: string };
}) {
  const data = await getData(params.token);
  if (!data) notFound();
  // While a tip is open, "Open in ChairBack" would move a browser user - who
  // has Apple Pay here - into the app's WebView, which cannot show it.
  const tipOpen = data.tip?.state === "open";
  return (
    <>
      <ManageClient token={params.token} data={data} focusTip={searchParams?.tip === "1"} />
      {!tipOpen && (
        <div className="mx-auto w-full max-w-2xl px-4 pb-8">
          {/* openPath makes this an OPEN action as well as an install one: the
              manage token is the page's own authentication, so the in-app copy
              of this page is the same page, and app/+native-intent.tsx sends it
              to the signed-out link screen rather than asking for a login. */}
          <GetTheApp surface="manage" openPath={`/book/manage/${params.token}`} />
        </div>
      )}
    </>
  );
}
