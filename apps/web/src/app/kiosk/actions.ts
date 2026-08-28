"use server";

import { apiPublicSend } from "@/lib/api";

/**
 * Kiosk server actions. The browser cannot call the API directly (CSP
 * connect-src 'self'), so every kiosk POST proxies through here -
 * apiPublicSend never forwards the dashboard session cookie and DOES forward
 * the visitor's IP (with the proxy secret), so the per-IP kiosk limiters see
 * the tablet, not Vercel's egress.
 *
 * These are thin by design: every decision - eligibility, estimates, dedupe,
 * anti-enumeration - is the API's. Nothing here interprets, caches, or logs.
 */

export interface KioskShopData {
  shop: {
    name: string;
    logoUrl: string | null;
    accentColor: string | null;
    timezone: string;
  };
  acceptingNow: boolean;
  services: {
    id: string;
    name: string;
    description: string | null;
    durationMin: number;
    price: number | null;
    color: string | null;
  }[];
  staff: { id: string; name: string; imageUrl: string | null }[];
  offerings: { serviceId: string; staffId: string }[];
  consent: { text: string; version: string };
}

export async function kioskResolveAction(token: string) {
  return apiPublicSend<KioskShopData>("POST", "/api/walk-in/kiosk/resolve", {
    token,
  });
}

export async function kioskEstimateAction(input: {
  token: string;
  serviceIds: string[];
  preferredStaffId: string | null;
}) {
  return apiPublicSend<{ ok: true; waitMin: number | null; ahead: number }>(
    "POST",
    "/api/walk-in/kiosk/estimate",
    input,
  );
}

export async function kioskChallengeAction(input: {
  token: string;
  phone: string;
}) {
  return apiPublicSend<{ ok: true }>(
    "POST",
    "/api/walk-in/kiosk/challenge",
    input,
  );
}

export async function kioskVerifyAction(input: {
  token: string;
  phone: string;
  code: string;
}) {
  return apiPublicSend<{
    ok: true;
    verified: boolean;
    proof?: string;
    known?: boolean;
    firstName?: string | null;
  }>("POST", "/api/walk-in/kiosk/verify", input);
}

export async function kioskCheckInAction(input: {
  token: string;
  proof: string;
  phone: string;
  firstName?: string;
  lastName?: string;
  serviceIds: string[];
  preferredStaffId: string | null;
  smsConsent: boolean;
}) {
  return apiPublicSend<{ ok: true }>(
    "POST",
    "/api/walk-in/kiosk/check-in",
    input,
  );
}
