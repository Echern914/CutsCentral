"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";

/**
 * Custom-domain lifecycle actions. Thin cookie-forwarding wrappers over
 * /api/domains — the API owns validation, Vercel calls, and persistence.
 * Kept separate from savePageAction on purpose: the domain flow is a stateful
 * connect → set DNS → verify sequence, not a form field, so it must never ride
 * (or dirty) the page editor's diff-save.
 */

export interface DomainStatus {
  /** False = the Vercel env seam is unset; the card says "email support". */
  available: boolean;
  domain: string | null;
  verifiedAt: string | null;
  records: readonly { type: string; name: string; value: string }[];
  vercel: {
    verified: boolean;
    misconfigured: boolean;
    verification: { type: string; domain: string; value: string }[];
  } | null;
}

export interface DomainActionResult {
  ok: boolean;
  status?: DomainStatus;
  error?: string;
}

const ERROR_COPY: Record<string, string> = {
  invalid_domain: "That doesn't look like a domain. Enter it like drickcuttinup.com.",
  reserved_domain: "That domain can't be connected.",
  domain_taken: "That domain is already connected to another shop.",
  vercel_attach_failed: "We couldn't attach that domain. Try again in a minute.",
  domains_not_configured:
    "Domain connections aren't switched on yet — email support@getchairback.com.",
};

function toResult(res: {
  ok: boolean;
  data?: DomainStatus | null;
  error?: string;
}): DomainActionResult {
  if (res.ok && res.data) return { ok: true, status: res.data };
  return {
    ok: false,
    error: ERROR_COPY[res.error ?? ""] ?? "Something went wrong. Try again.",
  };
}

export async function getDomainStatusAction(): Promise<DomainActionResult> {
  return toResult(await apiGet<DomainStatus>("/api/domains"));
}

export async function connectDomainAction(domain: string): Promise<DomainActionResult> {
  const res = toResult(await apiSend<DomainStatus>("POST", "/api/domains", { domain }));
  revalidatePath("/dashboard/site");
  return res;
}

export async function verifyDomainAction(): Promise<DomainActionResult> {
  const res = toResult(await apiSend<DomainStatus>("POST", "/api/domains/verify"));
  revalidatePath("/dashboard/site");
  return res;
}

export async function removeDomainAction(): Promise<DomainActionResult> {
  const res = toResult(await apiSend<DomainStatus>("DELETE", "/api/domains"));
  revalidatePath("/dashboard/site");
  return res;
}
