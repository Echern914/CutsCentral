import type { PlatformNoticeSeverity } from "@chairback/config/platformNotices";
import { apiGet } from "./api";

/**
 * A platform status notice ("we know about it and we're fixing it"), as
 * GET /api/platform-notices returns it (apps/api services/platformNotices.ts).
 * Only live or just-fixed notices ever arrive here.
 */
export interface PlatformNotice {
  id: string;
  title: string;
  body: string;
  severity: PlatformNoticeSeverity;
  /** "resolved" = fixed within the last few hours: the banner says Fixed. */
  state: "active" | "resolved";
  startsAt: string;
  endsAt: string | null;
  resolvedAt: string | null;
  /** This person closed its banner. The bell still lists it. */
  dismissed: boolean;
}

/**
 * What the dashboard chrome shows. FAILS QUIET, always: an older API (404), a
 * network blip or a malformed answer all mean "no notices", never a broken
 * dashboard. Server-only (it forwards the session cookie).
 */
export async function getPlatformNotices(): Promise<PlatformNotice[]> {
  try {
    const res = await apiGet<{ notices?: PlatformNotice[] }>("/api/platform-notices");
    const list = res.ok ? res.data?.notices : null;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
