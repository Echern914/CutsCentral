import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { ManageClient } from "./ManageClient";

export interface ManageData {
  status: "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  firstName: string;
  startsAt: string;
  endsAt: string;
  shop: { name: string; timezone: string; slug: string | null };
  service: { name: string; durationMin: number };
  staff: { name: string };
  canCancel: boolean;
  canReschedule: boolean;
}

export const metadata: Metadata = {
  title: `Manage your appointment · ${APP_NAME}`,
  robots: { index: false },
};

async function getData(token: string): Promise<ManageData | null> {
  const res = await apiPublicGet<ManageData>(
    `/api/book/manage/${encodeURIComponent(token)}`,
  );
  return res.ok ? res.data : null;
}

export default async function ManagePage({
  params,
}: {
  params: { token: string };
}) {
  const data = await getData(params.token);
  if (!data) notFound();
  return <ManageClient token={params.token} data={data} />;
}
