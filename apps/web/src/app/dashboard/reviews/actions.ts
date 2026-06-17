"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export async function setReviewStatusAction(
  id: string,
  status: "APPROVED" | "HIDDEN" | "PENDING",
): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/reviews/${id}`, { status });
  revalidatePath("/dashboard/reviews");
  return { ok: res.ok };
}
