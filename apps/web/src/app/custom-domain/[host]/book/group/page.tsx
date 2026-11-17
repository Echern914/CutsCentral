import type { Metadata } from "next";
import BookLayout from "@/app/book/[slug]/layout";
import GroupBookPage, { metadata as groupMetadata } from "@/app/book/[slug]/group/page";
import { domainShop, domainShopMetadata, type DomainShopProps } from "../../domainShop";

/**
 * Booking 2 or 3 people, on the shop's own domain (/book/<slug>/group there;
 * the slug is never read). The same page as /book/[slug]/group, which refuses
 * any shop that does not own this domain - see ../page.tsx.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(props: DomainShopProps): Promise<Metadata> {
  return domainShopMetadata(props, async () => groupMetadata);
}

export default async function CustomDomainGroupBookPage(props: DomainShopProps) {
  const shop = await domainShop(props, "/book");
  if (shop.kind === "retry") return shop.page;
  const params = { slug: shop.slug };
  const page = await GroupBookPage({ params });
  return BookLayout({ params, children: page });
}
