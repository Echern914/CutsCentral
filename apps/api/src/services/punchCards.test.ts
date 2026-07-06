import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  adjustLedgerEntry,
  cardBalances,
  currentBalance,
  earnPunchForVisit,
  grantBonusPunches,
  redeemReward,
  reverseLedgerEntry,
} from "./punch.js";

/**
 * Punch card TYPES at the service level: which card a visit's earn routes to
 * (service match, sortOrder priority, exclusive gating, barber override), that
 * balances are per-card, and that redemption/undo/edit stay inside one card.
 *
 * The DEFAULT card is cardTypeId null everywhere - punch.test.ts (untouched)
 * is the proof that zero-card shops behave exactly as before cards existed.
 */
let userId: string;
let shopId: string;
let clientId: string;
let cutsCardId: string; // matches "cut", 1 punch/visit, first priority
let retwistCardId: string; // matches "retwist"/"twist", 2 punches/visit
let vipCardId: string; // exclusive, matches "vip cut"
let pausedCardId: string; // inactive, matches "fade" - must never route
let seq = 0;

async function makeVisit(serviceName: string | null): Promise<string> {
  const v = await forShop(shopId).visit.upsert({
    where: {
      shopId_acuityAppointmentId: { shopId, acuityAppointmentId: `pc-${++seq}` },
    },
    create: {
      clientId,
      acuityAppointmentId: `pc-${seq}`,
      status: "COMPLETED",
      scheduledAt: new Date("2026-05-01T15:00:00Z"),
      serviceName,
    },
    update: {},
  });
  return v.id;
}

const earnShop = () => ({ id: shopId, punchesPerVisit: 1 });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `pc-${randomToken(6)}@test.local`, passwordHash: "x", name: "PC" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Card Types Cuts",
      bookingUrl: "https://pc.test",
      punchesPerVisit: 1,
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
  const client = await forShop(shopId).client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: "tel:+13025550777" } },
    create: { acuityClientKey: "tel:+13025550777", magicToken: randomToken() },
    update: {},
  });
  clientId = client.id;

  // Routing order matters: "VIP Cut" contains both "vip cut" AND "cut", so the
  // exclusive VIP card is FIRST by sortOrder - an ungranted client must fall
  // through it to the Cuts card, not stop dead.
  const vip = await forShop(shopId).cardType.create({
    data: {
      name: "VIP",
      serviceMatch: ["vip cut"],
      punchesPerVisit: 3,
      exclusive: true,
      sortOrder: 0,
    },
  });
  vipCardId = vip.id;
  const paused = await forShop(shopId).cardType.create({
    data: { name: "Paused", serviceMatch: ["fade"], active: false, sortOrder: 1 },
  });
  pausedCardId = paused.id;
  const retwist = await forShop(shopId).cardType.create({
    data: { name: "Retwist", serviceMatch: ["retwist", "twist"], punchesPerVisit: 2, sortOrder: 2 },
  });
  retwistCardId = retwist.id;
  const cuts = await forShop(shopId).cardType.create({
    data: { name: "Cuts", serviceMatch: ["cut"], punchesPerVisit: 1, sortOrder: 3 },
  });
  cutsCardId = cuts.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("earn routing to card types", () => {
  it("routes a matching service to its card and earns the card's rate", async () => {
    const visitId = await makeVisit("Loc Retwist");
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, "Loc Retwist");
    expect(earn?.cardTypeId).toBe(retwistCardId);
    expect(earn?.cardName).toBe("Retwist");
    expect(earn?.earned).toBe(2); // the card's punchesPerVisit, not the shop's
    const row = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(row?.cardTypeId).toBe(retwistCardId);
  });

  it("no matching card falls back to the default card (cardTypeId null)", async () => {
    const visitId = await makeVisit("Hot Towel Shave");
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, "Hot Towel Shave");
    expect(earn?.cardTypeId).toBeNull();
    expect(earn?.cardName).toBeNull();
    expect(earn?.earned).toBe(1); // shop base rate
  });

  it("a null service name always lands on the default card", async () => {
    const visitId = await makeVisit(null);
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, null);
    expect(earn?.cardTypeId).toBeNull();
  });

  it("an inactive card never routes", async () => {
    const visitId = await makeVisit("Skin Fade");
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, "Skin Fade");
    expect(earn?.cardTypeId).toBeNull(); // "fade" card is paused
  });

  it("an exclusive card is SKIPPED for an ungranted client (falls through)", async () => {
    // "VIP Cut" matches the VIP card (sortOrder 0) AND the Cuts card ("cut").
    const visitId = await makeVisit("VIP Cut");
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, "VIP Cut");
    expect(earn?.cardTypeId).toBe(cutsCardId); // fell through VIP to Cuts
  });

  it("an exclusive card routes once the client is granted", async () => {
    await prisma.cardGrant.create({
      data: { shopId, cardTypeId: vipCardId, clientId },
    });
    const visitId = await makeVisit("VIP Cut");
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, "VIP Cut");
    expect(earn?.cardTypeId).toBe(vipCardId);
    expect(earn?.earned).toBe(3);
    await prisma.cardGrant.deleteMany({ where: { cardTypeId: vipCardId, clientId } });
  });

  it("barber override beats auto-routing", async () => {
    const visitId = await makeVisit("Loc Retwist"); // would auto-route to Retwist
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, "Loc Retwist", undefined, {
      cardTypeId: cutsCardId,
    });
    expect(earn?.cardTypeId).toBe(cutsCardId);
    expect(earn?.earned).toBe(1); // the OVERRIDDEN card's rate
  });

  it("override with null forces the default card", async () => {
    const visitId = await makeVisit("Loc Retwist");
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, "Loc Retwist", undefined, {
      cardTypeId: null,
    });
    expect(earn?.cardTypeId).toBeNull();
    expect(earn?.earned).toBe(1); // shop base (no EarnRule in this suite)
  });

  it("override-punching an exclusive card grants membership (the punch IS the invite)", async () => {
    expect(
      await prisma.cardGrant.findFirst({ where: { cardTypeId: vipCardId, clientId } }),
    ).toBeNull();
    const visitId = await makeVisit("Regular Cut");
    const earn = await earnPunchForVisit(earnShop(), clientId, visitId, "Regular Cut", undefined, {
      cardTypeId: vipCardId,
    });
    expect(earn?.cardTypeId).toBe(vipCardId);
    const grant = await prisma.cardGrant.findFirst({
      where: { cardTypeId: vipCardId, clientId },
    });
    expect(grant).not.toBeNull();
  });
});

