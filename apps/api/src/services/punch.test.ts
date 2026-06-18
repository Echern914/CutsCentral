import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  adjustLedgerEntry,
  earnPunchForVisit,
  grantBonusPunches,
  redeemReward,
  reverseLedgerEntry,
} from "./punch.js";

/**
 * Earn-rule engine at the service level: base rate, service overrides,
 * idempotency, and reward-specific redemption.
 */
let userId: string;
let shopId: string;
let clientId: string;
let seq = 0;

async function makeVisit(serviceName: string | null): Promise<string> {
  const v = await forShop(shopId).visit.upsert({
    where: {
      shopId_acuityAppointmentId: { shopId, acuityAppointmentId: `pe-${++seq}` },
    },
    create: {
      clientId,
      acuityAppointmentId: `pe-${seq}`,
      status: "COMPLETED",
      scheduledAt: new Date("2026-05-01T15:00:00Z"),
      serviceName,
    },
    update: {},
  });
  return v.id;
}

async function balance(): Promise<number> {
  const agg = await prisma.punchLedger.aggregate({
    where: { shopId, clientId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `pe-${randomToken(6)}@test.local`, passwordHash: "x", name: "PE" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Earn Rules Cuts",
      bookingUrl: "https://pe.test",
      punchesPerVisit: 2, // base rate: every visit earns 2
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
  const client = await forShop(shopId).client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: "tel:+13025550042" } },
    create: { acuityClientKey: "tel:+13025550042", magicToken: randomToken() },
    update: {},
  });
  clientId = client.id;
  // Two rules; the first match by sortOrder must win.
  await forShop(shopId).earnRule.create({
    data: { serviceMatch: "Premium", punches: 5, sortOrder: 0 },
  });
  await forShop(shopId).earnRule.create({
    data: { serviceMatch: "beard", punches: 3, sortOrder: 1 },
  });
  await forShop(shopId).earnRule.create({
    data: { serviceMatch: "kids", punches: 1, active: false, sortOrder: 2 },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const earnShop = () => ({ id: shopId, punchesPerVisit: 2 });

describe("earn rules", () => {
  it("earns the shop's base rate when no rule matches", async () => {
    const visitId = await makeVisit("Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut");
    const entry = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(entry?.punchesEarned).toBe(2);
  });

  it("a matching service rule overrides the base rate (case-insensitive)", async () => {
    const visitId = await makeVisit("Cut + Beard Trim");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Cut + Beard Trim");
    const entry = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(entry?.punchesEarned).toBe(3);
  });

  it("first matching rule by sortOrder wins", async () => {
    const visitId = await makeVisit("Premium Cut + Beard");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Premium Cut + Beard");
    const entry = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(entry?.punchesEarned).toBe(5);
  });

  it("inactive rules never fire", async () => {
    const visitId = await makeVisit("Kids Cut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Kids Cut");
    const entry = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(entry?.punchesEarned).toBe(2); // base, not the paused 1
  });

  it("earning is idempotent per visit", async () => {
    const before = await balance();
    const visitId = await makeVisit("Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut");
    const entries = await prisma.punchLedger.findMany({ where: { visitId } });
    expect(entries).toHaveLength(1);
    expect(await balance()).toBe(before + 2);
  });
});

describe("redeemReward", () => {
  it("redeems a specific reward and records it in the ledger", async () => {
    const reward = await forShop(shopId).reward.create({
      data: { name: "Free Lineup", punchCost: 3 },
    });
    const before = await balance();
    const result = await redeemReward(shopId, clientId, reward.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newBalance).toBe(before - 3);
      expect(result.reward.name).toBe("Free Lineup");
    }
  });

  it("refuses when the balance is short", async () => {
    const reward = await forShop(shopId).reward.create({
      data: { name: "Grail Package", punchCost: 100 },
    });
    const result = await redeemReward(shopId, clientId, reward.id);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "insufficient_punches") {
      expect(result.required).toBe(100);
    } else {
      expect.fail("expected insufficient_punches");
    }
  });

  it("refuses a reward that is not on this shop's menu", async () => {
    const result = await redeemReward(shopId, clientId, "not-a-reward");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reward_not_found");
  });
});

