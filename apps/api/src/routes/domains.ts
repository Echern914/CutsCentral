import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireActiveAccess } from "../middleware/billing.js";
import {
  attachDomain,
  detachDomain,
  domainStatus,
  vercelDomainsConfigured,
  verifyDomain,
  type VercelDomainStatus,
} from "../services/vercelDomains.js";
import {
  VERCEL_APEX_A,
  VERCEL_WWW_CNAME,
  lookupDomainDns,
  ownershipRecord,
  provesOwnershipAndPointsHere,
  type DomainDnsReport,
} from "../services/dnsLookup.js";

/**
 * A shop's custom domain (REDIRECT model): the owner's own domain becomes a
 * clean pointer to getchairback.com/s/[slug]. Google indexes and shows the
 * ChairBack URL - that is the deliberate SEO choice, not a limitation - so
 * nothing here touches canonicals or per-host rendering. The web middleware
 * does the actual redirecting; these routes manage the domain's lifecycle:
 *
 *   connect -> we attach apex + www to the Vercel project, mint an ownership
 *   token, and hand back THREE DNS records -> the owner sets them at their
 *   registrar -> "check again" resolves them from our side -> verified, and
 *   only then does the domain start landing on their page.
 *
 * 🔴 VERIFIED IS THE GATE. Until `customDomainVerifiedAt` is stamped, the
 * public by-domain resolver refuses the domain and nobody is redirected. It is
 * stamped only when the ownership TXT record (on `@`, or the older
 * `_chairback` host) resolves with THIS shop's token and the apex A record
 * points at Vercel. Before this, the redirect was
 * live on insert, and nothing proved the claimant controlled the domain -
 * Vercel's "verified" only means "not on another Vercel account", and its
 * "configured" means "some A record points at us", which is the REAL owner's
 * record. So a domain whose owner had pointed DNS here by following our own
 * instructions could be claimed by any other shop and hijacked.
 *
 * While the Vercel env seam is unset (VERCEL_DOMAINS_TOKEN/PROJECT_ID), the
 * whole feature reports available:false and the dashboard says email support.
 */

export const domainsRouter: Router = Router();

type DnsRecord = { type: "A" | "CNAME" | "TXT"; name: string; value: string };

/**
 * The records an owner sets at their registrar. Vercel's anycast A record and
 * CNAME target are stable, documented values - not per-project. The TXT
 * ownership record is per SHOP: it carries the token minted on connect, and it
 * is the only one of the three that proves anything.
 */
function dnsRecordsFor(domain: string | null, token: string | null): DnsRecord[] {
  const records: DnsRecord[] = [
    { type: "A", name: "@", value: VERCEL_APEX_A },
    { type: "CNAME", name: "www", value: VERCEL_WWW_CNAME },
  ];
  if (domain && token) {
    const txt = ownershipRecord(token);
    records.push({ type: "TXT", name: txt.name, value: txt.value });
  }
  return records;
}

/**
 * Normalize what an owner pastes into a bare apex host: strip scheme, path,
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

/**
 * Our own hosts, and our hosting providers', can never be a shop's custom
 * domain. The Railway entries are hygiene: attaching one to the Vercel project
 * would do nothing useful, but a claim on the API's own hostname sitting in
 * this table would be confusing evidence in an incident.
 */
function isReservedDomain(host: string): boolean {
  return (
    host === "getchairback.com" ||
    host.endsWith(".getchairback.com") ||
    host.endsWith(".vercel.app") ||
    host.endsWith(".vercel-dns.com") ||
    host.endsWith(".railway.app")
  );
}

interface ShopDomainSlice {
  id: string;
  customDomain: string | null;
  customDomainVerifiedAt: Date | null;
  customDomainVerifyToken: string | null;
}

/**
 * A connected row written before the ownership token existed has no TXT
 * record to show. Mint one on first sight, so the owner sees all three records
 * without reconnecting. Idempotent: a row that has a token keeps it, because
 * the token is what they may already have published.
 */
async function ensureVerifyToken(shop: ShopDomainSlice): Promise<string | null> {
  if (!shop.customDomain) return null;
  if (shop.customDomainVerifyToken) return shop.customDomainVerifyToken;
  const token = randomToken(18);
  await prisma.shop.update({
    where: { id: shop.id },
    data: { customDomainVerifyToken: token },
  });
  return token;
}

