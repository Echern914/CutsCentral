"use server";

import { apiSend } from "@/lib/api";

/**
 * Close a status notice's banner for this person - on every device, since it
 * is stored on the account. Best-effort: a failure only means the banner
 * shows again on the next page load.
 */
export async function dismissPlatformNoticeAction(id: string): Promise<void> {
  await apiSend("POST", `/api/platform-notices/${encodeURIComponent(id)}/dismiss`);
}
