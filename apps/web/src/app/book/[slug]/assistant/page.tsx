import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { apiPublicGet } from "@/lib/api";
import { servesThisVisit, visitDomain } from "@/lib/customDomainVisit";
import { AssistantChat } from "./AssistantChat";

export const dynamic = "force-dynamic";

/**
 * The booking chat for one shop: a menu of buttons, plus typed shortcuts the
 * server's rules read. 404 unless the API says it is on
 * (ASSISTANT_CHAT_ENABLED) - nothing about it is reachable while that switch
 * is off, and the booking page shows no door to it.
 */
export default async function AssistantPage({ params }: { params: { slug: string } }) {
  const status = await apiPublicGet<{ enabled: boolean }>(
    `/api/assistant-chat/c/${encodeURIComponent(params.slug)}/status`,
  );
  if (!status.ok || !status.data?.enabled) notFound();
  // On a shop's own domain the page is read fresh, and must be that domain's
  // shop (lib/customDomainVisit.ts): a cached copy from before the domain was
  // verified would turn its own clients away.
  const onDomain = visitDomain() !== null;
  const page = await apiPublicGet<{ shop?: { name?: string }; name?: string; customDomain?: string | null }>(
    `/api/page/${encodeURIComponent(params.slug)}`,
    onDomain ? undefined : 60,
  );
  if (onDomain && !servesThisVisit(page.ok ? page.data : null)) notFound();
  const shopName = page.data?.shop?.name ?? page.data?.name ?? "this shop";
  const signedIn = Boolean(cookies().get("cb_customer")?.value);
  return <AssistantChat slug={params.slug} shopName={shopName} signedIn={signedIn} />;
}
