import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { connectEnabled, stripeClient } from "./stripe.js";

/**
 * Register this deployment's web domains with Stripe so wallet payment methods
 * — Apple Pay above all — actually render in the Payment Element.
 *
 * 🔴 WHY THIS IS CODE AND NOT A DASHBOARD CHECKBOX. Apple Pay does not fail
 * loudly when a domain is unregistered: Stripe simply omits the tab. The
 * checkout still works, the customer pays by card, and nobody ever files a bug
 * — the feature is just quietly absent for everyone on iPhone. That is the
 * exact shape of the four integrations that sat dark for months (see
 * ops/bootReport.ts). A registration that re-asserts itself every boot cannot
 * drift, cannot be forgotten on a new environment, and cannot be undone by
 * someone tidying the dashboard.
 *
 * 🔴 PLATFORM ACCOUNT, NO `Stripe-Account` HEADER. Per Stripe's Connect rules
 * for domain registration: direct charges register per connected account, but
 * "if the platform creates destination charges ... use your platform's secret
 * key to authenticate the request and omit the Stripe-Account header."
 * billing/payments.ts creates destination charges (`on_behalf_of` +
 * `transfer_data.destination`) on the platform, and the browser loads the
 * PLATFORM publishable key, so the domain belongs to the platform — one
 * registration covers every barber. A per-barber registration would be both
 * wrong and unbounded.
 *
 * Registering in live mode also registers the domain in sandboxes, so this runs
 * with whatever key the environment holds and the two never disagree.
 *
 * Stripe handles Apple merchant validation itself, so there is deliberately no
 * `apple-developer-merchantid-domain-association` file to serve.
 */

export interface WalletDomainResult {
  /** Domains newly registered by this call. */
  registered: string[];
  /** Domains Stripe already had. */
  existing: string[];
  /** Domains Stripe refused, with the reason. */
  failed: { domain: string; reason: string }[];
}

/**
 * The domains to register for a given public base URL.
 *
 * Apple treats every host separately and Stripe's guidance is explicit that
 * `www` is its own subdomain, so an apex deployment registers both spellings —
 * a customer who lands on the `www` host otherwise loses Apple Pay for reasons
 * nobody would ever guess.
 *
 * Returns [] for hosts Apple can never serve (localhost, bare IPs), so local
 * dev and CI make no Stripe call at all.
 */
export function walletDomains(appBaseUrl: string): string[] {
  let host: string;
  try {
    host = new URL(appBaseUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!host || host === "localhost" || host.endsWith(".local")) return [];
  // A bare IP is never a registrable Apple Pay domain.
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return [];
  // Nothing to pair a "www" with on a deeper subdomain (app.example.com):
  // registering "www.app.example.com" would just fail.
  if (host.startsWith("www.")) {
    const apex = host.slice(4);
    return apex.split(".").length === 2 ? [host, apex] : [host];
  }
  return host.split(".").length === 2 ? [host, `www.${host}`] : [host];
}

/**
 * Make sure every wallet domain for this deployment is registered. Idempotent:
 * the common case is one `list` call per domain and no writes.
 *
 * Never throws — a wallet that fails to register must not take the API down,
 * and the checkout still works by card.
 */
export async function ensureWalletDomains(): Promise<WalletDomainResult> {
  const out: WalletDomainResult = { registered: [], existing: [], failed: [] };
  if (!connectEnabled()) return out;
  const domains = walletDomains(apiEnv().APP_BASE_URL);
  if (domains.length === 0) return out;

  for (const domain of domains) {
    try {
      const found = await stripeClient().paymentMethodDomains.list({
        domain_name: domain,
        limit: 1,
      });
      const known = found.data[0];
      if (known) {
        // A domain can exist but be DISABLED (someone switched it off in the
        // dashboard, or a validation lapsed). Enabling is the same one-line
        // fix as creating, and leaving it off would be the silent-Apple-Pay
        // failure this module exists to prevent.
        if (!known.enabled) {
          await stripeClient().paymentMethodDomains.update(known.id, { enabled: true });
          out.registered.push(domain);
        } else {
          out.existing.push(domain);
        }
        continue;
      }
      await stripeClient().paymentMethodDomains.create({ domain_name: domain });
      out.registered.push(domain);
    } catch (err) {
      out.failed.push({
        domain,
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return out;
}

/**
 * Boot hook: register the wallet domains and say what happened, once, in the
 * deploy log. Fire-and-forget — never delays or fails the listen callback.
 */
export function ensureWalletDomainsAtBoot(): void {
  if (!connectEnabled()) return;
  void (async () => {
    try {
      const result = await ensureWalletDomains();
      if (result.failed.length > 0) {
        logger.warn(
          { registered: result.registered, existing: result.existing, failed: result.failed },
          "wallets: some domains are NOT registered - Apple Pay will not render on them",
        );
        return;
      }
      if (result.registered.length > 0) {
        logger.info({ registered: result.registered }, "wallets: domain(s) registered for Apple Pay");
        return;
      }
      if (result.existing.length > 0) {
        logger.info({ domains: result.existing }, "wallets: Apple Pay domains already registered");
      }
    } catch (err) {
      logger.warn({ err }, "wallets: domain registration check failed");
    }
  })();
}
