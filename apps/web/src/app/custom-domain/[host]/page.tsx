import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveCustomDomain } from "@/lib/customDomain";
import { PLATFORM_ORIGIN } from "@/lib/customDomainRouting";
import ShopPageLayout from "@/app/s/[slug]/layout";
import PublicShopPage, { generateMetadata as shopPageMetadata } from "@/app/s/[slug]/page";

/**
 * A shop's page, served on the shop's OWN domain: drickcuttinup.com/ is
 * rewritten here by the middleware, with the host as the only input. Which
 * shop renders comes from the verified domain row and nothing else - see
 * lib/customDomainRouting.ts for why the path never gets a say.
 *
 * It is the SAME page as /s/[slug], one component at two addresses, and that
 * page's canonical link names the getchairback.com address - so search keeps
 * indexing the one URL it always has, while the visitor stays on the barber's
 * domain instead of being bounced off it.
 */

interface Props {
  params: { host: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = await resolveCustomDomain(params.host);
  return slug ? shopPageMetadata({ params: { slug } }) : {};
}

export default async function CustomDomainShopPage({ params }: Props) {
  const slug = await resolveCustomDomain(params.host);
  // Unknown, unverified, disconnected or switched off: nothing of anyone's is
  // served under this name. Temporary, because a domain mid-setup starts
  // working the moment its owner's DNS is proven.
  if (!slug) redirect(PLATFORM_ORIGIN);
  return (
    <ShopPageLayout>
      <PublicShopPage params={{ slug }} />
    </ShopPageLayout>
  );
}
