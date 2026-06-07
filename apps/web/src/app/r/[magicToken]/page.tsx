import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { RewardsClient } from "./RewardsClient";

export interface RewardsData {
  shop: {
    name: string;
    bookingUrl: string;
    rewardLabel: string;
    rewardThreshold: number;
  };
  client: { firstName: string | null };
  punches: {
    balance: number;
    threshold: number;
    towardNext: number;
    rewardsUnlocked: number;
  };
  visits: { date: string; service: string | null }[];
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
  const title = `${data.shop.name} — Your Rewards`;
  const description = `${data.punches.towardNext}/${data.punches.threshold} punches toward your ${data.shop.rewardLabel}.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function RewardsPage({
  params,
}: {
  params: { magicToken: string };
}) {
  const data = await getData(params.magicToken);
  if (!data) notFound();
  return <RewardsClient data={data} />;
}
