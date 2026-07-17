import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { applyStripeEvent } from "../billing/stripe.js";
import {
  __setNumberProvisionerForTests,
  ensureShopNumber,
  planAttach,
  type NumberProvisioner,
} from "./numberProvision.js";

/**
 * Premium AI number auto-provisioning: the fake provisioner stands in for the
 * Twilio purchase (no network, no money), so these tests pin down the DECISION
 * logic - who gets a number, when, and exactly once.
 */

let userId: string;

function fakeProvisioner(): NumberProvisioner & { calls: number; releases: string[] } {
  const p = {
    calls: 0,
    releases: [] as string[],
    async provision() {
      p.calls += 1;
      // Yield long enough for a concurrent caller to also pass the
      // twilioNumber-null check - the window the claim guard exists for.
      await new Promise((r) => setTimeout(r, 25));
      return {
        phoneNumber: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
        sid: `PN${randomToken(8)}`,
      };
    },
    async release(sid: string) {
      p.releases.push(sid);
    },
  };
  return p;
}

function failingProvisioner(): NumberProvisioner {
  return {
    async provision() {
      return null;
    },
    async release() {},
  };
}

async function makeShop(plan: string): Promise<string> {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Numbered Cuts",
      slug: `num-${randomToken(5)}`,
      webhookSecret: randomToken(),
      plan,
    },
    select: { id: true },
  });
  return shop.id;
}

async function shopNumber(shopId: string): Promise<string | null> {
  const s = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { twilioNumber: true },
  });
  return s?.twilioNumber ?? null;
}

/** The webhook fires ensureShopNumber fire-and-forget; poll briefly. */
async function waitForNumber(shopId: string, ms = 2000): Promise<string | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const n = await shopNumber(shopId);
    if (n !== null || Date.now() > deadline) return n;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `num-${randomToken(6)}@test.chairback`, name: "Num Tester" },
    select: { id: true },
  });
  userId = user.id;
});

afterAll(() => {
  __setNumberProvisionerForTests(undefined);
});

beforeEach(() => {
  __setNumberProvisionerForTests(undefined);
});

describe("planAttach (campaign spill-over)", () => {
  it("fills the first campaign while it has room", () => {
    expect(planAttach([10, 0], 49)).toEqual({ index: 0, remainingAfter: 87 });
  });

  it("spills to the next campaign when the first is full", () => {
    expect(planAttach([49, 3], 49)).toEqual({ index: 1, remainingAfter: 45 });
  });

  it("reports full when every campaign is at cap (even over-full)", () => {
    expect(planAttach([49, 49], 49)).toEqual({ index: null, remainingAfter: 0 });
    expect(planAttach([50], 49)).toEqual({ index: null, remainingAfter: 0 });
  });

  it("counts the runway down to zero on the last slot", () => {
    expect(planAttach([48], 49)).toEqual({ index: 0, remainingAfter: 0 });
    expect(planAttach([44], 49).remainingAfter).toBe(4);
  });
});

describe("ensureShopNumber", () => {
  it("provisions a Premium AI shop exactly once (idempotent)", async () => {
    const p = fakeProvisioner();
    __setNumberProvisionerForTests(p);
    const shopId = await makeShop("pro_ai");

    await ensureShopNumber(shopId);
    const first = await shopNumber(shopId);
    expect(first).not.toBeNull();
    expect(p.calls).toBe(1);

    // Re-fires (every subscription.updated does) must not buy again.
    await ensureShopNumber(shopId);
    expect(p.calls).toBe(1);
    expect(await shopNumber(shopId)).toBe(first);
  });

  it("never provisions non-Premium-AI plans", async () => {
    const p = fakeProvisioner();
    __setNumberProvisionerForTests(p);
    for (const plan of ["free", "pro"]) {
      const shopId = await makeShop(plan);
      await ensureShopNumber(shopId);
      expect(await shopNumber(shopId)).toBeNull();
    }
    expect(p.calls).toBe(0);
  });

  it("concurrent provisions (checkout + subscription race) keep ONE number and release the duplicate", async () => {
    const p = fakeProvisioner();
    __setNumberProvisionerForTests(p);
    const shopId = await makeShop("pro_ai");

    await Promise.all([ensureShopNumber(shopId), ensureShopNumber(shopId)]);

    const final = await shopNumber(shopId);
    expect(final).not.toBeNull();
    expect(p.calls).toBe(2); // both raced past the null check and bought
    expect(p.releases).toHaveLength(1); // the loser released its purchase
  });

  it("a failed purchase leaves the shop on the shared line (no throw, no row change)", async () => {
    __setNumberProvisionerForTests(failingProvisioner());
    const shopId = await makeShop("pro_ai");
    await ensureShopNumber(shopId);
    expect(await shopNumber(shopId)).toBeNull();
  });
});

describe("Stripe wiring", () => {
  it("an ACTIVE pro_ai subscription event auto-provisions the shop's number", async () => {
    const p = fakeProvisioner();
    __setNumberProvisionerForTests(p);
    const shopId = await makeShop("free");

    await applyStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_${randomToken(6)}`,
          status: "active",
          customer: `cus_${randomToken(6)}`,
          metadata: { shopId, tier: "pro_ai" },
        },
      },
    } as never);

    expect(await waitForNumber(shopId)).not.toBeNull();
    expect(p.calls).toBe(1);
  });

  it("a plain pro subscription event provisions nothing", async () => {
    const p = fakeProvisioner();
    __setNumberProvisionerForTests(p);
    const shopId = await makeShop("free");

    await applyStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_${randomToken(6)}`,
          status: "active",
          customer: `cus_${randomToken(6)}`,
          metadata: { shopId, tier: "pro" },
        },
      },
    } as never);

    // Give the (nonexistent) fire-and-forget a moment, then assert nothing.
    await new Promise((r) => setTimeout(r, 100));
    expect(await shopNumber(shopId)).toBeNull();
    expect(p.calls).toBe(0);
  });
});
