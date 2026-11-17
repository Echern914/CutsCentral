import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * APPLE PAY ON A SHOP'S OWN DOMAIN.
 *
 * Since clients book on drickcuttinup.com itself, the Payment Element draws
 * there - and on a host Stripe has not registered, the wallet tab is not an
 * error, it is just silently absent. What this pins:
 *
 *   - 🔴 every VERIFIED shop domain is registered alongside the platform's own,
 *     on the platform account (one registration per domain covers it);
 *   - an unverified claim is never sent to Stripe;
 *   - the apex only (the web 308s www to it), and never twice;
 *   - local dev and CI call Stripe for nothing, shop domains included;
 *   - one failure - a domain, or the read of them - never stops the rest;
 *   - 🔴 a domain is registered the moment it is verified, not at next deploy.
 *
 * Stripe and the database are fakes; the module is the real one.
 */

interface FakeDomain {
  id: string;
  domain_name: string;
  enabled: boolean;
  apple_pay: { status: "active" | "inactive"; status_details?: { error_message: string } };
}

const fake = vi.hoisted(() => ({
  registered: [] as FakeDomain[],
  calls: [] as string[],
  /** Domains Stripe refuses to create. */
  refuse: new Set<string>(),
  /** What `validate` makes of an inactive domain. */
  validatesTo: "active" as "active" | "inactive",
  baseUrl: "https://getchairback.com",
  connect: true,
  shopRows: [] as { customDomain: string | null }[],
  findManyArgs: [] as unknown[],
  findManyFails: false,
}));

vi.mock("./stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripe.js")>()),
  connectEnabled: () => fake.connect,
  stripeClient: () => ({
    paymentMethodDomains: {
      list: async ({ domain_name }: { domain_name: string }) => {
        fake.calls.push(`list ${domain_name}`);
        return { data: fake.registered.filter((d) => d.domain_name === domain_name) };
      },
      create: async ({ domain_name }: { domain_name: string }) => {
        fake.calls.push(`create ${domain_name}`);
        if (fake.refuse.has(domain_name)) throw new Error(`refused ${domain_name}`);
        const d: FakeDomain = { id: `pmd_${fake.registered.length}`, domain_name, enabled: true, apple_pay: { status: "active" } };
        fake.registered.push(d);
        return d;
      },
      update: async (id: string, p: { enabled: boolean }) => {
        fake.calls.push(`update ${id}`);
        const d = fake.registered.find((x) => x.id === id)!;
        d.enabled = p.enabled;
        return d;
      },
      validate: async (id: string) => {
        fake.calls.push(`validate ${id}`);
        const d = fake.registered.find((x) => x.id === id)!;
        d.apple_pay =
          fake.validatesTo === "active"
            ? { status: "active" }
            : { status: "inactive", status_details: { error_message: "certificate not issued" } };
        return d;
      },
    },
  }),
}));

vi.mock("@chairback/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@chairback/config")>();
  return { ...real, apiEnv: () => ({ ...real.apiEnv(), APP_BASE_URL: fake.baseUrl }) };
});

vi.mock("@chairback/db", () => ({
  prisma: {
    shop: {
      findMany: async (args: { where: unknown }) => {
        fake.findManyArgs.push(args);
        if (fake.findManyFails) throw new Error("db unavailable");
        return fake.shopRows;
      },
    },
  },
}));

const { ensureWalletDomains, ensureCustomDomainWallet } = await import("./paymentMethodDomains.js");

beforeEach(() => {
  fake.registered = [];
  fake.calls = [];
  fake.refuse = new Set();
  fake.validatesTo = "active";
  fake.baseUrl = "https://getchairback.com";
  fake.connect = true;
  fake.shopRows = [{ customDomain: "drickcuttinup.com" }, { customDomain: "StudioOne.com" }];
  fake.findManyArgs = [];
  fake.findManyFails = false;
});

const names = () => fake.registered.map((d) => d.domain_name);