describe("reverseLedgerEntry (undo a punch)", () => {
  it("undoing a bonus writes an offsetting correction and restores the balance", async () => {
    const before = await balance();
    await grantBonusPunches(shopId, clientId, 3);
    const entry = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, note: "bonus" },
      orderBy: { createdAt: "desc" },
    });
    expect(await balance()).toBe(before + 3);

    const result = await reverseLedgerEntry(shopId, clientId, entry!.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newBalance).toBe(before);
    // Balance is back where it started; the original row is preserved + flagged.
    expect(await balance()).toBe(before);
    const original = await prisma.punchLedger.findUnique({ where: { id: entry!.id } });
    expect(original?.reversedAt).not.toBeNull();
    // The correction points back at the original and is itself an offset.
    const correction = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, reversalOfId: entry!.id },
    });
    expect(correction?.punchesRedeemed).toBe(3);
    expect(correction?.punchesEarned).toBe(0);
  });

  it("undoing a redemption gives the punches back", async () => {
    const reward = await forShop(shopId).reward.create({
      data: { name: "Undo Me", punchCost: 2 },
    });
    await grantBonusPunches(shopId, clientId, 5); // make sure we can afford it
    const before = await balance();
    const redeem = await redeemReward(shopId, clientId, reward.id);
    expect(redeem.ok).toBe(true);
    const redemption = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, rewardId: reward.id, punchesRedeemed: { gt: 0 } },
      orderBy: { createdAt: "desc" },
    });

    const result = await reverseLedgerEntry(shopId, clientId, redemption!.id);
    expect(result.ok).toBe(true);
    expect(await balance()).toBe(before); // punches returned
  });

  it("refuses to reverse the same entry twice", async () => {
    await grantBonusPunches(shopId, clientId, 1);
    const entry = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, note: "bonus" },
      orderBy: { createdAt: "desc" },
    });
    const first = await reverseLedgerEntry(shopId, clientId, entry!.id);
    expect(first.ok).toBe(true);
    const second = await reverseLedgerEntry(shopId, clientId, entry!.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_reversed");
  });

  it("refuses to reverse a correction row (no undo-the-undo)", async () => {
    await grantBonusPunches(shopId, clientId, 1);
    const entry = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, note: "bonus" },
      orderBy: { createdAt: "desc" },
    });
    await reverseLedgerEntry(shopId, clientId, entry!.id);
    const correction = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, reversalOfId: entry!.id },
    });
    const result = await reverseLedgerEntry(shopId, clientId, correction!.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("is_a_correction");
  });

  it("404s an entry id from another client", async () => {
    await grantBonusPunches(shopId, clientId, 1);
    const entry = await prisma.punchLedger.findFirst({
      where: { shopId, clientId },
      orderBy: { createdAt: "desc" },
    });
    const result = await reverseLedgerEntry(shopId, "not-this-client", entry!.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entry_not_found");
  });

  // Regression for the ingest claw-back orphan bug: when a barber manually undoes
  // a VISIT's earn and Acuity later cancels/no-shows that visit, the claw-back
  // must remove BOTH the earn (visitId set) AND its correction (visitId null,
  // reversalOfId = earn.id). Deleting only by visitId would orphan the
  // correction and silently understate the balance. This asserts the correction
  // is reachable via reversalOfId = earn.id (the exact key ingest's cleanup uses)
  // and that the two-step delete leaves a clean, correct balance.
  it("a reversed visit-earn's correction is removable by the visit claw-back", async () => {
    const before = await balance();
    const visitId = await makeVisit("Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut"); // +2
    const earn = await prisma.punchLedger.findUnique({ where: { visitId } });
    await reverseLedgerEntry(shopId, clientId, earn!.id); // barber undoes it
    expect(await balance()).toBe(before); // earn + correction net to 0

    // The correction is discoverable by reversalOfId = earn.id (ingest's key).
    const correction = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, reversalOfId: earn!.id },
    });
    expect(correction).not.toBeNull();
    expect(correction!.visitId).toBeNull(); // why a visitId-only delete misses it

    // Simulate ingest's claw-back (delete correction(s) THEN the earn).
    await prisma.punchLedger.deleteMany({ where: { reversalOfId: earn!.id } });
    await prisma.punchLedger.deleteMany({ where: { visitId } });

    // No orphan left; balance is exactly back to where it started (not under).
    const leftover = await prisma.punchLedger.findMany({
      where: { shopId, clientId, OR: [{ visitId }, { reversalOfId: earn!.id }] },
    });
    expect(leftover).toHaveLength(0);
    expect(await balance()).toBe(before);
  });
});

