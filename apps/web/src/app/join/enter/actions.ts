"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AFFILIATE_CLAIM_COOKIE,
  normalizeAffiliateCode,
} from "@chairback/config";
import { apiPublicSend } from "@/lib/api";

export interface JoinState {
  error?: string;
}

/**
 * Manual referral-code entry: the cross-device path.
 *
 * Someone who saw a code on their phone and is signing up on a laptop has no
 * cookie to carry, so they type the code here. A valid one mints the same
 * signed claim the link would have, and overwrites any claim already parked -
 * an explicit code the person typed beats a passive one they picked up.
 *
 * The failure message is deliberately one sentence for every cause (unknown,
 * suspended, malformed): this form must not become a way to test which codes
 * exist.
 */
export async function submitReferralCodeAction(
  _prev: JoinState,
  formData: FormData,
): Promise<JoinState> {
  const code = normalizeAffiliateCode(formData.get("code"));
  const generic = { error: "That referral code isn't valid. Check it and try again." };
  if (!code) return generic;

  const res = await apiPublicSend<{ claim: string | null; maxAgeSeconds: number }>(
    "POST",
    "/api/affiliate/claim",
    { code, source: "explicit_code" },
  );
  if (res.status === 404) return generic; // program dark
  const claim = res.data?.claim;
  if (typeof claim !== "string" || claim.length === 0) return generic;

  cookies().set(AFFILIATE_CLAIM_COOKIE, claim, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: res.data?.maxAgeSeconds ?? 0,
  });
  redirect("/signup");
}
