import { runAsOwner } from "@chairback/db";
import { resolveTypedAffiliateCode } from "./affiliateAttribution.js";
import { resolvePartnerCode, type PartnerCodeError } from "./partnerProgram.js";

export type TypedReferralCode =
  | { ok: true; kind: "partner"; partnerId: string; codeUsed: string }
  | { ok: true; kind: "affiliate"; code: string }
  | { ok: true; kind: "legacy"; code: string }
  | { ok: false; error: PartnerCodeError };

/**
 * The one box on the setup form holds a code from any of our three referral
 * programs, and the person typing it can't be expected to know which. Checked
 * BEFORE the business exists, so a typo is an answer the form can show.
 *
 * Partner first, because a partner code is the only one a person chose. Short
 * affiliate codes are never minted over one, and creating a partner refuses a
 * code an affiliate already has.
 */
export async function resolveTypedReferralCode(
  raw: string,
  ownerUserId: string,
): Promise<TypedReferralCode> {
  const partner = await resolvePartnerCode(raw, ownerUserId);
  if (partner.ok) return { ok: true, kind: "partner", partnerId: partner.partnerId, codeUsed: partner.codeUsed };
  if (partner.error !== "unknown_referral_code") return partner;

  const affiliate = await resolveTypedAffiliateCode(raw, ownerUserId);
  if (affiliate) {
    return affiliate.ok ? { ok: true, kind: "affiliate", code: affiliate.code } : affiliate;
  }

  // A shop's own share code. linkReferralOnShopCreate re-reads it and voids a
  // self-referral, so all this has to establish is that it's real.
  const code = raw.trim();
  const legacy = await runAsOwner((tx) =>
    tx.shop.findUnique({ where: { referralCode: code }, select: { id: true } }),
  );
  return legacy ? { ok: true, kind: "legacy", code } : { ok: false, error: "unknown_referral_code" };
}
