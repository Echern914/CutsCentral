"use server";

import { apiPublicSend } from "@/lib/api";

/** "My Place in Line" server actions - thin proxies, secrets in POST bodies
 * only (CSP keeps the browser off the API directly). */

export interface LineStatus {
  ok: true;
  shopName: string;
  status: string;
  services: { name: string; durationMin: number }[];
  barberName: string | null;
  barberIsAssigned: boolean;
  ahead: number | null;
  waitMin: number | null;
  startsAt: string | null;
  acceptingNow: boolean;
  updatedAt: string;
}

export async function lineExchangeAction(token: string) {
  return apiPublicSend<{ ok: true; session: string }>(
    "POST",
    "/api/walk-in/track/exchange",
    { token },
  );
}

export async function lineStatusAction(session: string) {
  return apiPublicSend<LineStatus>("POST", "/api/walk-in/track/status", {
    session,
  });
}

export async function lineLeaveAction(session: string) {
  return apiPublicSend<{ ok: true; status: string }>(
    "POST",
    "/api/walk-in/track/leave",
    { session },
  );
}