describe("adjustLedgerEntry (edit an earn's punch count)", () => {
  it("re-counts an earn up and nets the difference into the balance", async () => {
    const visitId = await makeVisit("Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut"); // base 2
    const before = await balance();
    const earn = await prisma.punchLedger.findUnique({ where: { visitId } });

    const result = await adjustLedgerEntry(shopId, clientId, earn!.id, 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newBalance).toBe(before + 3); // 2 -> 5 = +3
    expect(await balance()).toBe(before + 3);
    // Original earn is reversed; an offsetting correction links back to it.
    const original = await prisma.punchLedger.findUnique({ where: { id: earn!.id } });
    expect(original?.reversedAt).not.toBeNull();
    const reversal = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, reversalOfId: earn!.id },
    });
    expect(reversal?.punchesRedeemed).toBe(2); // offsets the original +2
    // A FRESH corrected earn exists. Pin on the "corrected:" note (unique to the
    // re-grant) so this asserts the regrant ROW, not some stale +5 earn from an
    // earlier suite sharing this client.
    const corrected = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, note: { startsWith: "corrected:" } },
      orderBy: { createdAt: "desc" },
    });
    expect(corrected?.punchesEarned).toBe(5);
    expect(corrected?.reversalOfId).toBeNull();
  });

  it("re-counts an earn DOWN to a smaller positive value (the headline fix)", async () => {
    const visitId = await makeVisit("Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut"); // base 2
    // Bump it to 5 first so there's unspent room to shrink back down.
    const earn = await prisma.punchLedger.findUnique({ where: { visitId } });
    await adjustLedgerEntry(shopId, clientId, earn!.id, 5);
    const fresh = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, note: { startsWith: "corrected:" } },
      orderBy: { createdAt: "desc" },
    });
    const before = await balance();

    // Edit DOWN 5 -> 2 (a barber gave too many): net -3, still positive.
    const result = await adjustLedgerEntry(shopId, clientId, fresh!.id, 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newBalance).toBe(before - 3);
    expect(await balance()).toBe(before - 3);
  });

  it("refuses to edit a redemption (not an earn)", async () => {
    const reward = await forShop(shopId).reward.create({
      data: { name: "Not Editable", punchCost: 1 },
    });
    await grantBonusPunches(shopId, clientId, 3);
    await redeemReward(shopId, clientId, reward.id);
    const redemption = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, rewardId: reward.id, punchesRedeemed: { gt: 0 } },
      orderBy: { createdAt: "desc" },
    });
    const result = await adjustLedgerEntry(shopId, clientId, redemption!.id, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_an_earn");
  });

  it("refuses an edit that would drive the balance negative", async () => {
    // Earn a small amount, spend it, then try to shrink the earn below 0 net.
    const visitId = await makeVisit("Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut"); // +2
    const earn = await prisma.punchLedger.findUnique({ where: { visitId } });
    // Drain the balance to exactly 0 via a redemption equal to current balance.
    const bal = await balance();
    const reward = await forShop(shopId).reward.create({
      data: { name: "Drain", punchCost: bal },
    });
    await redeemReward(shopId, clientId, reward.id);
    expect(await balance()).toBe(0);
    // Re-counting that earn down to 1 removes a punch already spent -> negative.
    const result = await adjustLedgerEntry(shopId, clientId, earn!.id, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("would_go_negative");
  });
});
