import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * The STRIPE CREDIT branch of the referral payout - the half that moves real
 * money, and the half nothing had ever executed.
 *
 * Every other referral test pays a not-yet-subscribed referrer, which takes
 * `trial_extension`: a local trialEndsAt bump that never touches Stripe. The
 * paying branch (`payReferrer` -> monthlyPriceCents -> createBalanceTransaction)
 * had no coverage at all, in a codebase where the first production execution
 * would be a real person's money.
 *
 * Two properties matter here and they pull in opposite directions:
 *   - the credit must be for the RIGHT amount, negative, on the right customer;
 *   - when Stripe refuses, the failure must stay DETECTABLE, because the CAS
 *     has already committed and nothing will ever retry.
 *
 * The Stripe client is stubbed by overriding only `stripeClient` on the billing
 * module - `applyStripeEvent` and everything else stay real, and no production
 * seam had to be added to make this testable.
 */

const retrieve = vi.fn();
const createBalanceTransaction = vi.fn();

vi.mock("../billing/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/stripe.js")>();
  return {
    ...actual,
    stripeClient: () => ({
      subscriptions: { retrieve },
      customers: { createBalanceTransaction },
    }),
  };
});

const { grantReferralReward, findStrandedReferralGrants, auditReferralGrants } =
  await import("./referral.js");

const PRICE_CENTS = 4900;
let userId: string;
let referrerShopId: string;
let referredShopId: string;
const CUSTOMER = "cus_referrer_live";
const SUBSCRIPTION = "sub_referrer_live";

/** A referrer who is ALREADY PAYING - the only state that takes the credit path. */
async function makePayingReferrer(over: Record<string, unknown> = {}) {
  return prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Payer Cuts",
      slug: `rc-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
      stripeCustomerId: `${CUSTOMER}-${randomToken(4)}`,
      stripeSubscriptionId: `${SUBSCRIPTION}-${randomToken(4)}`,
      subscriptionStatus: "active",
      ...over,
    },
    select: { id: true, stripeCustomerId: true },
  });
}

async function makeReferral(referrerId: string) {
  const friend = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Friend Cuts",
      slug: `rf-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
    },
    select: { id: true },
  });
  await prisma.referral.create({
    data: {
      referrerShopId: referrerId,
      referredShopId: friend.id,
      code: randomToken(6),
      status: "PENDING",
    },
  });
  return friend.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `rc-${randomToken(6)}@test.local`, name: "RC" },
    select: { id: true },
  });
  userId = user.id;
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.referral.deleteMany({
    where: { referrerShop: { ownerId: userId } },
  });
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("paying a referrer who is already subscribed", () => {
  it("🔴 two SIMULTANEOUS grants credit Stripe exactly ONCE - the CAS is the only thing stopping a second month", async () => {
    // Why this test lives HERE and not with the trial-extension ones: a double
    // payout is INVISIBLE on the trial path. extendTrial is read-modify-write,
    // so two racers that both read the same trialEndsAt both write the same
    // value and the row looks identical to a single payout. The Stripe credit
    // is countable, so this is where a second payout can actually be seen.
    //
    // The barrier is a row lock on the Referral: both callers read it as
    // PENDING (a plain SELECT does not block), then both queue at their
    // compare-and-set. That is the only interleaving where the CAS matters,
    // and nothing exercised it before.
    //
    // 🔴 HONEST LIMIT OF THIS TEST. Deleting the CAS predicate does NOT make
    // it fail. Instrumenting the service showed why: without the predicate
    // BOTH callers pass the gate (both see count = 1), so the CAS is real and
    // is genuinely reached here - but the second payout is then absorbed
    // further down and only one Stripe credit is ever issued. So this pins the
    // end-to-end property (one credit, one REWARDED row) and proves the race
    // is real, while the CAS's own removal stays invisible from outside. What
    // is actually stopping that second credit is worth its own look.
    retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: PRICE_CENTS } }] } });
    createBalanceTransaction.mockResolvedValue({ id: "cbtxn_race" });
    const referrer = await makePayingReferrer();
    const referred = await makeReferral(referrer.id);
    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredShopId: referred },
    });

    const { settledEarly } = await raceBehindRowLock("Referral", referral.id, [
      () => grantReferralReward(referred),
      () => grantReferralReward(referred),
    ]);
    // Both callers really did contend: neither finished until the row was
    // released. (Instrumented once to be sure: both read PENDING and both
    // reached the compare-and-set, which is the interleaving that matters.)
    expect(settledEarly).toBe(0);
    expect(settledEarly).toBe(0);

    // ONE month of credit. Two would be real money out the door.
    expect(createBalanceTransaction).toHaveBeenCalledTimes(1);
    const row = await prisma.referral.findUniqueOrThrow({ where: { id: referral.id } });
    expect(row.status).toBe("REWARDED");
  });

  it("🔴 credits their Stripe balance by exactly one month, as a NEGATIVE amount", async () => {
    retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: PRICE_CENTS } }] } });
    createBalanceTransaction.mockResolvedValue({ id: "cbtxn_1" });
    const referrer = await makePayingReferrer();
    referrerShopId = referrer.id;
    referredShopId = await makeReferral(referrerShopId);

    await grantReferralReward(referredShopId);

    // The amount comes from the subscription Stripe holds, not from anything
    // we stored - and it is NEGATIVE, which is what makes it account credit
    // rather than a charge.
    expect(createBalanceTransaction).toHaveBeenCalledTimes(1);
    const [customerArg, body] = createBalanceTransaction.mock.calls[0]!;
    expect(customerArg).toBe(referrer.stripeCustomerId);
    expect(body.amount).toBe(-PRICE_CENTS);
    expect(body.currency).toBe("usd");

    const row = await prisma.referral.findUnique({ where: { referredShopId } });
    expect(row!.status).toBe("REWARDED");
    expect(row!.rewardKind).toBe("stripe_credit");
    expect(row!.rewardAmountCents).toBe(PRICE_CENTS);
    // A paying referrer gets money off, never more trial.
    const shop = await prisma.shop.findUnique({
      where: { id: referrerShopId },
      select: { trialEndsAt: true },
    });
    expect(shop!.trialEndsAt).toBeNull();
  });

  it("🔴 a Stripe failure leaves the row DETECTABLE: REWARDED with a null rewardKind", async () => {
    retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: PRICE_CENTS } }] } });
    createBalanceTransaction.mockRejectedValue(new Error("card_declined_or_api_down"));
    const referrer = await makePayingReferrer();
    referredShopId = await makeReferral(referrer.id);

    // It must NOT throw: the webhook returning 500 would make Stripe redeliver
    // forever against a row that can never be re-granted.
    await expect(grantReferralReward(referredShopId)).resolves.toBeUndefined();

    const row = await prisma.referral.findUnique({ where: { referredShopId } });
    expect(row!.status).toBe("REWARDED"); // the CAS already committed
    expect(row!.rewardKind).toBeNull(); // ...and the grant did not
    expect(row!.rewardAmountCents).toBeNull();

    // Which is exactly the pair the audit looks for.
    const stranded = await findStrandedReferralGrants();
    expect(stranded.count).toBeGreaterThan(0);
    expect(stranded.referralIds).toContain(row!.id);
  });

  it("🔴 tiered or metered pricing (null unit_amount) strands rather than crediting zero", async () => {
    // unit_amount is null for tiered/metered prices. The guard must refuse
    // rather than compute a nonsense credit - and refusing means stranding,
    // because the CAS is already committed by the time we get here.
    retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: null } }] } });
    const referrer = await makePayingReferrer();
    referredShopId = await makeReferral(referrer.id);

    await grantReferralReward(referredShopId);

    expect(createBalanceTransaction).not.toHaveBeenCalled();
    const row = await prisma.referral.findUnique({ where: { referredShopId } });
    expect(row!.rewardKind).toBeNull();
    expect((await findStrandedReferralGrants()).referralIds).toContain(row!.id);
  });

  it("a referrer who has NOT subscribed still takes the trial path and calls Stripe not at all", async () => {
    const referrer = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Free Cuts",
        slug: `rn-${randomToken(5)}`.toLowerCase(),
        webhookSecret: randomToken(),
        timezone: "UTC",
        bookingMode: "native",
      },
      select: { id: true },
    });
    referredShopId = await makeReferral(referrer.id);

    await grantReferralReward(referredShopId);

    expect(retrieve).not.toHaveBeenCalled();
    expect(createBalanceTransaction).not.toHaveBeenCalled();
    const row = await prisma.referral.findUnique({ where: { referredShopId } });
    expect(row!.rewardKind).toBe("trial_extension");
  });

  it("a subscription that is not in an active-for-credit state gets trial, not credit", async () => {
    // `canceled` keeps the ids on the row but must not receive account credit -
    // there is no upcoming invoice for it to land on.
    const referrer = await makePayingReferrer({ subscriptionStatus: "canceled" });
    referredShopId = await makeReferral(referrer.id);

    await grantReferralReward(referredShopId);

    expect(createBalanceTransaction).not.toHaveBeenCalled();
    const row = await prisma.referral.findUnique({ where: { referredShopId } });
    expect(row!.rewardKind).toBe("trial_extension");
  });
});

