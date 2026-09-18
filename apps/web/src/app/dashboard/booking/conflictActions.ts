"use server";

import { apiGet, apiSend } from "@/lib/api";

/**
 * The manager conflict inbox's server actions.
 *
 * 🔴 KEEP THE BODY. The walk-in path already taught this lesson the expensive
 * way: an action that threw away the API's response body and returned a bare
 * `{ok}` is how a double-booking warning reached the server and never reached
 * the screen. Both actions here return what the API actually said, including
 * `changed`, which is the difference between "you resolved this" and "somebody
 * else already had".
 */

/** One record referenced by a conflict. No customer fields - see the API. */
export interface ConflictContext {
  id: string;
  exists: boolean;
  startsAt: string | null;
  endsAt: string | null;
  status: string | null;
}

export interface ConflictRow {
  id: string;
  kind: string;
  staffId: string;
  staffName: string | null;
  overlapStart: string;
  overlapEnd: string;
  detectedAt: string;
  source: string;
  receipt: ConflictContext;
  conflicting: ConflictContext;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
}

export interface ConflictCursor {
  detectedAt: string;
  id: string;
}

export interface ConflictPage {
  items: ConflictRow[];
  nextCursor: ConflictCursor | null;
  /** Always the OPEN count, whatever the filter - it drives the tab badge. */
  unresolvedCount: number;
}

export type ConflictStatus = "open" | "resolved" | "all";

export async function listConflictsAction(opts: {
  status?: ConflictStatus;
  cursor?: ConflictCursor | null;
  limit?: number;
}): Promise<{ ok: boolean; data?: ConflictPage; error?: string }> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", JSON.stringify(opts.cursor));
  const qs = params.toString();
  const res = await apiGet<ConflictPage>(`/api/booking-conflicts${qs ? `?${qs}` : ""}`);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

export interface ResolveResult {
  ok: boolean;
  /**
   * false = it was ALREADY resolved by someone else. The UI says so rather
   * than claiming this click did it - the audit trail names the first person,
   * and pretending otherwise would make the list lie about who handled what.
   */
  changed?: boolean;
  resolvedAt?: string | null;
  resolvedByName?: string | null;
  resolutionNote?: string | null;
  error?: string;
}

export async function resolveConflictAction(
  id: string,
  note?: string,
): Promise<ResolveResult> {
  const res = await apiSend<{
    ok: boolean;
    changed: boolean;
    resolvedAt: string | null;
    resolvedByName: string | null;
    resolutionNote: string | null;
  }>("POST", `/api/booking-conflicts/${encodeURIComponent(id)}/resolve`, {
    ...(note && note.trim() ? { note: note.trim() } : {}),
  });
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return {
    ok: true,
    changed: res.data.changed,
    resolvedAt: res.data.resolvedAt,
    resolvedByName: res.data.resolvedByName,
    resolutionNote: res.data.resolutionNote,
  };
}
