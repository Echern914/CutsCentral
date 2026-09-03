import { describe, expect, it } from "vitest";
import {
  cancellationFeeCents,
  describeCancellationPolicy,
  describeDepositPolicy,
  describeNoShowPolicy,
  describeShopPolicy,
  type ShopPolicyInput,
} from "./shopPolicy.js";

const base: ShopPolicyInput = {
  paymentsMode: "off",
  cancelWindowHours: 0,
  cancelFeeBps: 0,
  depositAmountCents: null,
  // Capability, stated explicitly in every fixture: these tests are about
  // what a shop CAN do, not only what it has chosen.
  paymentsLive: true,
  requiresApproval: false,
};

describe("describeCancellationPolicy", () => {
  it("needs BOTH a window and a rate before it is a fee", () => {
    expect(describeCancellationPolicy(base)).toBe(
      "free cancellation any time before the appointment",
    );
    // A window with no rate, or a rate with no window, is still free — that is
    // what the shop configured, so it is what we must say.
    expect(describeCancellationPolicy({ ...base, cancelWindowHours: 12 })).toBe(
      "free cancellation any time before the appointment",
    );
    expect(describeCancellationPolicy({ ...base, cancelFeeBps: 5000 })).toBe(
      "free cancellation any time before the appointment",
    );
  });

  it("states the window and the percentage when both are set", () => {
    // Needs a shop that actually takes money - a fee with nothing to take it
    // from is not a fee, which is its own test below.
    expect(
      describeCancellationPolicy({
        ...base,
        paymentsMode: "ahead",
        cancelWindowHours: 12,
        cancelFeeBps: 5000,
      }),
    ).toBe(
      "free up to 12h before; inside that window 50% of what was collected is kept as a fee",
    );
  });

  it("🔴 does not round a fractional percentage away", () => {
    // The old formatter used .toFixed(0), turning a 40.5% fee into "41%" — a
    // number the shop never chose, quoted to a customer as policy.
    const collecting = { ...base, paymentsMode: "ahead" } as const;
    expect(
      describeCancellationPolicy({ ...collecting, cancelWindowHours: 24, cancelFeeBps: 4050 }),
    ).toContain("40.5%");
    expect(
      describeCancellationPolicy({ ...collecting, cancelWindowHours: 24, cancelFeeBps: 10000 }),
    ).toContain("100%");
  });
});

describe("describeDepositPolicy", () => {
  it("🔴 DEPOSIT MODE IS NOT 'pay at the shop' — the defect this file fixes", () => {
    // The original chain tested only "ahead" and "hold", so a deposit shop
    // fell through to the off-mode string: the receptionist told callers
    // there was no deposit while the booking page charged one.
    const deposit = describeDepositPolicy({
      ...base,
      paymentsMode: "deposit",
      depositAmountCents: 2000,
    });
    expect(deposit).toContain("$20");
    expect(deposit).toContain("deposit");
    expect(deposit).not.toContain("none");
  });

  it("🔴 says 'up to', because the charge is CAPPED at the service price", () => {
    // depositChargeCents does Math.min(deposit, fullPrice): a $20 deposit on a
    // $15 service takes $15 and leaves no remainder. Promising "the rest at
    // the shop" as an unconditional fact was wrong for every cheap service.
    expect(
      describeDepositPolicy({ ...base, paymentsMode: "deposit", depositAmountCents: 2000 }),
    ).toContain("never more than the service price");
  });

  it("says 'a deposit' rather than inventing an amount when none is set", () => {
    expect(
      describeDepositPolicy({ ...base, paymentsMode: "deposit", depositAmountCents: null }),
    ).toBe("a deposit collected at booking, the rest at the shop");
  });

  it("formats cents that are not whole dollars", () => {
    expect(
      describeDepositPolicy({ ...base, paymentsMode: "deposit", depositAmountCents: 1550 }),
    ).toContain("$15.50");
  });

  it("answers for card-present rather than falling through", () => {
    // `terminal` is documented as never being a shop setting, but the DB enum
    // permits it. A total function has to have an answer; the honest one is
    // that card-present is still paying at the shop.
    expect(describeDepositPolicy({ ...base, paymentsMode: "terminal" })).toBe(
      "none - pay at the shop",
    );
  });

  it("covers the other three modes", () => {
    expect(describeDepositPolicy({ ...base, paymentsMode: "ahead" })).toBe(
      "full payment collected at booking time",
    );
    expect(describeDepositPolicy({ ...base, paymentsMode: "hold" })).toBe(
      "card authorized at booking, charged after the appointment",
    );
    expect(describeDepositPolicy(base)).toBe("none - pay at the shop");
  });
});