describe("per-card balances", () => {
  it("balances are independent per card and sum via cardBalances", async () => {
    const all = await cardBalances(shopId, clientId);
    const byCard = new Map(all.map((b) => [b.cardTypeId, b.balance]));
    // Cross-check each card's groupBy number against the single-card aggregate.
    for (const [cardTypeId, bal] of byCard) {
      expect(await currentBalance(shopId, clientId, cardTypeId)).toBe(bal);
    }
    // The suite above earned on retwist, default, cuts, and vip separately.
    expect(byCard.get(retwistCardId)).toBeGreaterThan(0);
    expect(byCard.get(null)).toBeGreaterThan(0);
  });

  it("a card-scoped reward redeems from ITS card only", async () => {
    const reward = await forShop(shopId).reward.create({
      data: { name: "Free Retwist", punchCost: 2, cardTypeId: retwistCardId },
    });
    const before = await currentBalance(shopId, clientId, retwistCardId);
    const defaultBefore = await currentBalance(shopId, clientId, null);
    const result = await redeemReward(shopId, clientId, reward.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cardTypeId).toBe(retwistCardId);
      expect(result.cardName).toBe("Retwist");
      expect(result.newBalance).toBe(before - 2);
    }
    // The redemption row carries the card; the default balance is untouched.
    expect(await currentBalance(shopId, clientId, retwistCardId)).toBe(before - 2);
    expect(await currentBalance(shopId, clientId, null)).toBe(defaultBefore);
  });

  it("punches on another card cannot pay for a card-scoped reward", async () => {
    // Client has default-card punches, but this reward draws from the VIP card.
    const vipBalance = await currentBalance(shopId, clientId, vipCardId);
    const reward = await forShop(shopId).reward.create({
      data: { name: "VIP Grail", punchCost: vipBalance + 100, cardTypeId: vipCardId },
    });
    const result = await redeemReward(shopId, clientId, reward.id);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "insufficient_punches") {
      expect(result.balance).toBe(vipBalance); // the VIP card's balance, not the total
    } else {
      expect.fail("expected insufficient_punches");
    }
  });

  it("bonus punches can target a card, and a foreign card id is refused", async () => {
    const before = await currentBalance(shopId, clientId, cutsCardId);
    const ok = await grantBonusPunches(shopId, clientId, 2, cutsCardId);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.cardTypeId).toBe(cutsCardId);
      expect(ok.newBalance).toBe(before + 2);
    }
    const bad = await grantBonusPunches(shopId, clientId, 1, "not-a-card");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("card_not_found");
  });
});

