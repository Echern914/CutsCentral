import { cache } from "react";
import { apiGet, type ApiResult } from "./api";

export interface Me {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  welcomeSeen: boolean;
  /** False for social-only (Apple/Google) accounts - they SET a password rather than change one. */
  hasPassword: boolean;
  /** Shops this user owns (oldest first). 1 for a normal barber; >1 = manager. */
  shops: { id: string; name: string }[];
  /** The shop the dashboard is currently acting on (the switcher's selection). */
  activeShopId: string | null;
  /** Whether the ACTIVE shop has rewards on - gates every rewards surface. */
  rewardsEnabled: boolean;
}

/**
 * The current barber's identity. Wrapped in React `cache()` so the call is
 * memoized for the lifetime of a single server render: the dashboard layout
 * needs `isAdmin` (and the 401 -> /login gate) while the overview page needs
 * `name`/`email`/`welcomeSeen`, and both used to fire their own /api/auth/me
 * round-trip. Now they share ONE. The memo is per-request (cache() does not
 * persist across renders), so it never leaks one barber's identity into
 * another's request - safe for our multi-tenant model.
 */
export const getMe = cache((): Promise<ApiResult<Me>> => apiGet<Me>("/api/auth/me"));
