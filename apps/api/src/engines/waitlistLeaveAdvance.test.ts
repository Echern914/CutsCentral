import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import {
  __setAdvanceForTests,
  __setConnectEnabledForTests,
  claimOffer,
  declineOffer,
  HOLD_MS,
  leaveWaitlistEntry,
  notifyOffer,
  offerFreedSlot,
  offerLockKey,
  type FreedSlot,
} from "./waitlistOffer.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "./bookingWrite.js";
import { sha256Hex } from "./waitlistJoin.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import {
  holdRowLock,
  raceBehindAdvisoryLock,
  raceBehindBarrier,
  raceBehindRowLock,
} from "../testing/raceBarrier.js";

/**
 * EVERY WAY A HOLD ENDS MOVES THE TIME ON.
 *
 * A waitlist hold used to reach the next person in line only when the expiry
 * sweep found it. Every other ending left the time hidden, or public with
 * nobody told:
 *
 *   - the customer left the list (cancel link): the hold stayed live for up
 *     to half an hour, and the link still booked it for someone who had left;
 *   - the customer tapped too late: the claim marked it expired, and the
 *     sweep, which only reads live holds, never saw it;
 *   - the claim let it go (the shop blocked them mid-hold): nobody advanced;
 *   - the barber removed the entry: the hold stayed live.
 *
 * And two cancellations on different barbers at once could give one person
 * two holds. These tests pin each of those, and the "No thanks" button the
 * offer page gained.
 */

const app = createApp();
const TZ = "America/New_York";

let userId: string;
let shopId: string;
let staffId: string; // Sam
let otherStaffId: string; // Ana
let serviceId: string;
let seq = 0;
let sent: SendEmailInput[] = [];

let slotSeq = 0;
function freshSlot(over: Partial<FreedSlot> = {}): FreedSlot {
  // ~3 days out on a 30-minute boundary, a fresh 2h lane per call.
  const base = Math.ceil((Date.now() + 72 * 3600_000) / 1800_000) * 1800_000;
  const startsAt = new Date(base + slotSeq++ * 2 * 3600_000);
  return {
    shopId,
    staffId,
    serviceId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    timezone: TZ,
    bufferMin: 0,
    ...over,
  };
}

async function makeEntry(over: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: `Leave${seq}`,
      email: `wl-leave-${seq}-${randomToken(4)}@test.local`,
      ...over,
    },
    select: { id: true, email: true },
  });
}

async function offerTo(slot: FreedSlot, now = new Date()) {
  const res = await offerFreedSlot(slot, now);
  expect(res.outcome).toBe("offered");
  if (res.outcome !== "offered") throw new Error("unreachable");
  return res;
}

const liveOffersFor = (entryId: string) =>
  prisma.waitlistOffer.findMany({ where: { entryId, status: "OFFERED" } });

const statusOf = async (entryId: string) =>
  (await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } })).status;

