import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * Vercel Domains API client, for attaching a barber's own domain to the WEB
 * project so Vercel serves it (and issues TLS). Pointing DNS at Vercel is NOT
 * enough on its own - an unattached domain 404s - so this attach step is what
 * makes a customer domain actually resolve.
 *
 * OPTIONAL-ENV SEAM (same pattern as Square/Stripe): while the token or
 * project id is unset, isConfigured() is false, the dashboard says "email
 * support", and nothing here is ever called. The routes treat every failure
 * here as "status unknown", never as a crash.
 *
 * [VERIFY LIVE] Response shapes are parsed defensively: Vercel's domain
 * endpoints have several versions (v6/v9/v10) and the docs drift. Every read
 * below tolerates missing fields.
 */

const API = "https://api.vercel.com";

export interface VercelVerificationChallenge {
  type: string; // "TXT" in practice
  domain: string; // where to put the record (e.g. _vercel.example.com)
  value: string;
}

export interface VercelDomainStatus {
  /** Vercel accepted ownership (TXT challenge passed or never needed). */
  verified: boolean;
  /** DNS does not yet point at Vercel (A/CNAME missing or wrong). */
  misconfigured: boolean;
  /** Outstanding ownership challenges the barber must add at their registrar. */
  verification: VercelVerificationChallenge[];
}

function config(): { token: string; projectId: string; teamQs: string } | null {
  const env = apiEnv();
  if (!env.VERCEL_DOMAINS_TOKEN || !env.VERCEL_DOMAINS_PROJECT_ID) return null;
  const teamQs = env.VERCEL_DOMAINS_TEAM_ID
    ? `?teamId=${encodeURIComponent(env.VERCEL_DOMAINS_TEAM_ID)}`
    : "";
  return {
    token: env.VERCEL_DOMAINS_TOKEN,
    projectId: env.VERCEL_DOMAINS_PROJECT_ID,
    teamQs,
  };
}

/** False = the whole custom-domain feature is dark (dashboard says so). */
export function vercelDomainsConfigured(): boolean {
  return config() !== null;
}

async function vercelFetch(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const cfg = config();
  if (!cfg) throw new Error("vercel domains not configured");
  const res = await fetch(`${API}${path}${cfg.teamQs}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some DELETEs return an empty body - status alone is enough there.
  }
  return { status: res.status, json };
}

/** Defensive read of Vercel's verification[] challenge list. */
function readChallenges(raw: unknown): VercelVerificationChallenge[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c): VercelVerificationChallenge | null => {
      if (!c || typeof c !== "object") return null;
      const o = c as Record<string, unknown>;
      if (typeof o.domain !== "string" || typeof o.value !== "string") return null;
      return {
        type: typeof o.type === "string" ? o.type : "TXT",
        domain: o.domain,
        value: o.value,
      };
    })
    .filter((c): c is VercelVerificationChallenge => c !== null);
}

/**
 * Attach a domain to the project. 409/"already exists" counts as success -
 * re-connecting after a partial earlier attempt must be idempotent, and the
 * error code Vercel uses for it has changed across API versions.
 */
export async function attachDomain(domain: string): Promise<{ ok: boolean; error?: string }> {
  const { status, json } = await vercelFetch(
    `/v10/projects/${encodeURIComponent(config()!.projectId)}/domains`,
    { method: "POST", body: { name: domain } },
  );
  if (status === 200 || status === 409) return { ok: true };
  const err = json.error as Record<string, unknown> | undefined;
  const code = typeof err?.code === "string" ? err.code : `http_${status}`;
  if (code === "domain_already_in_use_by_project" || code === "domain_already_in_use") {
    // In use by THIS project = fine; by another Vercel account = the TXT
    // ownership challenge surfaces on the status read, so still not fatal here.
    return { ok: true };
  }
  logger.warn({ domain, status, code }, "vercel domain attach failed");
  return { ok: false, error: code };
}

/** Live status: ownership verification + whether DNS actually points at us. */
export async function domainStatus(domain: string): Promise<VercelDomainStatus | null> {
  try {
    const projectId = encodeURIComponent(config()!.projectId);
    const enc = encodeURIComponent(domain);
    const [proj, cfgRes] = await Promise.all([
      vercelFetch(`/v9/projects/${projectId}/domains/${enc}`),
      vercelFetch(`/v6/domains/${enc}/config`),
    ]);
    if (proj.status === 404) return null; // not attached (yet)
    return {
      verified: proj.json.verified === true,
      // Missing field reads as "misconfigured" - never claim green falsely.
      misconfigured: cfgRes.json.misconfigured !== false,
      verification: readChallenges(proj.json.verification),
    };
  } catch (err) {
    logger.warn({ err, domain }, "vercel domain status check failed");
    return null;
  }
}

/** Ask Vercel to re-check the ownership challenge now (barber added the TXT). */
export async function verifyDomain(domain: string): Promise<void> {
  const projectId = encodeURIComponent(config()!.projectId);
  await vercelFetch(
    `/v9/projects/${projectId}/domains/${encodeURIComponent(domain)}/verify`,
    { method: "POST" },
  ).catch((err: unknown) => {
    logger.warn({ err, domain }, "vercel domain verify call failed");
  });
}

/** Detach on disconnect. Best-effort: a 404 means it was already gone. */
export async function detachDomain(domain: string): Promise<void> {
  const projectId = encodeURIComponent(config()!.projectId);
  await vercelFetch(
    `/v9/projects/${projectId}/domains/${encodeURIComponent(domain)}`,
    { method: "DELETE" },
  ).catch((err: unknown) => {
    logger.warn({ err, domain }, "vercel domain detach failed");
  });
}