describe("ensureWalletDomains, with shop domains", () => {
  it("🔴 registers every verified shop domain alongside the platform's own", async () => {
    const out = await ensureWalletDomains();
    expect(names()).toEqual(["getchairback.com", "www.getchairback.com", "drickcuttinup.com", "studioone.com"]);
    expect(out.registered).toEqual(names());
    expect(out.failed).toEqual([]);
  });

  it("🔴 asks the database for VERIFIED domains only - an unproven claim never reaches Stripe", async () => {
    await ensureWalletDomains();
    expect(fake.findManyArgs[0]).toMatchObject({
      where: { customDomain: { not: null }, customDomainVerifiedAt: { not: null } },
    });
  });

  it("the apex only - no www is invented for a shop domain - and the platform's never twice", async () => {
    fake.shopRows = [{ customDomain: "drickcuttinup.com" }, { customDomain: "getchairback.com" }];
    await ensureWalletDomains();
    expect(names()).toEqual(["getchairback.com", "www.getchairback.com", "drickcuttinup.com"]);
  });

  it("is idempotent: a second boot only looks", async () => {
    await ensureWalletDomains();
    fake.calls = [];
    const out = await ensureWalletDomains();
    expect(fake.calls.every((c) => c.startsWith("list "))).toBe(true);
    expect(out.existing).toHaveLength(4);
  });

  it("asks Stripe to re-check a shop domain whose Apple Pay never came good", async () => {
    fake.registered.push({
      id: "pmd_x",
      domain_name: "drickcuttinup.com",
      enabled: true,
      apple_pay: { status: "inactive", status_details: { error_message: "no certificate" } },
    });
    const ok = await ensureWalletDomains();
    expect(fake.calls).toContain("validate pmd_x");
    expect(ok.registered).toContain("drickcuttinup.com");

    fake.registered[0]!.apple_pay = { status: "inactive" };
    fake.validatesTo = "inactive";
    const still = await ensureWalletDomains();
    expect(still.failed).toContainEqual({ domain: "drickcuttinup.com", reason: "certificate not issued" });
  });

  it("re-enables a shop domain someone switched off", async () => {
    fake.registered.push({ id: "pmd_off", domain_name: "studioone.com", enabled: false, apple_pay: { status: "active" } });
    await ensureWalletDomains();
    expect(fake.calls).toContain("update pmd_off");
  });

  it("one refused domain never stops the others", async () => {
    fake.refuse.add("drickcuttinup.com");
    const out = await ensureWalletDomains();
    expect(out.failed.map((f) => f.domain)).toEqual(["drickcuttinup.com"]);
    expect(names()).toContain("studioone.com");
  });

  it("a failed read of the shop domains still registers the platform's own", async () => {
    fake.findManyFails = true;
    const out = await ensureWalletDomains();
    expect(names()).toEqual(["getchairback.com", "www.getchairback.com"]);
    expect(out.failed).toEqual([{ domain: "(shop domains)", reason: "db unavailable" }]);
  });

  it("local dev and CI call Stripe for nothing - shop domains included - and nor does a deployment without Connect", async () => {
    fake.baseUrl = "http://localhost:3000";
    await ensureWalletDomains();
    expect(fake.calls).toEqual([]);
    expect(fake.findManyArgs).toEqual([]);

    fake.baseUrl = "https://getchairback.com";
    fake.connect = false;
    await ensureWalletDomains();
    expect(fake.calls).toEqual([]);
  });
});

describe("ensureCustomDomainWallet: the moment a domain is verified", () => {
  it("🔴 registers it straight away, lower-cased", async () => {
    ensureCustomDomainWallet("DrickCuttinUp.com");
    await vi.waitFor(() => expect(names()).toEqual(["drickcuttinup.com"]));
  });

  it("calls Stripe for nothing on a local deployment", async () => {
    fake.baseUrl = "http://localhost:3000";
    ensureCustomDomainWallet("drickcuttinup.com");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls).toEqual([]);
  });

  it("🔴 the verify route calls it - and only where it stamps the domain verified", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = await readFile(path.resolve(here, "../routes/domains.ts"), "utf8");
    const stamp = src.indexOf("data: { customDomainVerifiedAt: verifiedAt }");
    const call = src.indexOf("ensureCustomDomainWallet(shop.customDomain)");
    expect(stamp).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(stamp);
    // In the same block as the stamp: before that block's closing brace.
    expect(src.slice(stamp, call)).not.toMatch(/\n {2}\}\n/);
  });
});
