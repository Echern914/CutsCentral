import { cache } from "react";
import type { BusinessVocabulary } from "@chairback/config";
import { apiGet, type ApiResult } from "./api";

export interface Me {
  id: string;
  email: string;
  name: string;
  /** Optional profile photo; null when unset. */
  avatarUrl: string | null;
  isAdmin: boolean;
  welcomeSeen: boolean;
  /** False for social-only (Apple/Google) accounts - they SET a password rather than change one. */
  hasPassword: boolean;
  /** Which sign-in methods are linked (the account page's connected chips). */
  hasGoogle: boolean;
  hasApple: boolean;
  /** Shops this user owns (oldest first). 1 for a normal barber; >1 = manager. */
  shops: { id: string; name: string }[];
  /** The shop the dashboard is currently acting on (the switcher's selection). */
  activeShopId: string | null;
  /** Name of the active shop. Set for MEMBERS too, who own no shop of their own. */
  activeShopName?: string | null;
  /**
   * Role in the active shop. A BARBER gets the own-chair dashboard and a
   * reduced nav - no shop-wide numbers, money, or team. Optional so a web
   * deploy ahead of the API keeps the previous owner-only behavior.
   */
  shopRole?: "OWNER" | "MANAGER" | "BARBER" | null;
  /** The chair this member works, when their seat is linked to one. */
  staffId?: string | null;
  /** Whether the ACTIVE shop has rewards on - gates every rewards surface. */
  rewardsEnabled: boolean;
  /**
   * The affiliate program's platform flag. Optional so a web deploy ahead of
   * the API treats it as OFF and never shows a tab whose page would 404.
   */
  affiliateProgramEnabled?: boolean;
  /**
   * The active shop's singular visit-noun ("cut"/"twist"), already resolved
   * custom-first by the API. Optional so a web deploy ahead of the API falls
   * back to the default copy.
   */
  serviceNoun?: string;
  /**
   * The active shop's business type, resolved server-side.
   *
   * `selected: false` means nobody has chosen yet (a shop predating the picker),
   * so `vocabulary` is the NEUTRAL set — never blanks, and never barbershop
   * words the shop never asked for. Optional so a web deploy ahead of the API
   * keeps rendering the previous copy.
   */
  businessType?: {
    id: string;
    selected: boolean;
    vocabulary: BusinessVocabulary;
  } | null;
  /** Read-only public demo session (/demo/dashboard) — banner + hidden account UI. */
  demo?: boolean;
  /**
   * Dashboard appearance: "dark" (black & gold) or "light" (white & gold).
   * Optional so a web deploy ahead of the API defaults to dark.
   */
  theme?: "dark" | "light";
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
