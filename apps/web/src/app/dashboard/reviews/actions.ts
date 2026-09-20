"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export async function setReviewStatusAction(
  id: string,
  status: "APPROVED" | "HIDDEN" | "PENDING",
): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/reviews/${id}`, { status });
  revalidatePath("/dashboard/reviews");
  // 🔴 THE LAYOUT TOO, or the badge keeps the number it was rendered with.
  // The header bell reads `pendingCount` in the dashboard LAYOUT, and the
  // client router cache holds a rendered layout across navigations - so
  // revalidating only this page leaves a barber who has just approved
  // everything staring at a bell that still says there are reviews to approve.
  // "layout" clears every route under /dashboard, which is exactly the set
  // that renders the bell.
  revalidatePath("/dashboard", "layout");
  return { ok: res.ok };
}