beforeAll(async () => {
  __setAdvanceForTests(true);
  const user = await prisma.user.create({
    data: { email: `wl-leave-${randomToken(6)}@test.local`, name: "L" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Leave Cuts",
      slug: `wl-leave-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: TZ,
      bookingMode: "native",
      waitlistEnabled: true,
      slotOpenedTextsEnabled: true,
      bookingBufferMin: 0,
      bookingLeadHours: 0,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
    select: { id: true },
  });
  shopId = shop.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" } })).id;
  otherStaffId = (await prisma.staff.create({ data: { shopId, name: "Ana" } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30 }, select: { id: true } })
  ).id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId, staffId },
      { shopId, serviceId, staffId: otherStaffId },
    ],
  });
  await prisma.availabilityRule.createMany({
    data: [staffId, otherStaffId].flatMap((sid) =>
      Array.from({ length: 7 }, (_, weekday) => ({
        shopId,
        staffId: sid,
        weekday,
        startMin: 0,
        endMin: 1440,
      })),
    ),
  });
});

afterEach(async () => {
  __setSendEmailForTests(undefined);
  sent = [];
  // Same neutralizing as waitlistOffer.test.ts: no spare WAITING entry or live
  // hold leaks into the next test.
  await prisma.waitlistEntry.updateMany({
    where: { shopId, status: { in: ["WAITING", "CONTACTED"] } },
    data: { status: "REMOVED", dedupeKey: null },
  });
  await prisma.waitlistOffer.updateMany({
    where: { shopId, status: "OFFERED" },
    data: { status: "RELEASED" },
  });
});

afterAll(async () => {
  __setAdvanceForTests(undefined);
  await prisma.waitlistEvent.deleteMany({ where: { shopId } });
  await prisma.waitlistOffer.deleteMany({ where: { shopId } });
  await prisma.waitlistEntry.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.availabilityRule.deleteMany({ where: { shopId } });
  await prisma.serviceStaff.deleteMany({ where: { shopId } });
  await prisma.service.deleteMany({ where: { shopId } });
  await prisma.staff.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

function captureEmails() {
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: "TEST", status: "sent" as const };
  });
}

describe("leaving the waitlist frees the time", () => {
  it("🔴 the cancel link lets go of the live hold and offers it to the next person", async () => {
    captureEmails();
    const token = randomToken(16);
    const leaver = await makeEntry({ cancelTokenHash: sha256Hex(token) });
    const next = await makeEntry();
    const slot = freshSlot();
    const held = await offerTo(slot);
    expect(held.entryId).toBe(leaver.id);
    sent = [];

    const res = await request(app).post(`/api/page/waitlist/cancel/${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(await statusOf(leaver.id)).toBe("REMOVED");
    expect((await prisma.waitlistOffer.findUniqueOrThrow({ where: { id: held.offerId } })).status).toBe(
      "RELEASED",
    );
    const passed = await liveOffersFor(next.id);
    expect(passed).toHaveLength(1);
    expect(passed[0]!.startsAt.getTime()).toBe(slot.startsAt.getTime());
    // The next person is told, the leaver is not.
    expect(sent.map((e) => e.to)).toEqual([next.email]);
  });

  it("🔴 the old link can no longer book it", async () => {
    const leaver = await makeEntry();
    const slot = freshSlot();
    const held = await offerTo(slot);
    expect(held.entryId).toBe(leaver.id);
    await leaveWaitlistEntry({ where: { id: leaver.id, shopId }, source: "cancel_link" });
    const claim = await claimOffer({ token: held.token });
    expect(claim.outcome).toBe("expired");
    expect(await prisma.appointment.count({ where: { shopId, startsAt: slot.startsAt } })).toBe(0);
  });

  it("with nobody else in line, the time is bookable again at once", async () => {
    const leaver = await makeEntry();
    const slot = freshSlot();
    await offerTo(slot);
    const out = await leaveWaitlistEntry({ where: { id: leaver.id, shopId }, source: "cancel_link" });
    expect(out).toMatchObject({ left: true, advanced: 0 });
    // A customer write over the span no longer meets a live hold (this throws
    // SlotTakenError while one lives).
    await prisma.$transaction((tx) =>
      lockStaffAndAssertSlotFree(tx, {
        walkInCapacity: "enforce",
        staffId,
        shopId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: 0,
        serviceDayLimit: null,
        now: new Date(),
      }),
    );
  });

  it("leaving a list you're not on changes nothing", async () => {
    const out = await leaveWaitlistEntry({
      where: { cancelTokenHash: sha256Hex(randomToken(16)) },
      source: "cancel_link",
    });
    expect(out).toEqual({ left: false, shopId: null, advanced: 0 });
  });
});

describe("No thanks on the offer page", () => {
  it("🔴 passes it to the next person; the decliner stays on the list and never gets that time again", async () => {
    const decliner = await makeEntry();
    const next = await makeEntry();
    const slot = freshSlot();
    const held = await offerTo(slot);
    expect(held.entryId).toBe(decliner.id);

    const res = await declineOffer({ token: held.token, leave: false });
    expect(res).toEqual({ outcome: "declined", left: false });
    expect(await statusOf(decliner.id)).toBe("WAITING");
    expect(await liveOffersFor(next.id)).toHaveLength(1);

    // The next person lets it lapse too: it does not bounce back.
    const lapse = await declineOffer({
      token: (await offerTokenFor(next.id)) ?? "",
      leave: false,
    });
    expect(lapse.outcome).toBe("declined");
    expect(await liveOffersFor(decliner.id)).toHaveLength(0);
  });

  it("with Take me off the waitlist, they leave the list too", async () => {
    const decliner = await makeEntry();
    const next = await makeEntry();
    const held = await offerTo(freshSlot());
    expect(held.entryId).toBe(decliner.id);

    const res = await declineOffer({ token: held.token, leave: true });
    expect(res).toEqual({ outcome: "declined", left: true });
    expect(await statusOf(decliner.id)).toBe("REMOVED");
    expect(await liveOffersFor(next.id)).toHaveLength(1);
  });

  it("a decline after the hold lapsed records the lapse and still moves it on", async () => {
    await makeEntry();
    const next = await makeEntry();
    const now = new Date();
    const held = await offerTo(freshSlot(), now);
    const late = new Date(held.expiresAt.getTime() + 1000);

    const res = await declineOffer({ token: held.token, leave: false, now: late });
    expect(res.outcome).toBe("expired");
    expect((await prisma.waitlistOffer.findUniqueOrThrow({ where: { id: held.offerId } })).status).toBe(
      "EXPIRED",
    );
    expect(await liveOffersFor(next.id)).toHaveLength(1);
  });

  it("the route: 200 with left, 410 for a hold already used, 404 for a token that never was", async () => {
    await makeEntry();
    const held = await offerTo(freshSlot());
    const ok = await request(app).post(`/api/book/offer/${held.token}/decline`).send({ leave: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, left: true });
    const again = await request(app).post(`/api/book/offer/${held.token}/decline`).send({});
    expect(again.status).toBe(410);
    const never = await request(app).post(`/api/book/offer/${randomToken(16)}/decline`).send({});
    expect(never.status).toBe(404);
    const bad = await request(app).post(`/api/book/offer/${held.token}/decline`).send({ leave: "yes" });
    expect(bad.status).toBe(400);
  });
});

describe("a claim that ends a hold moves it on", () => {
  it("🔴 a tap after the hold lapsed (before the sweep) offers it to the next person", async () => {
    await makeEntry();
    const next = await makeEntry();
    const held = await offerTo(freshSlot());
    const claim = await claimOffer({
      token: held.token,
      now: new Date(held.expiresAt.getTime() + 1000),
    });
    expect(claim.outcome).toBe("expired");
    expect(await liveOffersFor(next.id)).toHaveLength(1);
  });

  it("a client the shop blocked mid-hold: the claim lets it go and the next person gets it", async () => {
    const blocked = await makeEntry();
    const next = await makeEntry();
    const held = await offerTo(freshSlot());
    expect(held.entryId).toBe(blocked.id);
    await prisma.client.create({
      data: {
        shopId,
        firstName: "Blocked",
        email: blocked.email,
        acuityClientKey: `qa-${randomToken(6)}`,
        magicToken: randomToken(),
        bookingBlockedAt: new Date(),
      },
    });
    const claim = await claimOffer({ token: held.token });
    expect(claim.outcome).toBe("contact_shop");
    expect(await liveOffersFor(next.id)).toHaveLength(1);
  });
});

describe("holds", () => {
  it("🔴 never outlive the time they hold, and say their real length", async () => {
    await makeEntry();
    // A grid slot, offered 20 minutes before it starts (the clock is injected).
    const slot = freshSlot();
    const now = new Date(slot.startsAt.getTime() - 20 * 60_000);
    const held = await offerTo(slot, now);
    expect(held.expiresAt.getTime()).toBe(slot.startsAt.getTime());
    expect(held.expiresAt.getTime()).toBeLessThan(now.getTime() + HOLD_MS);
    const created = await prisma.waitlistEvent.findFirstOrThrow({
      where: { offerId: held.offerId, type: "offer.created" },
    });
    expect((created.metadata as { holdMinutes: number }).holdMinutes).toBe(20);
  });
});

describe("the same person never gets the same time twice", () => {
  it("🔴 a time someone passed on does not bounce to their other request", async () => {
    const shared = `twice-${randomToken(5)}@test.local`;
    const first = await makeEntry({ email: shared });
    const second = await makeEntry({ email: shared.toUpperCase(), serviceId: null }); // their other request
    const someoneElse = await makeEntry();
    const held = await offerTo(freshSlot());
    expect(held.entryId).toBe(first.id);

    await declineOffer({ token: held.token, leave: false });
    expect(await liveOffersFor(second.id)).toHaveLength(0);
    expect(await liveOffersFor(someoneElse.id)).toHaveLength(1);
  });
});

describe("the announcement checks the hold is still there", () => {
  it("🔴 a hold that ended before it was announced is never announced", async () => {
    captureEmails();
    const entry = await makeEntry();
    const held = await offerTo(freshSlot());
    await prisma.waitlistOffer.update({ where: { id: held.offerId }, data: { status: "RELEASED" } });
    await notifyOffer({
      shop: { id: shopId, name: "Leave Cuts", slug: null, timezone: TZ },
      offer: {
        offerId: held.offerId,
        entryId: entry.id,
        startsAt: new Date(),
        expiresAt: held.expiresAt,
        serviceName: null,
        staffName: null,
        approvalRequired: false,
      },
      entry: { firstName: "Leave", email: entry.email, clientId: null },
      token: held.token,
    });
    expect(sent).toHaveLength(0);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).notifiedAt).toBeNull();
  });

  it("🔴 nor is one whose person has left the list", async () => {
    captureEmails();
    const entry = await makeEntry();
    const held = await offerTo(freshSlot());
    await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { status: "REMOVED" } });
    await notifyOffer({
      shop: { id: shopId, name: "Leave Cuts", slug: null, timezone: TZ },
      offer: {
        offerId: held.offerId,
        entryId: entry.id,
        startsAt: new Date(),
        expiresAt: held.expiresAt,
        serviceName: null,
        staffName: null,
        approvalRequired: false,
      },
      entry: { firstName: "Leave", email: entry.email, clientId: null },
      token: held.token,
    });
    expect(sent).toHaveLength(0);
  });
});

