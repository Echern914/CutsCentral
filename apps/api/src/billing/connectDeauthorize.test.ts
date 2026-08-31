import { afterAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { applyConnectEvent } from "./connect.js";

/**
 * `account.application.deauthorized` — the barber revoking ChairBack from their
 * OWN Stripe dashboard.
 *
 * 🔴 WHY THIS EXISTS. Only STANDARD accounts can do this, and it happens
 * entirely outside ChairBack: no request reaches us, no button is pressed here,
 * nothing in the dashboard changes. If the event is ignored, the shop keeps
 * rendering "connected" and every subsequent charge fails at Stripe — a silent
 * money outage that presents as ChairBack being broken. The webhook is the only
 * notification we ever get.
 *
 * Needs no Stripe account: applyConnectEvent folds an already-parsed event into
 * our rows, so a hand-built envelope exercises the real reducer.
 */
describe("connect deauthorization", () => {
  const tag = randomToken(8);
  const shopIds: string[] = [];
  const userIds: string[] = [];

  async function makeShop(accountId: string | null, type: string | null) {
    const user = await prisma.user.create({
      data: { email: `deauth-${randomToken(6)}@test.local`, name: "Deauth" },
    });
    userIds.push(user.id);
    const shop = await prisma.shop.create({
      data: {
        ownerId: user.id,
        name: `Deauth Shop ${tag}`,
        bookingUrl: "https://example.com",
        webhookSecret: randomToken(16),
        stripeConnectAccountId: accountId,
        stripeConnectAccountType: type,
        connectChargesEnabled: true,
        payoutsEnabled: true,
        paymentsMode: "ahead",
      },
    });
    shopIds.push(shop.id);
    return shop;
  }

  /**
   * 🔴 The account id is on the EVENT ENVELOPE (`event.account`), not on the
   * object — the object is the deauthorized Application, whose id is our
   * platform's `ca_…`. Reading it from the object would match zero shops every
   * single time and look exactly like a working no-op.
   */
  function deauthEvent(accountId: string | undefined): Stripe.Event {
    return {
      id: `evt_${randomToken(8)}`,
      object: "event",
      type: "account.application.deauthorized",
      account: accountId,
      data: { object: { id: "ca_platform_app", object: "application" } },
    } as unknown as Stripe.Event;
  }

  afterAll(async () => {
    if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("🔴 clears the account so booking stops offering a card that cannot work", async () => {
    const acct = `acct_${randomToken(10)}`;
    const shop = await makeShop(acct, "standard");

    await applyConnectEvent(deauthEvent(acct));

    const after = await prisma.shop.findUnique({ where: { id: shop.id } });
    // The booking path requires BOTH the id and connectChargesEnabled
    // (booking.public.ts), so clearing these is what actually makes it fall
    // back to pay-in-person instead of rendering a doomed payment form.
    expect(after!.stripeConnectAccountId).toBeNull();
    expect(after!.connectChargesEnabled).toBe(false);
    expect(after!.payoutsEnabled).toBe(false);
    expect(after!.stripeConnectAccountType).toBeNull();
  });

  it("leaves paymentsMode alone — it is the barber's setting, not ours", async () => {
    const acct = `acct_${randomToken(10)}`;
    const shop = await makeShop(acct, "standard");

    await applyConnectEvent(deauthEvent(acct));

    const after = await prisma.shop.findUnique({ where: { id: shop.id } });
    // Silently rewriting it would mean a reconnect comes back with payments
    // mysteriously off. The guard above already makes the setting inert.
    expect(after!.paymentsMode).toBe("ahead");
  });

  it("🔴 touches ONLY the revoked shop, never every shop", async () => {
    const acctA = `acct_${randomToken(10)}`;
    const acctB = `acct_${randomToken(10)}`;
    const a = await makeShop(acctA, "standard");
    const b = await makeShop(acctB, "standard");

    await applyConnectEvent(deauthEvent(acctA));

    const afterB = await prisma.shop.findUnique({ where: { id: b.id } });
    expect(afterB!.stripeConnectAccountId).toBe(acctB);
    expect(afterB!.connectChargesEnabled).toBe(true);
    const afterA = await prisma.shop.findUnique({ where: { id: a.id } });
    expect(afterA!.stripeConnectAccountId).toBeNull();
  });

  it("🔴 an envelope with NO account must not clear anything", async () => {
    // A malformed/unexpected event must never become a mass disconnect. Prisma
    // reads `{ stripeConnectAccountId: undefined }` as NO FILTER, so a careless
    // implementation here would wipe every connected shop in the table.
    const acct = `acct_${randomToken(10)}`;
    const shop = await makeShop(acct, "standard");

    await applyConnectEvent(deauthEvent(undefined));

    const after = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(after!.stripeConnectAccountId).toBe(acct);
    expect(after!.connectChargesEnabled).toBe(true);
  });

  it("is idempotent: a redelivered event on an already-cleared shop is a no-op", async () => {
    const acct = `acct_${randomToken(10)}`;
    const shop = await makeShop(acct, "standard");

    await applyConnectEvent(deauthEvent(acct));
    await expect(applyConnectEvent(deauthEvent(acct))).resolves.toBeUndefined();

    const after = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(after!.stripeConnectAccountId).toBeNull();
  });

  it("an unknown account (another platform/environment) is tolerated", async () => {
    await expect(
      applyConnectEvent(deauthEvent(`acct_${randomToken(10)}`)),
    ).resolves.toBeUndefined();
  });
});
