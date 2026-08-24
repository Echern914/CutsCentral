import type { Metadata } from "next";
import { apiPublicGet } from "@/lib/api";
import { ClaimOffer, type OfferView } from "./ClaimOffer";

/**
 * Where the "we're holding this slot for you" email/push lands.
 *
 * 🔑 THE LINK REVEALS, THE BUTTON BOOKS. A GET never claims anything (email
 * scanners open every link), and the held time is shown ONLY when the token
 * is valid and unexpired - a dead link gets one generic message that carries
 * nobody's data, no matter whether the token was wrong, lapsed, released or
 * already used.
 *
 * The token is the credential, so the page is deliberately noindex. Fetched
 * UNCACHED: a hold's remaining minutes are the whole point of the page.
 */
export const metadata: Metadata = {
  title: "Your held spot",
  robots: { index: false, follow: false },
};

interface OfferPayload {
  ok: boolean;
  shop: { name: string; slug: string | null; timezone: string };
  serviceName: string | null;
  staffName: string | null;
  startsAt: string;
  endsAt: string;
  expiresAt: string;
  approvalRequired: boolean;
  firstName: string;
  email: string | null;
}

export default async function WaitlistOfferPage({
  params,
}: {
  params: { token: string };
}) {
  const res = await apiPublicGet<OfferPayload>(
    `/api/book/offer/${encodeURIComponent(params.token)}`,
  );
  const offer: OfferView | null =
    res.ok && res.data
      ? {
          shopName: res.data.shop.name,
          timezone: res.data.shop.timezone,
          serviceName: res.data.serviceName,
          staffName: res.data.staffName,
          startsAt: res.data.startsAt,
          expiresAt: res.data.expiresAt,
          approvalRequired: Boolean(res.data.approvalRequired),
          firstName: res.data.firstName,
          email: res.data.email,
        }
      : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
      <ClaimOffer token={params.token} offer={offer} />
    </main>
  );
}
