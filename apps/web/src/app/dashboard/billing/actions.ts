"use server";

import { redirect } from "next/navigation";
import { apiSend } from "@/lib/api";

export async function checkoutAction(): Promise<{ error?: string }> {
  const res = await apiSend<{ url: string }>("POST", "/api/billing/checkout");
  if (res.ok && res.data?.url) redirect(res.data.url); // Stripe-hosted Checkout
  return {
    error:
      res.error === "billing_disabled"
        ? "Billing isn't switched on yet. Everything is free during early access."
        : res.error === "already_subscribed"
          ? "You're already subscribed."
          : "Could not start checkout. Try again in a moment.",
  };
}

export async function portalAction(): Promise<{ error?: string }> {
  const res = await apiSend<{ url: string }>("POST", "/api/billing/portal");
  if (res.ok && res.data?.url) redirect(res.data.url); // Stripe-hosted portal
  return { error: "Could not open the billing portal. Try again in a moment." };
}