describe("leaving from an offer link that is no longer live", () => {
  it("🔴 works after the hold was let go (most people read the email late)", async () => {
    const entry = await makeEntry();
    const held = await offerTo(freshSlot());
    await prisma.waitlistOffer.update({ where: { id: held.offerId }, data: { status: "EXPIRED" } });
    const res = await declineOffer({ token: held.token, leave: true });
    expect(res).toEqual({ outcome: "declined", left: true });
    expect(await statusOf(entry.id)).toBe("REMOVED");
  });

  it("works on a hold that lapsed a moment ago, and still moves that time on", async () => {
    const entry = await makeEntry();
    const next = await makeEntry();
    const held = await offerTo(freshSlot());
    const res = await declineOffer({
      token: held.token,
      leave: true,
      now: new Date(held.expiresAt.getTime() + 1000),
    });
    expect(res).toEqual({ outcome: "declined", left: true });
    expect(await statusOf(entry.id)).toBe("REMOVED");
    expect(await liveOffersFor(next.id)).toHaveLength(1);
  });

  it("a hold they already booked leaves the booking alone", async () => {
    const entry = await makeEntry();
    const held = await offerTo(freshSlot());
    expect((await claimOffer({ token: held.token })).outcome).toBe("claimed");
    const res = await declineOffer({ token: held.token, leave: true });
    expect(res).toEqual({ outcome: "expired" });
    expect(await statusOf(entry.id)).toBe("BOOKED");
  });
});

