"use server";

import { apiPublicSend } from "@/lib/api";

/**
 * Rewards-recovery server actions - thin proxies, exactly like the kiosk's.
 * Every decision (constancy, ceilings, consent, eligibility) is the API's;
 * nothing here interprets, caches or logs. apiPublicSend forwards the
 * visitor's IP with the proxy secret, so the per-IP recovery limiters see the
 * customer's device, not Vercel's egress.
 */

export interface RecoveryShop {
  selectionId: string;
  name: string;
  logoUrl: string | null;
  industry: string;
  city: string | null;
  region: string | null;
}

export async function recoveryChallengeAction(phone: string) {
  return apiPublicSend<{ ok: true }>("POST", "/api/rewards-recovery/challenge", { phone });
}

export async function recoveryVerifyAction(phone: string, code: string) {
  return apiPublicSend<{ verified: boolean; proof?: string }>(
    "POST",
    "/api/rewards-recovery/verify",
    { phone, code },
  );
}

export async function recoveryShopsAction(proof: string) {
  return apiPublicSend<{ shops: RecoveryShop[] }>("POST", "/api/rewards-recovery/shops", {
    proof,
  });
}

export async function recoverySelectAction(proof: string, selectionId: string) {
  return apiPublicSend<{ ok: true; url: string }>("POST", "/api/rewards-recovery/select", {
    proof,
    selectionId,
  });
}
