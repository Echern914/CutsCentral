/**
 * The lock booleans drilled into client components (MoreSheet, FeatureSearch,
 * page panels). Client-safe on purpose: no server imports, so "use client"
 * files can import the type and helper without dragging next/headers into the
 * bundle. The DERIVATION lives server-side in lib/billing.ts.
 *
 * `premium` — the shop's access has lapsed (post-trial Free): every
 * Premium-tier feature renders locked.
 * `premiumAi` — additionally, no receptionist entitlement: Premium-AI-tier
 * features render locked too.
 *
 * Both false = no diamonds anywhere. That is the state for: trialing shops,
 * subscribed shops, comped shops, billing-disabled installs, demo, employee
 * seats (403 on /api/billing), and any fetch failure. Locks are an upsell,
 * not an enforcement layer — the API enforces; rendering none on doubt is
 * always safe.
 */
export interface FeatureLocks {
  premium: boolean;
  premiumAi: boolean;
}

export const NO_LOCKS: FeatureLocks = { premium: false, premiumAi: false };

/**
 * Which badge (if any) a feature with `tier` shows under `locks`.
 * null = no badge — either the feature is untiered or the shop has it.
 */
export function lockedTier(
  tier: "pro" | "pro_ai" | undefined,
  locks: FeatureLocks | undefined,
): "pro" | "pro_ai" | null {
  if (!tier || !locks) return null;
  if (tier === "pro") return locks.premium ? "pro" : null;
  return locks.premiumAi ? "pro_ai" : null;
}
