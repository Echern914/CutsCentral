"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";

/**
 * OFFERS & CODES (apps/api routes/offers.ts). Making an offer sends nothing:
 * the shop shares the code itself.
 */

export type OfferKind = "AMOUNT_OFF" | "PERCENT_OFF" | "FREE_SERVICE";

export interface OfferRow {
  id: string;
  code: string;
  kind: OfferKind;
  amountOffCents: number | null;
  percentOffBps: number | null;
  freeServiceId: string | null;
  serviceIds: string[];
  staffIds: string[];
  client: { id: string; name: string } | null;
  maxUses: number | null;
  maxUsesPerClient: number | null;
  endsAt: string | null;
  active: boolean;
  note: string | null;
  uses: number;
  status: "on" | "paused" | "ended" | "used_up";
  createdAt: string;
}

export interface OffersList {
  enabled: boolean;
  canCreate: boolean;
  /** The shop's zone: an offer's last day ends at its midnight. */
  timezone?: string;
  /** What the Create offer form picks from (active only). */
  services?: { id: string; name: string; price: number | null }[];
  staff?: { id: string; name: string }[];
  /** Services this seat may make offers for; null = any. */
  allowedServiceIds: string[] | null;
  /** A provider seat's own staff id (offers it makes cover only them). */
  ownStaffId: string | null;
  offers: OfferRow[];
}

export interface OfferInput {
  code?: string;
  kind: OfferKind;
  amountOffCents?: number;
  percentOff?: number;
  freeServiceId?: string;
  serviceIds?: string[];
  staffIds?: string[];
  clientId?: string | null;
  maxUses?: number | null;
  maxUsesPerClient?: number | null;
  endsAt?: string | null;
  note?: string;
}

function messageOf(body: unknown): string | undefined {
  const m = (body as { message?: unknown } | undefined)?.message;
  return typeof m === "string" ? m : undefined;
}

export async function listOffersAction(clientId?: string): Promise<OffersList | null> {
  const res = await apiGet<OffersList>(`/api/offers${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`);
  return res.ok && res.data ? res.data : null;
}

export async function createOfferAction(
  input: OfferInput,
): Promise<{ ok: true; id: string; code: string } | { ok: false; error: string }> {
  const res = await apiSend<{ id: string; code: string }>("POST", "/api/offers", input);
  revalidatePath("/dashboard/offers");
  if (res.ok && res.data) return { ok: true, id: res.data.id, code: res.data.code };
  return {
    ok: false,
    error:
      messageOf(res.body) ??
      (res.error === "unknown_client"
        ? "That client isn't in your book any more."
        : res.status === 0
          ? "No answer from ChairBack. Check your connection, then look at your offers before making it again."
          : "Couldn't make that offer. Check the fields and try again."),
  };
}

export async function setOfferActiveAction(id: string, active: boolean): Promise<{ ok: boolean }> {
  const res = await apiSend("PATCH", `/api/offers/${encodeURIComponent(id)}`, { active });
  revalidatePath("/dashboard/offers");
  return { ok: res.ok };
}

export async function deleteOfferAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("DELETE", `/api/offers/${encodeURIComponent(id)}`);
  revalidatePath("/dashboard/offers");
  return res.ok ? { ok: true } : { ok: false, error: messageOf(res.body) ?? "Couldn't delete it." };
}

export interface OfferQuoteInput {
  code: string;
  clientId?: string;
  serviceId: string;
  staffId: string;
  startsAt: string;
  addOnIds?: string[];
  price?: number;
  special?: boolean;
  series?: boolean;
}

export type OfferQuote =
  | { ok: true; code: string; words: string; listPriceCents: number; discountCents: number; totalCents: number }
  | { ok: false; message: string };

/** The shop's booking form: what this code does to this visit, before booking. */
export async function quoteOfferAction(input: OfferQuoteInput): Promise<OfferQuote> {
  const res = await apiSend<Extract<OfferQuote, { ok: true }>>("POST", "/api/offers/quote", input);
  if (res.ok && res.data) return { ...res.data, ok: true };
  return {
    ok: false,
    message:
      messageOf(res.body) ??
      (res.status === 0 ? "No answer from ChairBack. Check your connection and try again." : "Couldn't check that code."),
  };
}