function serializeStatus(
  shop: {
    customDomain: string | null;
    customDomainVerifiedAt: Date | null;
    customDomainVerifyToken: string | null;
  },
  live: VercelDomainStatus | null,
  dns: DomainDnsReport | null,
) {
  return {
    available: vercelDomainsConfigured(),
    domain: shop.customDomain,
    verifiedAt: shop.customDomainVerifiedAt?.toISOString() ?? null,
    records: dnsRecordsFor(shop.customDomain, shop.customDomainVerifyToken),
    // What OUR lookup saw, per record - the thing that turns "waiting on DNS"
    // into "your A record points at 203.0.113.9". Null when not looked up.
    dns,
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
domainsRouter.get("/", requireUser, requireShop, requireActiveAccess, async (req, res) => {
  const shop = req.shop!;
  const token = await ensureVerifyToken(shop);
  const [live, dns] = await Promise.all([
    shop.customDomain && vercelDomainsConfigured() ? domainStatus(shop.customDomain) : null,
    // A page load on an unfinished setup shows the diagnosis straight away;
    // a verified domain has nothing left to diagnose.
    shop.customDomain && !shop.customDomainVerifiedAt
      ? lookupDomainDns(shop.customDomain, token)
      : null,
  ]);
  res.json(
    serializeStatus(
      {
        customDomain: shop.customDomain,
        customDomainVerifiedAt: shop.customDomainVerifiedAt,
        customDomainVerifyToken: token,
      },
      live,
      dns,
    ),
  );
});

const connectSchema = z.object({ domain: z.string().min(4).max(300) }).strict();

// Connect (or replace) the shop's domain: attach apex + www on Vercel, mint the
// ownership token, store, and return the three DNS records to set.
domainsRouter.post("/", requireUser, requireShop, requireActiveAccess, async (req, res) => {
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
  // the owner sees the error now rather than a domain stuck "pending" forever.
  const attached = await attachDomain(domain);
  if (!attached.ok) {
    res.status(502).json({ error: "vercel_attach_failed", code: attached.error });
    return;
  }
  await attachDomain(`www.${domain}`); // best-effort; apex is the one that matters

  // A NEW token on every connect, even a reconnect of the same name. The old
  // one may be sitting in a zone this shop no longer controls; proof has to be
  // fresh to be proof.
  const token = randomToken(18);
  try {
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        customDomain: domain,
        customDomainVerifiedAt: null,
        customDomainVerifyToken: token,
      },
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
  res.status(201).json(
    serializeStatus(
      { customDomain: domain, customDomainVerifiedAt: null, customDomainVerifyToken: token },
      live,
      // Nothing to diagnose yet: they have not been shown the records until
      // this response, so every lookup would say "missing".
      null,
    ),
  );
});

// Re-check DNS + ownership now ("I've added them - check again" button).
//
// 🔴 THE STAMP COMES FROM OUR OWN LOOKUP, NOT FROM VERCEL. Vercel is asked to
// re-check too, because its side has to be green before it will serve the
// host at all - but `verifiedAt` is written only when the TXT record carries
// this shop's token and the apex points here. That is the ownership proof,
// and it is the one thing Vercel's status can never tell us.
domainsRouter.post("/verify", requireUser, requireShop, requireActiveAccess, async (req, res) => {
  const shop = req.shop!;
  if (!shop.customDomain) {
    res.status(404).json({ error: "no_domain" });
    return;
  }
  if (!vercelDomainsConfigured()) {
    res.status(503).json({ error: "domains_not_configured" });
    return;
  }
  const token = await ensureVerifyToken(shop);
  await verifyDomain(shop.customDomain);
  const [live, dns] = await Promise.all([
    domainStatus(shop.customDomain),
    lookupDomainDns(shop.customDomain, token),
  ]);

  let verifiedAt = shop.customDomainVerifiedAt;
  if (!verifiedAt && provesOwnershipAndPointsHere(dns)) {
    verifiedAt = new Date();
    await prisma.shop.update({
      where: { id: shop.id },
      data: { customDomainVerifiedAt: verifiedAt },
    });
  }
  res.json(
    serializeStatus(
      {
        customDomain: shop.customDomain,
        customDomainVerifiedAt: verifiedAt,
        customDomainVerifyToken: token,
      },
      live,
      dns,
    ),
  );
});

// Disconnect: detach from Vercel (best-effort) and clear the columns. The
// domain simply stops resolving to us; nothing else about the shop changes.
// The records are returned one last time so the dashboard can tell the owner
// exactly what to remove at their registrar.
domainsRouter.delete("/", requireUser, requireShop, requireActiveAccess, async (req, res) => {
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
    data: {
      customDomain: null,
      customDomainVerifiedAt: null,
      // The token dies with the connection: a reconnect mints a fresh one.
      customDomainVerifyToken: null,
    },
  });
  res.json({
    ...serializeStatus(
      { customDomain: null, customDomainVerifiedAt: null, customDomainVerifyToken: null },
      null,
      null,
    ),
    // What they published, so they can take it down.
    removed: {
      domain: shop.customDomain,
      records: dnsRecordsFor(shop.customDomain, shop.customDomainVerifyToken),
    },
  });
});
