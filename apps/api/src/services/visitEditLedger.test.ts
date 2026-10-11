import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  adjustLedgerEntry,
  earnPunchForVisit,
  redeemReward,
  reverseLedgerEntry,
} from "./punch.js";
import { deleteVisit, editVisit } from "./visit.js";
import { creditPastVisits } from "./pastVisitCredit.js";

/**
 * 🔴 AN EDIT TO A VISIT NEVER UNDOES WHAT A PERSON DID TO ITS PUNCH.
 *
 * A shop undoes a duplicate punch ("this visit was logged twice"), then fixes
 * the visit's date - and the punch came back. editVisit read an undone earn as
 * "0 punches live", saw the rule amount differ, clawed back and earned again,
 * on ANY edit. The same path replaced a re-counted punch with the rule's
 * amount, and its negative-balance guard (and deleteVisit's) counted the
 * re-count's regrant as nothing. A date-only edit also re-priced the punch
 * under today's settings. And crediting past visits must not then pay such a
 * visit again.
 */

let userId = "";
let shopId = "";
let clientId = "";
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const shop = (punchesPerVisit = 1) => ({ id: shopId, punchesPerVisit });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `vel-${randomToken(6)}@test.local`, passwordHash: "x", name: "VEL" },
  });
  userId = user.id;
  shopId = (
    await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Edit Ledger",
        slug: `vel-${randomToken(5)}`,
        webhookSecret: randomToken(),
        rewardsEnabled: true,
        punchesPerVisit: 1,
      },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { shopId, acuityClientKey: `vel-${randomToken(8)}`, magicToken: randomToken() },
    })
  ).id;
  await prisma.earnRule.create({ data: { shopId, serviceMatch: "deluxe", punches: 3 } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

async function balance(cardTypeId: string | null = null): Promise<number> {
  const agg = await prisma.punchLedger.aggregate({
    where: { shopId, clientId, cardTypeId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}
const ledgerRows = () => prisma.punchLedger.count({ where: { shopId, clientId } });

/** A completed visit with its punch, `days` ago. */
async function punchedVisit(days: number, serviceName = "Standard") {
  const at = daysAgo(days);
  const visit = await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `manual:${randomToken(8)}`,
      status: "COMPLETED",
      scheduledAt: at,
      endAt: new Date(at.getTime() + 30 * 60_000),
      completedAt: at,
      serviceName,
    },
  });
  const earn = await earnPunchForVisit(shop(), clientId, visit.id, serviceName, at);
  expect(earn).not.toBeNull();
  const row = await prisma.punchLedger.findUniqueOrThrow({ where: { visitId: visit.id } });
  return { visitId: visit.id, earnId: row.id };
}

describe("🔴 a punch the shop undid stays undone", () => {
  it("fixing the date does not bring it back - no new earn, balance unchanged", async () => {
    const start = await balance();
    const { visitId, earnId } = await punchedVisit(20);
    await reverseLedgerEntry(shopId, clientId, earnId, { actorUserId: null, reason: "duplicate visit" });
    expect(await balance()).toBe(start);
    const rows = await ledgerRows();

    const when = daysAgo(18);
    const r = await editVisit(shop(), clientId, visitId, { when });
    expect(r).toEqual({ ok: true, balance: start });
    expect(await balance()).toBe(start);
    expect(await ledgerRows()).toBe(rows);
    // The undone earn keeps its link, so the visit still reads as "had its punch".
    const earn = await prisma.punchLedger.findUniqueOrThrow({ where: { id: earnId } });
    expect(earn.visitId).toBe(visitId);
    expect(earn.reversedAt).not.toBeNull();
    // The date itself did change.
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visitId } })).scheduledAt).toEqual(when);
  });

  it("changing the service does not bring it back either", async () => {
    const start = await balance();
    const { visitId, earnId } = await punchedVisit(21);
    await reverseLedgerEntry(shopId, clientId, earnId);
    const rows = await ledgerRows();
    expect(await editVisit(shop(), clientId, visitId, { serviceName: "Deluxe Cut" })).toMatchObject({ ok: true });
    expect(await balance()).toBe(start);
    expect(await ledgerRows()).toBe(rows);
  });

  it("asking to move it to another card is refused, with nothing changed", async () => {
    const card = await prisma.cardType.create({
      data: { shopId, name: "Color", serviceMatch: ["color"], punchesPerVisit: 2 },
    });
    const { visitId, earnId } = await punchedVisit(22);
    const before = (await prisma.visit.findUniqueOrThrow({ where: { id: visitId } })).scheduledAt;
    await reverseLedgerEntry(shopId, clientId, earnId);
    const rows = await ledgerRows();
    const r = await editVisit(shop(), clientId, visitId, { when: daysAgo(23), cardTypeId: card.id });
    expect(r).toMatchObject({ ok: false, reason: "punch_set_by_hand" });
    expect(await ledgerRows()).toBe(rows);
    expect(await balance(card.id)).toBe(0);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visitId } })).scheduledAt).toEqual(before);
  });
});

