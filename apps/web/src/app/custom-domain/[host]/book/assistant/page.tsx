import BookLayout from "@/app/book/[slug]/layout";
import AssistantPage from "@/app/book/[slug]/assistant/page";
import { domainShop, type DomainShopProps } from "../../domainShop";

/**
 * The booking chat, on the shop's own domain (/book/<slug>/assistant there;
 * the slug is never read). The same page as /book/[slug]/assistant, which
 * refuses any shop that does not own this domain - see ../page.tsx.
 */

export const dynamic = "force-dynamic";

export default async function CustomDomainAssistantPage(props: DomainShopProps) {
  const shop = await domainShop(props, "/book");
  if (shop.kind === "retry") return shop.page;
  const params = { slug: shop.slug };
  const page = await AssistantPage({ params });
  return BookLayout({ params, children: page });
}