describe("races", () => {
  it("🔴 two cancellations on different barbers at once never give one person two holds", async () => {
    const first = await makeEntry({ staffId: null }); // any barber
    const second = await makeEntry({ staffId: null });
    const sam = freshSlot();
    const ana = freshSlot({ staffId: otherStaffId });

    const { results, settledEarly } = await raceBehindAdvisoryLock(offerLockKey(shopId), [
      () => offerFreedSlot(sam, new Date()),
      () => offerFreedSlot(ana, new Date()),
    ]);
    expect(settledEarly).toBe(0);
    const offered = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(offered.map((o) => o?.outcome)).toEqual(["offered", "offered"]);
    const who = offered.map((o) => (o && o.outcome === "offered" ? o.entryId : null)).sort();
    expect(who).toEqual([first.id, second.id].sort());
    expect(await liveOffersFor(first.id)).toHaveLength(1);
  });

  it("🔴 leaving and claiming the same hold at once: exactly one of them happens", async () => {
    const entry = await makeEntry();
    const held = await offerTo(freshSlot());
    const { results, settledEarly } = await raceBehindRowLock<unknown>("WaitlistOffer", held.offerId, [
      () => leaveWaitlistEntry({ where: { id: entry.id, shopId }, source: "cancel_link" }),
      () => claimOffer({ token: held.token }),
    ]);
    expect(settledEarly).toBe(0);
    const [leave, claim] = results.map((r) => {
      if (r.status !== "fulfilled") throw r.reason;
      return r.value;
    }) as [Awaited<ReturnType<typeof leaveWaitlistEntry>>, Awaited<ReturnType<typeof claimOffer>>];
    const claimed = claim.outcome === "claimed";
    expect(Number(claimed) + Number(leave.left && !claimed)).toBe(1);
    expect(await liveOffersFor(entry.id)).toHaveLength(0);
    expect(await statusOf(entry.id)).toBe(claimed ? "BOOKED" : "REMOVED");
  });

  it("🔴 a hold is never left live for someone who left while it was being made", async () => {
    const leaver = await makeEntry();
    const next = await makeEntry();
    const slot = freshSlot();
    // Both the offer (re-reading the chosen entry) and the leave (changing it)
    // must queue on the entry row.
    const barrier = await holdRowLock("WaitlistEntry", leaver.id);
    const { results, settledEarly } = await raceBehindBarrier<unknown>(barrier, [
      () => offerFreedSlot(slot, new Date()),
      () => leaveWaitlistEntry({ where: { id: leaver.id, shopId }, source: "cancel_link" }),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await statusOf(leaver.id)).toBe("REMOVED");
    expect(await liveOffersFor(leaver.id)).toHaveLength(0);
    // Whichever order it ran in, the time ends up with the next person.
    expect(await liveOffersFor(next.id)).toHaveLength(1);
  });
});

/**
 * 🔴 A CLAIM AND A BARBER'S BOOKING OVER THE HOLD NEVER DEADLOCK. The claim
 * used to lock its offer row first and ask for the barber's lock after; the
 * barber's write takes the barber's lock and then releases that row.
 */
describe("a claim against a barber writing over the hold", () => {
  it("🔴 queue instead of deadlocking: one booking, no 500", async () => {
    await makeEntry();
    const slot = freshSlot();
    const held = await offerTo(slot);
    const barber = () =>
      prisma.$transaction(async (tx) => {
        await lockStaffAndAssertSlotFree(tx, {
          staffId,
          shopId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          bufferMin: 0,
          serviceDayLimit: null,
          walkInCapacity: "ignore",
          overrideWaitlistHolds: true,
          now: new Date(),
        });
        return tx.appointment.create({
          data: {
            shopId,
            staffId,
            serviceId,
            firstName: "Booked by the barber",
            status: "BOOKED",
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            manageToken: randomToken(),
          },
          select: { id: true },
        });
      });

    const { results, settledEarly } = await raceBehindRowLock<unknown>("WaitlistOffer", held.offerId, [
      () => claimOffer({ token: held.token }),
      barber,
    ]);
    expect(settledEarly).toBe(0);
    expect(JSON.stringify(results)).not.toMatch(/40P01|deadlock/i);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(SlotTakenError);
    }
    const booked = await prisma.appointment.count({
      where: { shopId, staffId, startsAt: slot.startsAt, status: { in: ["BOOKED", "PENDING"] } },
    });
    expect(booked).toBe(1);
  });

  it("a second tap of the same link, queued behind the first, says the hold is over - not 'taken'", async () => {
    await makeEntry();
    const held = await offerTo(freshSlot());
    const { results, settledEarly } = await raceBehindRowLock("WaitlistOffer", held.offerId, [
      () => claimOffer({ token: held.token }),
      () => claimOffer({ token: held.token }),
    ]);
    expect(settledEarly).toBe(0);
    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value.outcome : "rejected")).sort();
    expect(outcomes).toEqual(["claimed", "expired"]);
  });
});