describe("🔴 a re-counted punch keeps the count a person gave it", () => {
  it("a date edit and a service edit both leave the edited count alone", async () => {
    const start = await balance();
    const { visitId, earnId } = await punchedVisit(30);
    await adjustLedgerEntry(shopId, clientId, earnId, 2, { actorUserId: null, reason: "double cut" });
    expect(await balance()).toBe(start + 2);
    const rows = await ledgerRows();

    expect(await editVisit(shop(), clientId, visitId, { when: daysAgo(29) })).toEqual({ ok: true, balance: start + 2 });
    // "Deluxe" earns 3 by rule; the person said 2.
    expect(await editVisit(shop(), clientId, visitId, { serviceName: "Deluxe" })).toEqual({ ok: true, balance: start + 2 });
    expect(await balance()).toBe(start + 2);
    expect(await ledgerRows()).toBe(rows);
  });

  it("deleting the visit is refused when its re-counted punches were already spent", async () => {
    // A fresh client, so the spend is exactly this visit's punches.
    const solo = (
      await prisma.client.create({
        data: { shopId, acuityClientKey: `vel-${randomToken(8)}`, magicToken: randomToken() },
      })
    ).id;
    const at = daysAgo(40);
    const visit = await prisma.visit.create({
      data: { shopId, clientId: solo, acuityAppointmentId: `manual:${randomToken(8)}`, status: "COMPLETED", scheduledAt: at, completedAt: at },
    });
    await earnPunchForVisit(shop(), solo, visit.id, null, at); // +1
    const earn = await prisma.punchLedger.findUniqueOrThrow({ where: { visitId: visit.id } });
    await adjustLedgerEntry(shopId, solo, earn.id, 3); // 1 -> 3
    const reward = await prisma.reward.create({ data: { shopId, name: "Free cut", punchCost: 3 } });
    expect(await redeemReward(shopId, solo, reward.id)).toMatchObject({ ok: true, newBalance: 0 });

    // Taking the visit back would take the 3 re-counted punches back out of a
    // balance of 0. The guard used to count them as nothing and let it through.
    const r = await deleteVisit(shopId, solo, visit.id);
    expect(r).toEqual({ ok: false, reason: "would_go_negative", balance: 0 });
    const agg = await prisma.punchLedger.aggregate({
      where: { shopId, clientId: solo },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    expect((agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0)).toBe(0);
    expect(await prisma.visit.count({ where: { id: visit.id } })).toBe(1);
  });
});

describe("a date-only edit leaves the ledger alone", () => {
  it("does not re-price the punch under today's settings", async () => {
    const start = await balance();
    const { visitId } = await punchedVisit(50); // earned 1
    const rows = await ledgerRows();
    // The shop now gives 2 a visit; fixing an old visit's date changes nothing.
    expect(await editVisit(shop(2), clientId, visitId, { when: daysAgo(49) })).toEqual({ ok: true, balance: start + 1 });
    expect(await ledgerRows()).toBe(rows);
  });

  it("still re-earns when the new date moves the visit into a promotion", async () => {
    await prisma.promotion.create({
      data: {
        shopId,
        kind: "EXTRA_PUNCHES",
        title: "Double week",
        extraPunches: 1,
        active: true,
        startsAt: daysAgo(64),
        endsAt: daysAgo(60),
      },
    });
    const start = await balance();
    const { visitId } = await punchedVisit(70); // outside the promo: 1
    expect(await balance()).toBe(start + 1);
    expect(await editVisit(shop(), clientId, visitId, { when: daysAgo(62) })).toEqual({ ok: true, balance: start + 2 });
    const live = await prisma.punchLedger.findUniqueOrThrow({ where: { visitId } });
    expect(live.punchesEarned).toBe(2);
  });

  it("does not hand a never-punched visit its first punch", async () => {
    const at = daysAgo(80);
    const visit = await prisma.visit.create({
      data: { shopId, clientId, acuityAppointmentId: `manual:${randomToken(8)}`, status: "COMPLETED", scheduledAt: at, completedAt: at },
    });
    const rows = await ledgerRows();
    expect(await editVisit(shop(), clientId, visit.id, { when: daysAgo(79) })).toMatchObject({ ok: true });
    expect(await ledgerRows()).toBe(rows);
  });
});

describe("🔴 crediting past visits does not pay an undone punch again", () => {
  it("an undone punch on a visit from before rewards started is not re-credited, even after an edit", async () => {
    // Its own shop: rewards started a day ago, and this visit is older.
    const other = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Edit Ledger Credit",
        slug: `vel-c-${randomToken(5)}`,
        webhookSecret: randomToken(),
        rewardsEnabled: true,
        rewardsStartedAt: daysAgo(1),
        punchesPerVisit: 1,
      },
    });
    const c = (
      await prisma.client.create({
        data: { shopId: other.id, acuityClientKey: `vel-${randomToken(8)}`, magicToken: randomToken() },
      })
    ).id;
    const at = daysAgo(10);
    const visit = await prisma.visit.create({
      data: {
        shopId: other.id,
        clientId: c,
        acuityAppointmentId: `manual:${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: at,
        endAt: at,
        completedAt: at,
      },
    });
    // Logged by hand before the start (a person chose it), then undone.
    const earnShop = { id: other.id, punchesPerVisit: 1 };
    const { runWithShop } = await import("@chairback/db");
    const { earnPunchForVisitInTx } = await import("./punch.js");
    await runWithShop(other.id, (tx) =>
      earnPunchForVisitInTx(tx, earnShop, c, visit.id, null, at, { evenBeforeStart: true }),
    );
    const earn = await prisma.punchLedger.findUniqueOrThrow({ where: { visitId: visit.id } });
    await reverseLedgerEntry(other.id, c, earn.id);
    await editVisit(earnShop, c, visit.id, { when: daysAgo(9) });

    expect(await creditPastVisits(other.id, 3, "preview")).toMatchObject({ visits: 0 });
    expect(await creditPastVisits(other.id, 3, "credit")).toMatchObject({ visits: 0, punches: 0 });
    const agg = await prisma.punchLedger.aggregate({
      where: { shopId: other.id, clientId: c },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    expect((agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0)).toBe(0);
  });
});
