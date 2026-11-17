import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PLATFORM_ORIGIN } from "@/lib/customDomainRouting";
import ShopPageLayout from "@/app/s/[slug]/layout";
import { loadShopPage, shopPageMetadata, shopPageTree } from "@/app/s/[slug]/shopPage";
import { domainShop, domainShopMetadata, type DomainShopProps } from "./domainShop";

/**
 * A shop's page, served on the shop's OWN domain: the middleware rewrites the
 * bare domain (and /s/...) here, with the host as the only input. A customer
 * who taps the domain in an Instagram bio stays on it.
 *
 * It is the same page as /s/[slug] (s/[slug]/shopPage.tsx), and its canonical
 * link names the getchairback.com address, so search keeps indexing the one
 * URL it always has. Its Book links stay on the domain too (./book) - see
 * lib/customDomainRouting.ts. Whose domain this is: ./domainShop.tsx.
 */

// Never cached, whatever the answer: the lookup is live, a slug can move, and
// a retry page must not outlive the moment it describes.
export const dynamic = "force-dynamic";

export async function generateMetadata(props: DomainShopProps): Promise<Metadata> {
  return domainShopMetadata(props, async (slug, domain) => shopPageMetadata(await loadShopPage(slug, domain)));
}

export default async function CustomDomainShopPage(props: DomainShopProps) {
  // Every path served here is this same page, so "/" with the query is the
  // same link again.
  const shop = await domainShop(props, "/");
  if (shop.kind === "retry") return shop.page;

  // Only if that shop OWNS this verified domain: a slug can change hands
  // between the lookup and the read.
  const data = await loadShopPage(shop.slug, shop.domain);
  if (!data) notFound();
  return (
    <ShopPageLayout>
      {shopPageTree(data, {
        // Booking is served on this domain, at its shortest address.
        bookPath: "/book",
        // "Powered by" is ChairBack's own site, which "/" is not here.
        platformOrigin: PLATFORM_ORIGIN,
      })}
    </ShopPageLayout>
  );
}
