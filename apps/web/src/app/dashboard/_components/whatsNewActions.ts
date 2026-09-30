"use server";

import { apiSend } from "@/lib/api";

/**
 * The bell was opened: this person has now seen `id` (the newest entry) and
 * everything below it. Stored on the account, so it clears on every device.
 * Best-effort - a failure only means the "new" dot shows once more.
 */
export async function markWhatsNewSeenAction(id: string): Promise<void> {
  await apiSend("POST", "/api/auth/whats-new-seen", { id });
}
