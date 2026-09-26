import { redirect } from "next/navigation";
import { resolveCustomDomain } from "@/lib/customDomain";
import { PLATFORM_ORIGIN } from "@/lib/customDomainRouting";
import GroupBookPage, { metadata as groupBookMetadata } from "@/app/book/[slug]/group/page";

/**
 * "Booking for 2 or 3 people?" on the shop's own domain - the single booking
 * page links here as /book/<slug>/group. The shop is the domain's, as on
 * every custom-domain page.
 */

export const metadata = groupBookMetadata;

export default async function CustomDomainGroupBookPage({ params }: { params: { host: string } }) {
  const slug = await resolveCustomDomain(params.host);
  if (!slug) redirect(PLATFORM_ORIGIN);
  return <GroupBookPage params={{ slug }} />;
}
