"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export async function setRequestStatusAction(
  id: string,
  status: "NEW" | "CONTACTED" | "CLOSED",
): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/requests/${id}`, { status });
  revalidatePath("/dashboard/requests");
  return { ok: res.ok };
}
