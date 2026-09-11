import type { Prisma } from "@chairback/db";

/**
 * A customer turning a shop's text messages on or off, themselves.
 *
 * ONE implementation for both doors a customer has: the storefront's rewards
 * page (keyed by the magic link) and My ChairBack's notification settings
 * (keyed by a verified session). Both speak for exactly ONE client row at ONE
 * shop - consent is per shop, never copied across shops (TCPA), and never the
 * phone-wide sweep the Twilio STOP handler does.
 */

/** The customer's view of their own consent, from the fields the textability gate reads. */
export function consentView(c: {
  optedOut: boolean;
  smsConsentAt: Date | null;
  phone: string | null;
}): { state: "opted_in" | "needs_consent" | "opted_out"; hasPhone: boolean } {
  const state = c.optedOut
    ? "opted_out"
    : c.smsConsentAt !== null
      ? "opted_in"
      : "needs_consent";
  return { state, hasPhone: Boolean(c.phone) };
}

/**
 * Opt in. Grants SMS consent with the strongest possible proof (the client's
 * own action). A phone is required for textability: the one on file, else the
 * one supplied. The consent stamp is FIRST-WINS (guarded on smsConsentAt:
 * null), so a re-opt-in never overwrites an earlier source or timestamp.
 */
export async function optInClientInTx(
  tx: Prisma.TransactionClient,
  client: { id: string; phone: string | null },
  suppliedPhone: string | null,
): Promise<{ ok: true } | { error: "needs_phone" }> {
  const effectivePhone = client.phone ?? suppliedPhone;
  if (!effectivePhone) return { error: "needs_phone" };

  // Two writes, deliberately kept separate:
  //  1. Unconditional: clear any prior STOP and set the phone on first opt-in.
  //  2. Guarded (smsConsentAt: null): stamp consent FIRST-WINS, never overwrite.
  await tx.client.update({
    where: { id: client.id },
    data: {
      optedOut: false,
      // Client-initiated, so it may clear ANY opt-out incl. an SMS STOP.
      optOutSource: null,
      ...(client.phone ? {} : { phone: suppliedPhone }),
    },
  });
  await tx.client.updateMany({
    where: { id: client.id, smsConsentAt: null },
    data: { smsConsentAt: new Date(), smsConsentSource: "client_self_serve" },
  });
  return { ok: true };
}

/**
 * Opt out. PER-CLIENT only, deliberately narrower than the Twilio STOP
 * handler's phone-wide updateMany: a customer's tap speaks for one shop.
 */
export async function optOutClientInTx(
  tx: Prisma.TransactionClient,
  client: { id: string; optedOut: boolean; optOutSource: string | null },
): Promise<void> {
  await tx.client.update({
    where: { id: client.id },
    data: {
      optedOut: true,
      // Keep an existing sms_stop lock; otherwise record the self-serve opt-out.
      ...(client.optedOut && client.optOutSource === "sms_stop"
        ? {}
        : { optOutSource: "client_self_serve" }),
    },
  });
}
