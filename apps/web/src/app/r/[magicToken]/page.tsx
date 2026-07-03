import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME, type CadenceKey } from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { RewardsClient } from "./RewardsClient";

export interface RewardsData {
  shop: {
    name: string;
    bookingUrl: string | null;
    logoUrl: string | null;
    accentColor: string | null;
    // The barber's page identity (PAGE_THEMES / PAGE_FONTS / LAYOUT_STYLES keys).
    // The rewards page renders in these so it matches the shop's public mini-site.
    theme: string | null;
    fontKey: string | null;
    layoutStyle: string | null;
    // Content control set by the barber: an optional welcome line and the list of
    // visible REWARDS_SECTIONS keys (always non-empty from the API; defaults to all).
    rewardsWelcome: string | null;
    rewardsSections: string[];
    pageSlug: string | null;
  };
  client: { firstName: string | null };
  // Apple Wallet punch card: available once the API's WALLET_* env is set.
  // Optional so a web deploy ahead of the API doesn't break the page.
  wallet?: { available: boolean };
  // Self-reported visit cadence. `preference` is null until the client answers
  // the one-tap prompt; `computed` is true once there's enough visit history for
  // the engine to derive a cadence (after which the prompt is moot).
  cadence: {
    preference: CadenceKey | null;
    computed: boolean;
  };
  // Loyalty status tier by lifetime completed visits. `tier` is null below the
  // first threshold; `nextTier` shows how many visits to the next one (or to the
  // first tier for a brand-new client), and is null once the top tier is reached.
  loyalty: {
    tier: "BRONZE" | "SILVER" | "GOLD" | null;
    label: string | null;
    color: string | null;
    visits: number;
    nextTier: { label: string; visitsAway: number } | null;
  };
  consent: {
    state: "opted_in" | "needs_consent" | "opted_out";
    hasPhone: boolean;
  };
  punches: {
    balance: number;
    nextTarget: { name: string; punchCost: number; remaining: number } | null;
  };
  rewards: {
    id: string;
    name: string;
    description: string | null;
    emoji: string | null;
    punchCost: number;
    ready: boolean;
    remaining: number;
  }[];
  promotions: {
    id: string;
    kind: "PERCENT_OFF" | "AMOUNT_OFF" | "FREE_ADDON" | "EXTRA_PUNCHES";
    title: string;
    description: string | null;
    code: string | null;
    percentOff: number | null;
    amountOff: number | null;
    extraPunches: number | null;
    endsAt: string | null;
  }[];
  rebook: {
    state: "booked" | "counting" | "overdue" | "none";
    deadline: string | null;
    windowDays: number;
    upcomingAt: string | null;
  };
  visits: { date: string; service: string | null; punches: number | null }[];
  redemptions: { date: string; reward: string | null; punches: number }[];
}

async function getData(magicToken: string): Promise<RewardsData | null> {
  const res = await apiPublicGet<RewardsData>(`/api/rewards/${magicToken}`);
  return res.ok ? res.data : null;
}

export async function generateMetadata({
  params,
}: {
  params: { magicToken: string };
}): Promise<Metadata> {
  const data = await getData(params.magicToken);
  if (!data) return { title: APP_NAME };
  const title = `${data.shop.name} Rewards`;
  const ready = data.rewards.filter((r) => r.ready).length;
  const description = ready > 0
    ? `${ready} reward${ready === 1 ? "" : "s"} ready to claim at ${data.shop.name}.`
    : data.punches.nextTarget
      ? `${data.punches.nextTarget.remaining} punches to your ${data.punches.nextTarget.name}.`
      : `${data.punches.balance} punches at ${data.shop.name}.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
    // Per-shop installable PWA: the manifest is generated per magicToken so the
    // home-screen app is branded for THIS shop (name + theme color).
    manifest: `/r/${params.magicToken}/manifest.webmanifest`,
    // iOS ignores parts of the manifest, so set the Apple bits explicitly: a
    // capable web app, the shop name as the title, and a PNG touch icon (iOS
    // ignores SVG apple icons).
    appleWebApp: {
      capable: true,
      title: data.shop.name,
      statusBarStyle: "default",
    },
    icons: { apple: [{ url: "/apple-touch-icon-180.png", sizes: "180x180" }] },
  };
}

export default async function RewardsPage({
  params,
}: {
  params: { magicToken: string };
}) {
  const data = await getData(params.magicToken);
  if (!data) notFound();
  // VAPID public key (safe to expose - it's a PUBLIC key) threaded to the client
  // so the push opt-in can subscribe. Absent => the push UI stays hidden and
  // everything falls back to SMS.
  const vapidPublicKey = process.env.PUSH_VAPID_PUBLIC_KEY ?? null;
  // Store links for the "Get the app" banner. Absent => banner never shows, so
  // this is safe to ship before the app is live (set APP_STORE_URL to turn on).
  const appStoreUrl = process.env.APP_STORE_URL ?? null;
  const playStoreUrl = process.env.PLAY_STORE_URL ?? null;
  return (
    <RewardsClient
      data={data}
      magicToken={params.magicToken}
      vapidPublicKey={vapidPublicKey}
      appStoreUrl={appStoreUrl}
      playStoreUrl={playStoreUrl}
    />
  );
}
