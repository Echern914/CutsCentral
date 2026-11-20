import { afterAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { applyConnectEvent } from "./connect.js";
import {
  HEALTHY,
  mirrorFields,
  requirementLabel,
  stripeAlertFor,
  summarizeStripeHealth,
} from "./stripeHealth.js";

/**
 * STRIPE HEALTH: what Stripe still wants from a shop's account, in a barber's
 * words, and when the dashboard should say so.
 *
 * 🔴 Why: a barber charged a no-show fee on an account Stripe had marked for
 * closure (photo ID overdue), and nothing inside ChairBack had ever said so.
 * The Payments page showed two checkmarks; the warnings lived only in the
 * platform's own Stripe dashboard (2026-11-19).
 */

function account(req: Partial<Stripe.Account.Requirements> | null): Pick<Stripe.Account, "requirements"> {
  return {
    requirements: req === null
      ? undefined
      : ({
          currently_due: [],
          past_due: [],
          eventually_due: [],
          pending_verification: [],
          current_deadline: null,
          disabled_reason: null,
          errors: [],
          alternatives: [],
          ...req,
        } as Stripe.Account.Requirements),
  };
}

describe("requirementLabel", () => {
  it("says each common Stripe code in plain words", () => {
    expect(requirementLabel("individual.verification.document")).toBe("A photo of your ID");
    expect(requirementLabel("person_1AbC.verification.document")).toBe("A photo of your ID");
    expect(requirementLabel("individual.verification.additional_document")).toBe(
      "A second document that shows your address",
    );
    expect(requirementLabel("external_account")).toBe("Your bank account for payouts");
    expect(requirementLabel("individual.dob.day")).toBe("Your date of birth");
    expect(requirementLabel("individual.ssn_last_4")).toBe("Your Social Security number");
    expect(requirementLabel("individual.id_number")).toBe("Your Social Security number");
    expect(requirementLabel("tos_acceptance.date")).toBe("Accepting Stripe's terms");
    expect(requirementLabel("business_profile.url")).toBe(
      "What your business does (a website or a short description)",
    );
  });

  it("a COMPANY's item is the business's, never 'your ID'", () => {
    expect(requirementLabel("company.tax_id")).toBe("Your business tax ID (EIN)");
    expect(requirementLabel("company.address.line1")).toBe("Your business address");
    expect(requirementLabel("company.verification.document")).toBe("A business document");
    expect(requirementLabel("individual.address.line1")).toBe("Your home address");
  });

  it("🔴 an unknown code never leaks Stripe's jargon", () => {
    const label = requirementLabel("some.future_requirement_code");
    expect(label).toBe("Other details Stripe asks for");
    expect(label).not.toMatch(/[._]/);
  });
});

describe("summarizeStripeHealth", () => {
  it("an account with nothing due is healthy", () => {
    expect(summarizeStripeHealth(account({}))).toEqual(HEALTHY);
    expect(summarizeStripeHealth(account(null))).toEqual(HEALTHY);
  });

  it("🔴 the closing-account case: overdue photo ID, rejected", () => {
    const h = summarizeStripeHealth(
      account({
        past_due: ["individual.verification.document"],
        currently_due: ["individual.verification.document"],
        current_deadline: Date.UTC(2026, 9, 31) / 1000,
        disabled_reason: "rejected.other",
      }),
    );
    // Deduped: past_due and currently_due both list it.
    expect(h.needs).toEqual(["A photo of your ID"]);
    expect(h.overdue).toBe(true);
    expect(h.closed).toBe(true);
    expect(h.dueBy).toBe("2026-10-31T00:00:00.000Z");
    expect(h.disabledReason).toBe("rejected.other");
  });

  it("lists overdue items first, then the rest, each once", () => {
    const h = summarizeStripeHealth(
      account({
        past_due: ["external_account"],
        currently_due: ["individual.dob.day", "individual.dob.month", "external_account"],
      }),
    );
    expect(h.needs).toEqual(["Your bank account for payouts", "Your date of birth"]);
  });

  it("something under review is said as such, not as missing", () => {
    const h = summarizeStripeHealth(account({ pending_verification: ["individual.verification.document"] }));
    expect(h.needs).toEqual([]);
    expect(h.underReview).toBe(true);
    expect(h.closed).toBe(false);
  });

  it("a paused-for-requirements account is NOT closed", () => {
    const h = summarizeStripeHealth(
      account({ past_due: ["external_account"], disabled_reason: "requirements.past_due" }),
    );
    expect(h.closed).toBe(false);
    expect(mirrorFields(h).connectRequirementsDue).toBe(true);
  });
});

describe("stripeAlertFor", () => {
  const base = {
    connected: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    requirementsDue: false,
    dueBy: null as Date | null,
    disabledReason: null as string | null,
    hasTakenPayments: true,
  };
  const now = new Date("2026-11-19T12:00:00Z");

  it("a healthy account, or no account, gets no banner", () => {
    expect(stripeAlertFor({ ...base, now })).toBeNull();
    expect(stripeAlertFor({ ...base, connected: false, chargesEnabled: false, now })).toBeNull();
  });

  it("🔴 a closed account that took money is the loudest banner", () => {
    expect(
      stripeAlertFor({ ...base, chargesEnabled: false, payoutsEnabled: false, disabledReason: "rejected.other", now }),
    ).toEqual({ kind: "closed" });
  });

  it("paused payments, then held payouts, then a deadline still ahead", () => {
    expect(stripeAlertFor({ ...base, chargesEnabled: false, now })).toEqual({ kind: "payments_paused" });
    expect(stripeAlertFor({ ...base, payoutsEnabled: false, requirementsDue: true, now })).toEqual({
      kind: "payouts_paused",
    });
    expect(
      stripeAlertFor({ ...base, requirementsDue: true, dueBy: new Date("2026-11-25T00:00:00Z"), now }),
    ).toEqual({ kind: "details_due", dueBy: "2026-11-25T00:00:00.000Z" });
  });

  it("🔴 an item overdue while cards AND payouts still run is no banner (it is not stopping money)", () => {
    // 2026-11-19: "photo ID past due" that only affected Affirm, on an account
    // with payments and payouts active and $50 on its way to the bank.
    expect(
      stripeAlertFor({ ...base, requirementsDue: true, dueBy: new Date("2026-10-31T00:00:00Z"), now }),
    ).toBeNull();
    // Nor is an item with no deadline at all.
    expect(stripeAlertFor({ ...base, requirementsDue: true, dueBy: null, now })).toBeNull();
  });

  it("🔴 a shop that never took a card payment is not nagged about a setup it walked away from", () => {
    const never = { ...base, hasTakenPayments: false, now };
    expect(stripeAlertFor({ ...never, chargesEnabled: false, payoutsEnabled: false })).toBeNull();
    expect(stripeAlertFor({ ...never, chargesEnabled: false, disabledReason: "rejected.fraud" })).toBeNull();
  });
});

describe("the Shop mirror", () => {
  const shopIds: string[] = [];
  const userIds: string[] = [];

  async function makeShop(accountId: string) {
    const user = await prisma.user.create({
      data: { email: `health-${randomToken(6)}@test.local`, name: "Health" },
    });
    userIds.push(user.id);
    const shop = await prisma.shop.create({
      data: {
        ownerId: user.id,
        name: `Health Shop ${randomToken(4)}`,
        bookingUrl: "https://example.com",
        webhookSecret: randomToken(16),
        stripeConnectAccountId: accountId,
        stripeConnectAccountType: "express",
        connectChargesEnabled: true,
        payoutsEnabled: true,
      },
    });
    shopIds.push(shop.id);
    return shop;
  }

  afterAll(async () => {
    if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  function updatedEvent(acct: Record<string, unknown>): Stripe.Event {
    return {
      id: `evt_${randomToken(8)}`,
      object: "event",
      type: "account.updated",
      data: { object: { object: "account", ...acct } },
    } as unknown as Stripe.Event;
  }

  it("🔴 account.updated mirrors what Stripe wants, so the banner reads one row", async () => {
    const acct = `acct_${randomToken(10)}`;
    const shop = await makeShop(acct);
    await applyConnectEvent(
      updatedEvent({
        id: acct,
        charges_enabled: true,
        payouts_enabled: false,
        requirements: {
          currently_due: ["individual.verification.document"],
          past_due: ["individual.verification.document"],
          pending_verification: [],
          current_deadline: Date.UTC(2026, 9, 31) / 1000,
          disabled_reason: "requirements.past_due",
        },
      }),
    );
    const after = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(after!.payoutsEnabled).toBe(false);
    expect(after!.connectRequirementsDue).toBe(true);
    expect(after!.connectRequirementsDueBy?.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(after!.connectDisabledReason).toBe("requirements.past_due");

    // Stripe got what it needed: the next event clears it all.
    await applyConnectEvent(
      updatedEvent({ id: acct, charges_enabled: true, payouts_enabled: true, requirements: {} }),
    );
    const cleared = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(cleared!.payoutsEnabled).toBe(true);
    expect(cleared!.connectRequirementsDue).toBe(false);
    expect(cleared!.connectRequirementsDueBy).toBeNull();
    expect(cleared!.connectDisabledReason).toBeNull();
  });

  it("a disconnect clears the mirror, so no banner outlives the account", async () => {
    const acct = `acct_${randomToken(10)}`;
    const shop = await makeShop(acct);
    await prisma.shop.update({
      where: { id: shop.id },
      data: { connectRequirementsDue: true, connectDisabledReason: "rejected.other" },
    });
    await applyConnectEvent({
      id: `evt_${randomToken(8)}`,
      object: "event",
      type: "account.application.deauthorized",
      account: acct,
      data: { object: { id: "ca_platform_app", object: "application" } },
    } as unknown as Stripe.Event);
    const after = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(after!.stripeConnectAccountId).toBeNull();
    expect(after!.connectRequirementsDue).toBe(false);
    expect(after!.connectDisabledReason).toBeNull();
  });
});
