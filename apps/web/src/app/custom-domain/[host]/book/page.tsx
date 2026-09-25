import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveCustomDomain } from "@/lib/customDomain";
import { PLATFORM_ORIGIN } from "@/lib/customDomainRouting";
import BookPage, { generateMetadata as bookPageMetadata } from "@/app/book/[slug]/page";

/**
 * Booking on the shop's own domain: drickcuttinup.com/book and the page's own
 * /book/<slug> links land here. The slug in that path is not read - the
 * booking belongs to whichever shop the verified domain resolves to.
 *
 * Same page as /book/[slug]. Staying on one origin matters beyond looks: a
 * redirect-based payment method returns to window.location, and that return
 * has to land on the page that started the payment.
 */

interface Props {
  params: { host: string };
  searchParams?: { service?: string; staff?: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = await resolveCustomDomain(params.host);
  return slug ? bookPageMetadata({ params: { slug } }) : {};
}

export default async function CustomDomainBookPage({ params, searchParams }: Props) {
  const slug = await resolveCustomDomain(params.host);
  if (!slug) redirect(PLATFORM_ORIGIN);
  return <BookPage params={{ slug }} searchParams={searchParams} />;
}