describe("describeShopPolicy", () => {
  it("leads with the shop's own numbers", () => {
    const line = describeShopPolicy({
      paymentsMode: "deposit",
      cancelWindowHours: 24,
      cancelFeeBps: 10000,
      depositAmountCents: 2000,
      paymentsLive: true,
    });
    expect(line).toContain("free up to 24h before");
    expect(line).toContain("100%");
    expect(line).toContain("$20");
  });

  it("🔴 warns when a configured fee cannot actually be charged", () => {
    // Payments off + a fee configured = an inert rule. Quoting the fee without
    // saying so is true and misleading at the same time.
    const line = describeShopPolicy({
      ...base,
      cancelWindowHours: 24,
      cancelFeeBps: 5000,
    });
    expect(line).toContain("cannot actually be charged");
  });

  it("does not add the warning when payments are on, or when there is no fee", () => {
    expect(
      describeShopPolicy({
        paymentsMode: "ahead",
        cancelWindowHours: 24,
        cancelFeeBps: 5000,
        depositAmountCents: null,
        paymentsLive: true,
      }),
    ).not.toContain("cannot actually be charged");
    expect(describeShopPolicy(base)).not.toContain("cannot actually be charged");
  });
});

describe("channel and capability — the regression this file shipped once", () => {
  const depositShop: ShopPolicyInput = {
    paymentsMode: "deposit",
    cancelWindowHours: 24,
    cancelFeeBps: 5000,
    depositAmountCents: 2000,
    paymentsLive: true,
    requiresApproval: false,
  };

  it("🔴 a channel that collects NOTHING must not promise a deposit", () => {
    // THE REGRESSION, pinned. The receptionist's book_appointment writes an
    // Appointment and no Payment - it cannot take money. Fixing the enum gap
    // made this sentence say "$20 deposit collected at booking" on the one
    // channel where that is never true. Both halves have to be said.
    const sms = describeDepositPolicy(depositShop, { collectsAtBooking: false });
    expect(sms).toContain("$20");
    expect(sms).toContain("booking online");
    expect(sms).toContain("takes nothing up front");
    expect(sms).not.toMatch(/deposit collected at booking(?!.*online)/);
  });

  it("a channel that DOES collect still describes the charge", () => {
    const web = describeDepositPolicy(depositShop, { collectsAtBooking: true });
    expect(web).toContain("$20");
    expect(web).not.toContain("takes nothing up front");
  });

  it("🔴 intent is not capability: Connect not live means nothing is collected", () => {
    // A shop can sit in deposit mode through the whole of Stripe onboarding.
    expect(describeDepositPolicy({ ...depositShop, paymentsLive: false })).toBe(
      "none - pay at the shop",
    );
  });

  it("approval-mode shops charge on approval, not at booking", () => {
    expect(describeDepositPolicy({ ...depositShop, requiresApproval: true })).toBe(
      "none - pay at the shop",
    );
  });

  it("🔴 an uncollectable fee is quoted to NOBODY as a fee", () => {
    // cancelAppointment takes the fee out of what was COLLECTED. With no
    // payment there is no fee, whatever the settings say - so telling a
    // customer we keep 50% is a threat we cannot carry out.
    const noMoney = { ...depositShop, paymentsLive: false };
    expect(describeCancellationPolicy(noMoney)).toBe(
      "free cancellation any time before the appointment",
    );
    expect(describeCancellationPolicy(depositShop, { collectsAtBooking: false })).toBe(
      "free cancellation any time before the appointment",
    );
  });

  it("says 'of what was collected', not 'of the price'", () => {
    // The engine computes the fee from the captured amount. On a $60 service
    // with a $20 deposit and a 50% fee that is $10, not $30.
    expect(describeCancellationPolicy(depositShop)).toContain("of what was collected");
  });

  it("the OWNER view still names an inert fee, because that is worth hearing", () => {
    const owner = describeShopPolicy({ ...depositShop, paymentsLive: false });
    expect(owner).toContain("50%");
    expect(owner).toContain("cannot actually be charged");
  });
});

