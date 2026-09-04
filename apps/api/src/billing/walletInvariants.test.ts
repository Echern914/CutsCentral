import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walletDomains } from "./paymentMethodDomains.js";

/**
 * Apple Pay is a feature that fails SILENTLY.
 *
 * Every way it can be broken - an unregistered domain, a CSP that blocks
 * Stripe's wallet frames, an explicit `payment_method_types` list - produces
 * exactly the same symptom: the tab is simply absent, the card form still
 * works, nobody files a bug, and the feature is quietly missing for everyone on
 * an iPhone. It cannot be caught by a passing checkout.
 *
 * So it is pinned by source-level invariants instead. These are the four things
 * that must stay true, each of which was individually enough to disable it.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(rel: string): Promise<string> {
  return readFile(path.join(SRC, rel), "utf8");
}

/**
 * The file with its comments removed.
 *
 * These invariants are about what the code DOES, and the comments here
 * deliberately quote the very patterns being banned - explaining why
 * `payment_method_types: ["card"]` disabled Apple Pay is the most useful thing
 * those comments can say. Matching the prose instead of the code would make the
 * test fail on its own documentation.
 */
async function code(rel: string): Promise<string> {
  return (await read(rel))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Apple Pay cannot be switched off by accident", () => {
  it("🔴 no money intent pins payment_method_types to card", async () => {
    // Naming the types overrides the account's payment method configuration,
    // so the Payment Element renders card-only however well everything else is
    // set up. This is exactly how card-on-file lost Apple Pay while pay-ahead
    // kept it - the same product, two different answers depending on the shop's
    // payment mode.
    for (const rel of ["billing/payments.ts", "billing/cardOnFile.ts"]) {
      const src = await code(rel);
      expect(src, `${rel} must not pin payment_method_types`).not.toMatch(
        /payment_method_types:\s*\[\s*["']card["']/,
      );
      expect(src, `${rel} must use automatic payment methods`).toContain(
        "automatic_payment_methods",
      );
    }
    // Terminal is the deliberate exception: `card_present` is a physical
    // reader, and automatic methods would be meaningless there.
    const terminal = await code("billing/terminal.ts");
    expect(terminal).toContain('payment_method_types: ["card_present"]');
  });

  it("registers the apex AND the www host, and nothing Apple can never serve", () => {
    // Stripe treats `www` as its own subdomain: a customer who lands on the
    // www host otherwise loses Apple Pay for a reason nobody would guess.
    expect(walletDomains("https://getchairback.com")).toEqual([
      "getchairback.com",
      "www.getchairback.com",
    ]);
    expect(walletDomains("https://www.getchairback.com")).toEqual([
      "www.getchairback.com",
      "getchairback.com",
    ]);
    // A deeper subdomain has no www to pair with.
    expect(walletDomains("https://app.getchairback.com")).toEqual(["app.getchairback.com"]);
    // Local dev and CI make no Stripe call at all.
    expect(walletDomains("http://localhost:3000")).toEqual([]);
    expect(walletDomains("http://127.0.0.1:3000")).toEqual([]);
    expect(walletDomains("not a url")).toEqual([]);
  });

  it("registers the domains at every boot, so no environment can drift", async () => {
    const index = await read("index.ts");
    expect(index).toContain("ensureWalletDomainsAtBoot");
    const mod = await code("billing/paymentMethodDomains.ts");
    // Platform account, no Stripe-Account header - the Connect rule for
    // destination charges. A per-barber registration would be both wrong and
    // unbounded.
    expect(mod).not.toMatch(/stripeAccount|Stripe-Account/);
    // A domain that exists but is DISABLED is re-enabled, not skipped.
    expect(mod).toContain("enabled: true");
  });

  it("keeps no Stripe secret and no raw card data on any client", async () => {
    const webSrc = path.resolve(SRC, "../../web/src");
    const { globSync } = await import("node:fs");
    const files = globSync("**/*.{ts,tsx}", { cwd: webSrc }) as string[];
    expect(files.length).toBeGreaterThan(50);
    for (const rel of files) {
      const text = await readFile(path.join(webSrc, rel), "utf8");
      expect(text, `${rel} must hold no secret key`).not.toMatch(/sk_(live|test)_[A-Za-z0-9]/);
      expect(text, `${rel} must hold no restricted key`).not.toMatch(/rk_(live|test)_[A-Za-z0-9]/);
      // Card data belongs to Stripe's iframe and must never be read by us.
      expect(text, `${rel} must not read a card number`).not.toMatch(
        /\b(cardNumber|card_number|cvc|cvv)\s*[:=]\s*(?!undefined)/i,
      );
    }
  });
});