describe("the stranded-grant audit", () => {
  it("reports nothing when every rewarded referral actually paid", async () => {
    retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: PRICE_CENTS } }] } });
    createBalanceTransaction.mockResolvedValue({ id: "cbtxn_ok" });
    const referrer = await makePayingReferrer();
    await grantReferralReward(await makeReferral(referrer.id));

    const before = await findStrandedReferralGrants();
    // Scoped assertion: other suites share this database, so the property is
    // "none of MINE are stranded", not a global zero.
    const mine = await prisma.referral.findMany({
      where: { referrerShop: { ownerId: userId } },
      select: { id: true, rewardKind: true },
    });
    expect(mine.every((r) => r.rewardKind !== null)).toBe(true);
    for (const r of mine) expect(before.referralIds).not.toContain(r.id);
  });

  it("counts and names a stranded grant so the alert can carry ids, never people", async () => {
    retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: PRICE_CENTS } }] } });
    createBalanceTransaction.mockRejectedValue(new Error("api_down"));
    const referrer = await makePayingReferrer();
    const friend = await makeReferral(referrer.id);
    await grantReferralReward(friend);

    const res = await auditReferralGrants();
    expect(res.stranded).toBeGreaterThan(0);
    const row = await prisma.referral.findUnique({ where: { referredShopId: friend } });
    expect(res.referralIds).toContain(row!.id);
    // Ids only - nothing in the alert payload can identify a person.
    expect(JSON.stringify(res)).not.toMatch(/@|Payer Cuts|Friend Cuts/);
  });
});