describe("cancellationFeeCents — the ONE formula the engine charges with", () => {
  const start = new Date("2026-06-10T15:00:00Z");
  const policy = { cancelWindowHours: 12, cancelFeeBps: 5000 };

  it("keeps the configured share inside the window", () => {
    expect(
      cancellationFeeCents({
        collectedCents: 4000,
        ...policy,
        startsAt: start,
        now: new Date("2026-06-10T10:00:00Z"), // 5h before: inside 12h
      }),
    ).toBe(2000);
  });

  it("is zero outside the window", () => {
    expect(
      cancellationFeeCents({
        collectedCents: 4000,
        ...policy,
        startsAt: start,
        now: new Date("2026-06-09T10:00:00Z"), // 29h before
      }),
    ).toBe(0);
  });

  it("🔴 is zero when nothing was collected, whatever the settings say", () => {
    // The receptionist collects nothing, and a shop with payments off has no
    // payment row. A fee with nothing to take it from is not a fee - which is
    // exactly why "no worries, cancelled" was TRUE for those clients and
    // FALSE for the ones who had paid on the website.
    expect(
      cancellationFeeCents({
        collectedCents: 0,
        ...policy,
        startsAt: start,
        now: new Date("2026-06-10T10:00:00Z"),
      }),
    ).toBe(0);
  });

  it("is zero without both a window and a rate", () => {
    const inside = new Date("2026-06-10T10:00:00Z");
    expect(
      cancellationFeeCents({ collectedCents: 4000, cancelWindowHours: 0, cancelFeeBps: 5000, startsAt: start, now: inside }),
    ).toBe(0);
    expect(
      cancellationFeeCents({ collectedCents: 4000, cancelWindowHours: 12, cancelFeeBps: 0, startsAt: start, now: inside }),
    ).toBe(0);
  });

  it("floors to whole cents, matching the engine", () => {
    expect(
      cancellationFeeCents({
        collectedCents: 3333,
        cancelWindowHours: 12,
        cancelFeeBps: 3333,
        startsAt: start,
        now: new Date("2026-06-10T10:00:00Z"),
      }),
    ).toBe(Math.floor((3333 * 3333) / 10000));
  });
});

describe("describeNoShowPolicy", () => {
  const paying: ShopPolicyInput = {
    paymentsMode: "deposit",
    cancelWindowHours: 0,
    cancelFeeBps: 0,
    depositAmountCents: 2000,
    paymentsLive: true,
    requiresApproval: false,
  };

  it("a paid booking is kept on a no-show - nothing is refunded", () => {
    expect(describeNoShowPolicy(paying)).toContain("not refunded");
  });

  it("🔴 a channel that collected nothing has nothing to keep, and says to cancel instead", () => {
    // The receptionist takes no money. Threatening a no-show fee there is a
    // threat with nothing behind it; the honest, useful line is "cancel so the
    // slot can go to someone else".
    const line = describeNoShowPolicy(paying, { collectsAtBooking: false });
    expect(line).toContain("no charge");
    expect(line).toContain("cancel");
    expect(line).not.toContain("not refunded");
  });
});

/**
 * Card on file: a card is KEPT at booking and nothing is charged. The prose
 * has to hold two things apart that the mode alone blurs - whether a card is
 * saved, and whether it can ever be charged - because a shop that switches the
 * mode on has not, by that act, decided to charge anybody.
 */
describe("card on file", () => {
  const base = { paymentsMode: "card_on_file" as const, cancelWindowHours: 24, cancelFeeBps: 5000 };

  it("says a card is kept and NOT charged while the fee switch is off", () => {
    const s = describeDepositPolicy(base);
    expect(s).toMatch(/no charge at booking/);
    expect(s).toMatch(/card is kept on file/);
    expect(s).toMatch(/not charged unless/);
    expect(describeNoShowPolicy(base)).toMatch(/no charge for a no-show/);
  });

  it("names the one condition once the switch is on", () => {
    const on = { ...base, chargeCardOnFileFees: true };
    expect(describeDepositPolicy(on)).toMatch(/charged only for a no-show or a cancellation inside/);
    expect(describeNoShowPolicy(on)).toMatch(/charged to the card on file/);
  });

  it("🔴 a channel that cannot save a card says so, whatever the switch", () => {
    const on = { ...base, chargeCardOnFileFees: true };
    expect(describeDepositPolicy(on, { collectsAtBooking: false })).toBe("none up front - pay at the shop");
    expect(describeNoShowPolicy(on, { collectsAtBooking: false })).toMatch(/no charge for a no-show/);
    // Intent is not capability: Connect not live means no card was ever kept.
    expect(describeDepositPolicy({ ...on, paymentsLive: false })).toBe("none up front - pay at the shop");
    expect(describeNoShowPolicy({ ...on, paymentsLive: false })).toMatch(/no charge for a no-show/);
  });

  it("collects no money, so the cancellation-fee formula still yields nothing from nothing", () => {
    expect(
      cancellationFeeCents({
        collectedCents: 0,
        cancelWindowHours: 24,
        cancelFeeBps: 5000,
        startsAt: new Date("2026-09-10T15:00:00Z"),
        now: new Date("2026-09-10T10:00:00Z"),
      }),
    ).toBe(0);
  });
});
