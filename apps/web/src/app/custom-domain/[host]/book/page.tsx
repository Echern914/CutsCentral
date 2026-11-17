import type { Metadata } from "next";
import BookLayout from "@/app/book/[slug]/layout";
import BookPage, { generateMetadata as bookPageMetadata } from "@/app/book/[slug]/page";
import { domainShop, domainShopMetadata, type DomainShopProps } from "../domainShop";

/**
 * BOOKING, ON THE SHOP'S OWN DOMAIN - drickcuttinup.com/book, and any
 * /book/<slug> there (the slug is never read: the host picks the shop).
 *
 * The same page as /book/[slug], handed the shop the domain lookup names. That
 * page itself refuses any shop that does not own the domain this request is
 * on (lib/customDomainVisit.ts), so a slug that changed hands between the
 * lookup and the read fails closed there. Until 2026-11 this address
 * redirected to getchairback.com/book/<slug>; see lib/customDomainRouting.ts
 * for what booking here costs a returning client (once) and why Apple Pay
 * still shows.
 */

// Never cached: the lookup is live, and a slug can move.
export const dynamic = "force-dynamic";

type BookSearchParams = Parameters<typeof BookPage>[0]["searchParams"];

export async function generateMetadata(props: DomainShopProps): Promise<Metadata> {
  return domainShopMetadata(props, (slug) =>
    bookPageMetadata({ params: { slug }, searchParams: props.searchParams as BookSearchParams }),
  );
}

export default async function CustomDomainBookPage(props: DomainShopProps) {
  const shop = await domainShop(props, "/book");
  if (shop.kind === "retry") return shop.page;
  const params = { slug: shop.slug };
  // Called, not rendered as elements: the booking page's own redirects and
  // not-founds must happen here, before anything of it is drawn.
  const page = await BookPage({ params, searchParams: props.searchParams as BookSearchParams });
  return BookLayout({ params, children: page });
}
