import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import {
  attachDomain,
  detachDomain,
  domainStatus,
  vercelDomainsConfigured,
  verifyDomain,
  type VercelDomainStatus,
} from "../services/vercelDomains.js";

/**
 * A shop's custom domain (REDIRECT model): the barber's own domain becomes a
 * clean pointer to getchairback.com/s/[slug]. Google indexes and shows the
 * ChairBack URL - that is the deliberate SEO choice, not a limitation - so
 * nothing here touches canonicals or per-host rendering. The web middleware
 * does the actual redirecting; these routes manage the domain's lifecycle:
 *
 *   connect -> we attach apex + www to the Vercel project and hand back the
 *   DNS records -> barber sets them at their registrar -> refresh/verify ->
 *   verified, and the domain starts landing on their page.
 *
 * While the Vercel env seam is unset (VERCEL_DOMAINS_TOKEN/PROJECT_ID), the
 * whole feature reports available:false and the dashboard says email support.
 */

export const domainsRouter: Router = Router();

/**
 * The records a barber sets at their registrar. Vercel's anycast A record and
 * CNAME target are stable, documented values - not per-project. The TXT
 * ownership challenge (only demanded when a domain is claimed by another
 * Vercel account) is appended from live status when present.
 */
const DNS_RECORDS = [
  { type: "A", name: "@", value: "76.76.21.21" },
  { type: "CNAME", name: "www", value: "cname.vercel-dns.com" },
] as const;

/**
 * Normalize what a barber pastes into a bare apex host: strip scheme, path,
 * port, query, leading www., trailing dot; lowercase. Returns null when what
 * remains is not a plausible registrable domain.
 */
export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  host = host.replace(/[/?#].*$/, ""); // path/query/fragment
  host = host.replace(/:\d+$/, ""); // port
  host = host.replace(/\.$/, ""); // trailing dot
  host = host.replace(/^www\./, ""); // we attach www ourselves
  // Label.label(.label)* with a 2+ char alpha TLD; total length per RFC.
  if (host.length > 253) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) return null;
  return host;
}

/** Our own domains can never be a shop's custom domain. */
function isReservedDomain(host: string): boolean {
  return (
    host === "getchairback.com" ||
    host.endsWith(".getchairback.com") ||
    host.endsWith(".vercel.app") ||
    host.endsWith(".vercel-dns.com")
  );
}

function serializeStatus(
  shop: { customDomain: string | null; customDomainVerifiedAt: Date | null },
  live: VercelDomainStatus | null,
) {
  return {
    available: vercelDomainsConfigured(),
    domain: shop.customDomain,
    verifiedAt: shop.customDomainVerifiedAt?.toISOString() ?? null,
    records: DNS_RECORDS,
    // Live Vercel view; null = unknown (unconfigured seam or Vercel error).
    // The dashboard renders null as "status unavailable", never as failure.
    vercel: live
      ? {
          verified: live.verified,
          misconfigured: live.misconfigured,
          verification: live.verification,
        }
      : null,
  };
}

// Current domain + live DNS/verification status.
domainsRouter.get("/", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const live =
    shop.customDomain && vercelDomainsConfigured()
      ? await domainStatus(shop.customDomain)
      : null;
  res.json(serializeStatus(shop, live));
});

const connectSchema = z.object({ domain: z.string().min(4).max(300) }).strict();

// Connect (or replace) the shop's domain: attach apex + www on Vercel, store,
// and return the DNS records to set at the registrar.
domainsRouter.post("/", requireUser, requireShop, async (req, res) => {
  if (!vercelDomainsConfigured()) {
    res.status(503).json({ error: "domains_not_configured" });
    return;
  }
  const parsed = connectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const domain = normalizeDomain(parsed.data.domain);
  if (!domain) {
    res.status(400).json({ error: "invalid_domain" });
    return;
  }
  if (isReservedDomain(domain)) {
    res.status(400).json({ error: "reserved_domain" });
    return;
  }

  const shop = req.shop!;
  const previous = shop.customDomain;

  // Refuse a domain another shop already owns BEFORE any Vercel call. The
  // unique index below is the real guarantee (this read races); this check
  // exists so the common case never touches the other shop's live attachment.
  const holder = await prisma.shop.findUnique({
    where: { customDomain: domain },
    select: { id: true },
  });
  if (holder && holder.id !== shop.id) {
    res.status(409).json({ error: "domain_taken" });
    return;
  }

  // Attach BEFORE persisting: if Vercel hard-rejects, nothing is stored and
  // the barber sees the error now rather than a domain stuck "pending" forever.
  const attached = await attachDomain(domain);
  if (!attached.ok) {
    res.status(502).json({ error: "vercel_attach_failed", code: attached.error });
    return;
  }
  await attachDomain(`www.${domain}`); // best-effort; apex is the one that matters

  try {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { customDomain: domain, customDomainVerifiedAt: null },
    });
  } catch (err) {
    // Unique violation = another shop won the race for this domain (the
    // pre-check above already handled the common sequential case). Detach
    // NOTHING here: this used to "clean up" by detaching, which took down the
    // OTHER shop's live domain - the attachment on the project is either the
    // winner's (working, must not be touched) or, at worst, an orphan that
    // serves nothing and costs nothing. Safety beats tidiness.
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "domain_taken" });
      return;
    }
    throw err;
  }

  // Replacing a previous domain: clean the old attachment up (best-effort).
  if (previous && previous !== domain) {
    await detachDomain(previous);
    await detachDomain(`www.${previous}`);
  }

  const live = await domainStatus(domain);
  res
    .status(201)
    .json(serializeStatus({ customDomain: domain, customDomainVerifiedAt: null }, live));
});

// Re-check DNS + ownership now ("I've added the records" button). Stamps
// verifiedAt the first time Vercel reports verified AND correctly configured.
domainsRouter.post("/verify", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  if (!shop.customDomain) {
    res.status(404).json({ error: "no_domain" });
    return;
  }
  if (!vercelDomainsConfigured()) {
    res.status(503).json({ error: "domains_not_configured" });
    return;
  }
  await verifyDomain(shop.customDomain);
  const live = await domainStatus(shop.customDomain);
  let verifiedAt = shop.customDomainVerifiedAt;
  if (live && live.verified && !live.misconfigured && !verifiedAt) {
    verifiedAt = new Date();
    await prisma.shop.update({
      where: { id: shop.id },
      data: { customDomainVerifiedAt: verifiedAt },
    });
  }
  res.json(
    serializeStatus(
      { customDomain: shop.customDomain, customDomainVerifiedAt: verifiedAt },
      live,
    ),
  );
});

// Disconnect: detach from Vercel (best-effort) and clear the columns. The
// domain simply stops resolving to us; nothing else about the shop changes.
domainsRouter.delete("/", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  if (!shop.customDomain) {
    res.status(404).json({ error: "no_domain" });
    return;
  }
  if (vercelDomainsConfigured()) {
    await detachDomain(shop.customDomain);
    await detachDomain(`www.${shop.customDomain}`);
  }
  await prisma.shop.update({
    where: { id: shop.id },
    data: { customDomain: null, customDomainVerifiedAt: null },
  });
  res.json(serializeStatus({ customDomain: null, customDomainVerifiedAt: null }, null));
});