describe("corrections stay inside one card", () => {
  it("undoing a card earn offsets THAT card's balance and copies cardTypeId", async () => {
    const visitId = await makeVisit("Loc Retwist");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Loc Retwist"); // +2 retwist
    const before = await currentBalance(shopId, clientId, retwistCardId);
    const defaultBefore = await currentBalance(shopId, clientId, null);
    const earn = await prisma.punchLedger.findUnique({ where: { visitId } });

    const result = await reverseLedgerEntry(shopId, clientId, earn!.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newBalance).toBe(before - 2); // the CARD's balance
    const correction = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, reversalOfId: earn!.id },
    });
    expect(correction?.cardTypeId).toBe(retwistCardId); // offset lands on the same card
    expect(await currentBalance(shopId, clientId, retwistCardId)).toBe(before - 2);
    expect(await currentBalance(shopId, clientId, null)).toBe(defaultBefore); // untouched
  });

  it("editing a card earn's count keeps correction + regrant on the same card", async () => {
    const visitId = await makeVisit("Loc Retwist");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Loc Retwist"); // +2 retwist
    const before = await currentBalance(shopId, clientId, retwistCardId);
    const earn = await prisma.punchLedger.findUnique({ where: { visitId } });

    const result = await adjustLedgerEntry(shopId, clientId, earn!.id, 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newBalance).toBe(before + 3); // 2 -> 5 on the card
    const correction = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, reversalOfId: earn!.id },
    });
    const regrant = await prisma.punchLedger.findFirst({
      where: { shopId, clientId, correctionOfId: correction!.id },
    });
    expect(correction?.cardTypeId).toBe(retwistCardId);
    expect(regrant?.cardTypeId).toBe(retwistCardId);
    expect(await currentBalance(shopId, clientId, retwistCardId)).toBe(before + 3);
  });

  it("the negative guard is per-card: spending card A doesn't block editing card B", async () => {
    // Drain the retwist card to 0, then shrink a DEFAULT-card earn - allowed,
    // because the default card still has its own punches.
    const retwistBal = await currentBalance(shopId, clientId, retwistCardId);
    if (retwistBal > 0) {
      const drain = await forShop(shopId).reward.create({
        data: { name: "Drain Retwist", punchCost: retwistBal, cardTypeId: retwistCardId },
      });
      const drained = await redeemReward(shopId, clientId, drain.id);
      expect(drained.ok).toBe(true);
    }
    const visitId = await makeVisit("Hot Towel Shave"); // default card
    await earnPunchForVisit(earnShop(), clientId, visitId, "Hot Towel Shave"); // +1 default
    const earn = await prisma.punchLedger.findUnique({ where: { visitId } });
    const before = await currentBalance(shopId, clientId, null);
    const result = await adjustLedgerEntry(shopId, clientId, earn!.id, 3); // 1 -> 3
    expect(result.ok).toBe(true);
    expect(await currentBalance(shopId, clientId, null)).toBe(before + 2);
    // Retwist card is still exactly 0 - the edit never crossed cards.
    expect(await currentBalance(shopId, clientId, retwistCardId)).toBe(0);
  });
});
