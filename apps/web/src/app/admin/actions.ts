"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export async function setCompAccessAction(
  shopId: string,
  compAccess: boolean,
): Promise<{ ok: boolean }> {
  const res = await apiSend(`POST` as const, `/api/admin-portal/shops/${shopId}/comp`, {
    compAccess,
  });
  revalidatePath("/admin");
  return { ok: res.ok };
}
