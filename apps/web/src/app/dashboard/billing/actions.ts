"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export async function checkoutAction(
  tier: "pro" | "pro_ai" = "pro",
): Promise<{ error?: string }> {
  const res = await apiSend<{ url: string }>("POST", "/api/billing/checkout", {
    tier,
  });
  if (res.ok && res.data?.url) redirect(res.data.url); // Stripe-hosted Checkout
  return {
    error:
      res.error === "billing_disabled"
        ? "Billing isn't switched on yet. Everything is free during early access."
        : res.error === "premium_ai_unavailable"
          ? "Premium AI isn't available quite yet. Check back soon."
          : res.error === "already_subscribed"
            ? "You're already subscribed."
            : "Could not start checkout. Try again in a moment.",
  };
}

/** In-place Premium -> Premium AI upgrade (Stripe price swap, prorated). */
export async function upgradeAction(): Promise<{ error?: string }> {
  const res = await apiSend<{ ok: boolean }>("POST", "/api/billing/upgrade");
  if (res.ok) redirect("/dashboard/billing?upgrade=success");
  return {
    error:
      res.error === "already_entitled"
        ? "You already have the AI receptionist."
        : res.error === "no_subscription"
          ? "No active subscription to upgrade - start a Premium AI checkout instead."
          : res.error === "premium_ai_unavailable"
            ? "Premium AI isn't available quite yet. Check back soon."
            : "Could not upgrade. Try again in a moment.",
  };
}

/** Hosted Checkout for the $40/mo receptionist add-on (Premium shops). */
export async function receptionistCheckoutAction(): Promise<{ error?: string }> {
  const res = await apiSend<{ url: string }>(
    "POST",
    "/api/billing/receptionist/checkout",
  );
  if (res.ok && res.data?.url) redirect(res.data.url);
  return {
    error:
      res.error === "already_subscribed" || res.error === "already_entitled"
        ? "You already have the AI receptionist."
        : "Could not start checkout. Try again in a moment.",
  };
}

/**
 * Enable/disable the AI receptionist. First enable must carry the liability
 * acknowledgment (acceptTerms) - the API rejects enabling without it.
 */
export async function enableReceptionistAction(input: {
  enable: boolean;
  acceptTerms?: boolean;
}): Promise<{ error?: string }> {
  const res = await apiSend("PATCH", "/api/shops/me", {
    receptionistEnabled: input.enable,
    ...(input.acceptTerms ? { acceptReceptionistTerms: true } : {}),
  });
  if (res.ok) {
    revalidatePath("/dashboard/billing");
    return {};
  }
  return {
    error:
      res.error === "receptionist_terms_required"
        ? "Please check the acknowledgment box first."
        : "Could not update the receptionist. Try again in a moment.",
  };
}

export async function portalAction(): Promise<{ error?: string }> {
  const res = await apiSend<{ url: string }>("POST", "/api/billing/portal");
  if (res.ok && res.data?.url) redirect(res.data.url); // Stripe-hosted portal
  return { error: "Could not open the billing portal. Try again in a moment." };
}

/**
 * Cancel membership: opens the Stripe portal DEEP-LINKED to the cancel flow,
 * where Stripe handles the confirmation, proration, and cancellation email.
 * (Requires cancellation enabled in the Stripe portal settings.)
 */
export async function cancelAction(): Promise<{ error?: string }> {
  const res = await apiSend<{ url: string }>("POST", "/api/billing/portal", {
    flow: "cancel",
  });
  if (res.ok && res.data?.url) redirect(res.data.url);
  return {
    error:
      res.error === "no_billing_account"
        ? "No active membership to cancel."
        : "Could not open the cancellation page. Try again in a moment.",
  };
}
