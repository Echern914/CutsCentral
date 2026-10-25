import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { apiPublicGet } from "@/lib/api";
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
  const page = await apiPublicGet<{ shop?: { name?: string }; name?: string }>(`/api/page/${encodeURIComponent(params.slug)}`, 60);
  const shopName = page.data?.shop?.name ?? page.data?.name ?? "this shop";
  const signedIn = Boolean(cookies().get("cb_customer")?.value);
  return <AssistantChat slug={params.slug} shopName={shopName} signedIn={signedIn} />;
}
