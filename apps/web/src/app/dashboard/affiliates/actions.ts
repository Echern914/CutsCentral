"use server";

import { apiSend } from "@/lib/api";
import { AFFILIATE_TERMS_VERSION } from "@chairback/config/affiliateProgram";
import { getShopQrAction, type ShopQr } from "@/app/dashboard/booking/qrActions";

/**
 * The Affiliates tab's writes. Thin on purpose: every rule lives in the API
 * (the fixed vocabularies, the terms version, the one-account-per-shop CAS),
 * so a stale page is refused by the server rather than out-argued here.
 */

export type ActionResult = { ok: true } | { ok: false; error: string; status: number };

function failed(res: { error?: string; status: number }): ActionResult {
  return { ok: false, error: res.error ?? "failed", status: res.status };
}

/** Sign up. The terms version is re-stated from config so a page rendered
 *  before a terms bump is refused (`terms_not_accepted`) instead of quietly
 *  accepting an older text. */
export async function applyAffiliateAction(input: {
  promotionChannels: string[];
  audienceDescription: string;
  links: string[];
  promotionPlan: string;
}): Promise<ActionResult> {
  const res = await apiSend("POST", "/api/affiliate/application", {
    termsVersion: AFFILIATE_TERMS_VERSION,
    termsAccepted: true,
    ftcAccepted: true,
    ...input,
  });
  return res.ok ? { ok: true } : failed(res);
}

/** Choose or change how they promote. */
export async function setAffiliateStylesAction(styles: string[]): Promise<ActionResult> {
  const res = await apiSend("PUT", "/api/affiliate/styles", { styles });
  return res.ok ? { ok: true } : failed(res);
}

/** The affiliate link as a QR - the same server-side renderer as the
 *  booking QR (high error correction; it ends up on flyers). */
export async function getAffiliateQrAction(
  url: string,
): Promise<{ ok: true; qr: ShopQr } | { ok: false; error: string }> {
  return getShopQrAction(url);
}
