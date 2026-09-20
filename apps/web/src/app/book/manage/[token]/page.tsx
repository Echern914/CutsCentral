import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import type { RequestedReason } from "@chairback/config/customerStatus";
import { apiPublicGet } from "@/lib/api";
import { GetTheApp } from "@/components/GetTheApp";
import { appleItunesApp } from "@/lib/appBanner";
import { ManageClient } from "./ManageClient";

export interface ManageData {
  status: "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW" | "PENDING";
  /**
   * Set only while status is PENDING: who the customer is waiting on. Optional
   * because an older API deploy does not send it - the page then still says
   * "Requested", just without naming the reason.
   */
  requested?: { reason: RequestedReason } | null;
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
  };
  service: { name: string; durationMin: number };
  staff: { name: string };
  canCancel: boolean;
  canReschedule: boolean;
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
}: {
  params: { token: string };
}) {
  const data = await getData(params.token);
  if (!data) notFound();
  return (
    <>
      <ManageClient token={params.token} data={data} />
      <div className="mx-auto w-full max-w-2xl px-4 pb-8">
        {/* openPath makes this an OPEN action as well as an install one: the
            manage token is the page's own authentication, so the in-app copy
            of this page is the same page, and app/+native-intent.tsx sends it
            to the signed-out link screen rather than asking for a login. */}
        <GetTheApp surface="manage" openPath={`/book/manage/${params.token}`} />
      </div>
    </>
  );
}