/**
 * 🔴 NOTHING IS OFFERED THAT THE BOOKING PAGE WOULD HOLD FOR MONEY OR A CARD.
 * The gate knew only pay-ahead and deposit, and read the service's BASE price:
 * a shop requiring a saved card got waitlist bookings with no card, and a
 * service priced only by a weekday override was free here and paid there.
 */
describe("the money gate", () => {
  async function withShop(data: Record<string, unknown>, run: () => Promise<void>) {
    const before = await prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: {
        paymentsMode: true,
        connectChargesEnabled: true,
        stripeConnectAccountId: true,
        requireCardToBook: true,
        depositAmountCents: true,
      },
    });
    __setConnectEnabledForTests(true);
    await prisma.shop.update({ where: { id: shopId }, data });
    try {
      await run();
    } finally {
      __setConnectEnabledForTests(undefined);
      await prisma.shop.update({ where: { id: shopId }, data: before });
    }
  }
  const connected = { connectChargesEnabled: true, stripeConnectAccountId: "acct_test_gate" };

  it("🔴 a shop that requires a saved card gets no waitlist offer", async () => {
    await makeEntry();
    await withShop({ ...connected, paymentsMode: "card_on_file", requireCardToBook: true }, async () => {
      expect((await offerFreedSlot(freshSlot(), new Date())).outcome).toBe("requires_deposit");
    });
  });

  it("a card shop with the card optional still offers - the claim books like Confirm does", async () => {
    await makeEntry();
    await withShop({ ...connected, paymentsMode: "card_on_file", requireCardToBook: false }, async () => {
      expect((await offerFreedSlot(freshSlot(), new Date())).outcome).toBe("offered");
    });
  });

  it("🔴 a deposit service priced only by a weekday override is not offered as if free", async () => {
    await makeEntry({ serviceId: null });
    const override = await prisma.service.create({
      data: {
        shopId,
        name: "Override",
        durationMin: 30,
        price: null,
        priceOverrides: Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), 40])),
      },
      select: { id: true },
    });
    await prisma.serviceStaff.create({ data: { shopId, serviceId: override.id, staffId } });
    await withShop({ ...connected, paymentsMode: "deposit", depositAmountCents: 1000 }, async () => {
      const res = await offerFreedSlot(freshSlot({ serviceId: override.id }), new Date());
      expect(res.outcome).toBe("requires_deposit");
    });
  });

  it("a claim at a shop that turned on Require a card mid-hold is refused and lets the time go", async () => {
    await makeEntry();
    const held = await offerTo(freshSlot());
    await withShop({ ...connected, paymentsMode: "card_on_file", requireCardToBook: true }, async () => {
      expect((await claimOffer({ token: held.token })).outcome).toBe("deposit_required");
    });
    expect((await prisma.waitlistOffer.findUniqueOrThrow({ where: { id: held.offerId } })).status).toBe(
      "RELEASED",
    );
  });
});

/** The raw token for an entry's live offer, minted fresh: tokens are hash-only. */
async function offerTokenFor(entryId: string): Promise<string | null> {
  const offer = await prisma.waitlistOffer.findFirst({ where: { entryId, status: "OFFERED" } });
  if (!offer) return null;
  const token = randomToken(32);
  await prisma.waitlistOffer.update({ where: { id: offer.id }, data: { tokenHash: sha256Hex(token) } });
  return token;
}
