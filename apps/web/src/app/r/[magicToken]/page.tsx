import { MOBILE_APP } from "@chairback/config/constants";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME, serviceNounForShop } from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { ShopPageClient } from "@/app/s/[slug]/ShopPageClient";
import type { ShopPageData } from "@/app/s/[slug]/page";
import { RewardsClient } from "./RewardsClient";
import type { RewardsData } from "./rewards/page";

/**
 * What a client sees when they open their link.
 *
 * This used to be the rewards page, with a "More from {shop} →" link buried at
 * the bottom. That had it backwards: the punch card is the thing you check
 * occasionally, and the shop - photos, services, reviews, and the Book button -
 * is the thing you actually came for. So the shop's page is the landing surface
 * and rewards moved to /r/<token>/rewards, one tap away.
 *
 * It renders here rather than redirecting to /s/<slug> because the magic token
 * IS the client's identity. Bouncing to the anonymous shop page would drop it,
 * and there'd be no way back to their punches without re-opening the text.
 *
 * Every existing /r/<token> link - four SMS templates, the wallet pass, push
 * notifications, the iOS customer WebView - therefore keeps working and simply
 * lands somewhere better.
 */

const REWARDS_REVALIDATE_S = 10;
const SHOP_PAGE_REVALIDATE_S = 60;

async function getRewards(magicToken: string): Promise<RewardsData | null> {
  const res = await apiPublicGet<RewardsData>(
    `/api/rewards/${magicToken}`,
    REWARDS_REVALIDATE_S,
  );
  return res.ok ? res.data : null;
}

async function getShopPage(slug: string): Promise<ShopPageData | null> {
  const res = await apiPublicGet<ShopPageData>(
    `/api/page/${encodeURIComponent(slug)}`,
    SHOP_PAGE_REVALIDATE_S,
  );
  return res.ok ? res.data : null;
}

export async function generateMetadata({
  params,
}: {
  params: { magicToken: string };
}): Promise<Metadata> {
  const data = await getRewards(params.magicToken);
  if (!data) return { title: APP_NAME };
  const shopPage = data.shop.pageSlug ? await getShopPage(data.shop.pageSlug) : null;
  const description =
    shopPage?.bio ??
    `Book your next ${serviceNounForShop(shopPage ?? { industry: "barber" })} at ${data.shop.name}.`;
  return {
    title: data.shop.name,
    description,
    openGraph: { title: data.shop.name, description, type: "website" },
    twitter: { card: "summary", title: data.shop.name, description },
    // Per-shop installable PWA, unchanged: the home-screen app is branded for
    // THIS shop and now opens on the shop page like every other entry point.
    manifest: `/r/${params.magicToken}/manifest.webmanifest`,
    appleWebApp: { capable: true, title: data.shop.name, statusBarStyle: "default" },
    icons: { apple: [{ url: "/apple-touch-icon-180.png", sizes: "180x180" }] },
    // The URL contains a client's identity token — never index it.
    robots: { index: false, follow: false },
  };
}

export default async function ClientLandingPage({
  params,
}: {
  params: { magicToken: string };
}) {
  const data = await getRewards(params.magicToken);
  if (!data) notFound();

  // A shop with no public page (no slug yet, or the page turned off) has no
  // shop surface to land on. Rather than strand the client on an empty screen,
  // fall back to exactly what this URL did before: their rewards.
  const shopPage = data.shop.pageSlug ? await getShopPage(data.shop.pageSlug) : null;
  if (!shopPage) {
    const vapidPublicKey = process.env.PUSH_VAPID_PUBLIC_KEY ?? null;
    return (
      <RewardsClient
        data={data}
        magicToken={params.magicToken}
        vapidPublicKey={vapidPublicKey}
        appStoreUrl={MOBILE_APP.appStoreUrl}
        playStoreUrl={null}
      />
    );
  }

  return (
    <ShopPageClient
      data={shopPage}
      // Turns the shop page into the client's OWN view of the shop: it gains a
      // rewards entry pointing back into their token. Anonymous visitors on
      // /s/<slug> pass nothing here and see no such link.
      rewardsHref={`/r/${params.magicToken}/rewards`}
      rewardsLabel={
        // Lead with the number when they have one - "4 punches" is a reason to
        // tap; "Your rewards" is just a label.
        data.shop.rewardsEnabled === false
          ? "Your visits"
          : data.punches.balance > 0
            ? `Your rewards · ${data.punches.balance} ${data.punches.balance === 1 ? "punch" : "punches"}`
            : "Your rewards"
      }
    />
  );
}
