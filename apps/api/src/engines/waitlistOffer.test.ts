import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  __lastScanStatsForTests,
  __setConnectEnabledForTests,
  __setScanTraceForTests,
  claimOffer,
  expireDueOffers,
  HOLD_MINUTES,
  HOLD_MS,
  mintClaimToken,
  notifyOffer,
  offerFreedSlot,
  OFFER_COOLDOWN_MS,
  type FreedSlot,
} from "./waitlistOffer.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "./bookingWrite.js";
import { addDaysToDateKey, wallParts } from "./waitlistMatch.js";
import { computeOpenSlots } from "./slots.js";
import { sha256Hex } from "./waitlistJoin.js";
import {
  __setSendEmailForTests,
  type SendEmailInput,
} from "../messaging/email.js";

/**
 * Waitlist phase C: the offer lifecycle.
 *
 * The schema suite (waitlistSchema.test.ts) already pins what the DATABASE
 * refuses - overlapping live holds, a null barber. This suite pins what the
 * ENGINE promises on top:
 *
 *   cancel -> ONE hold for ONE customer -> claim | lapse -> next in line
 *
 * and every way that pipeline can race: two cancels, claim vs expiry, claim
 * vs a normal booking, the barber booking straight over the hold. Every
 * timestamp is injected - nothing here depends on the day the suite runs.
 */

let userId: string;
let shopId: string;
let staffId: string; // Sam - the barber whose slot frees up
let otherStaffId: string; // Ana
let serviceId: string;
let entrySeq = 0;

const TZ = "America/New_York";

/** Deterministic, collision-free future slots: a fresh 30-min lane per call. */
let slotSeq = 0;
function freshSlot(overrides: Partial<FreedSlot> = {}): FreedSlot {
  // Anchor ~3 days out on a 30-minute grid boundary (the engine only offers
  // grid-aligned starts), then give each test its own 2h lane.
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
    ...overrides,
  };
}

async function makeEntry(over: Record<string, unknown> = {}) {
  entrySeq += 1;
  return prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: `Wait${entrySeq}`,
      email: `wl-offer-${entrySeq}-${randomToken(4)}@test.local`,
      ...over,
    },
    select: { id: true, firstName: true, email: true },
  });
}

/** The engine's happy path, returned typed for follow-on assertions. */
async function offerTo(slot: FreedSlot, now = new Date()) {
  const res = await offerFreedSlot(slot, now);
  expect(res.outcome).toBe("offered");
  if (res.outcome !== "offered") throw new Error("unreachable");
  return res;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wl-c-${randomToken(6)}@test.local`, name: "C" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Offer Cuts",
      slug: `wl-c-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: TZ,
      bookingMode: "native",
      waitlistEnabled: true,
      slotOpenedTextsEnabled: true,
      bookingBufferMin: 0,
      // The DST case mints an offer 45 minutes before the slot; the default
      // lead window would veto that, and lead time is not what these test.
      bookingLeadHours: 0,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
    select: { id: true },
  });
  shopId = shop.id;
  const sam = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  staffId = sam.id;
  const ana = await prisma.staff.create({ data: { shopId, name: "Ana" } });
  otherStaffId = ana.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30 },
    select: { id: true },
  });
  serviceId = svc.id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId, staffId },
      { shopId, serviceId, staffId: otherStaffId },
    ],
  });
  // Both barbers work around the clock, every day: the availability RULES are
  // not what this suite is about, and a slot 3 days out at any :00/:30 must
  // always pass isSlotBookable's hours gate.
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
  __setConnectEnabledForTests(undefined);
  // Neutralize THIS test's leftovers so no later test inherits them: a spare
  // WAITING entry would be "earliest eligible" for every slot after it, and a
  // spare live hold would be swept by any later worker tick. Same rows, dead
  // states - REMOVED entries are never candidates, RELEASED offers never
  // block or sweep.
  await prisma.waitlistEntry.updateMany({
    where: { shopId, status: "WAITING" },
    data: { status: "REMOVED" },
  });
  await prisma.waitlistOffer.updateMany({
    where: { shopId, status: "OFFERED" },
    data: { status: "RELEASED" },
  });
});

afterAll(async () => {
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
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* Creating the hold                                                   */
/* ------------------------------------------------------------------ */

describe("offering a freed slot", () => {
  it("holds it for the EARLIEST eligible entry, for exactly 30 minutes", async () => {
    const slot = freshSlot();
    const now = new Date();
    const first = await makeEntry();
    await makeEntry(); // later joiner - must lose

    const res = await offerTo(slot, now);
    expect(res.entryId).toBe(first.id);
    // The default hold: exactly HOLD_MINUTES, to the millisecond.
    expect(HOLD_MINUTES).toBe(30);
    expect(res.expiresAt.getTime()).toBe(now.getTime() + HOLD_MS);

    const row = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
    expect(row!.status).toBe("OFFERED");
    expect(row!.staffId).toBe(staffId);
    expect(row!.serviceId).toBe(serviceId);
    expect(row!.startsAt.getTime()).toBe(slot.startsAt.getTime());
    expect(row!.endsAt.getTime()).toBe(slot.endsAt.getTime());
    // 🔑 Only the hash is stored; the raw token appears nowhere in the row.
    expect(row!.tokenHash).toBe(sha256Hex(res.token));
    expect(JSON.stringify(row)).not.toContain(res.token);
  });

  it("🔴 an any-barber entry still gets a CONCRETE barber on the hold", async () => {
    const slot = freshSlot();
    const entry = await makeEntry({ staffId: null, serviceId: null });
    const res = await offerTo(slot);
    expect(res.entryId).toBe(entry.id);
    const row = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
    expect(row!.staffId).toBe(staffId); // the freed slot's real chair, never null
  });

  it("matches on service and staff the way slotOpened always has", async () => {
    const slot = freshSlot();
    const otherService = await prisma.service.create({
      data: { shopId, name: "Beard", durationMin: 15 },
      select: { id: true },
    });
    // Wrong service, wrong staff: both ineligible; the standing join wins.
    await makeEntry({ serviceId: otherService.id });
    await makeEntry({ staffId: otherStaffId });
    const standing = await makeEntry({ serviceId: null, staffId: "" });

    const res = await offerTo(slot);
    expect(res.entryId).toBe(standing.id);
  });

  it("skips entries with no way to hear about a 30-minute window", async () => {
    const slot = freshSlot();
    // Phone-only and NOT a known client: cannot be pushed, cannot be emailed,
    // and SMS is dark until 10DLC - holding the slot for them would kill it.
    const unreachable = await makeEntry({ email: null, phone: "+15550001111" });
    const res = await offerFreedSlot(slot, new Date());
    expect(res.outcome).toBe("no_candidates");

    // The same person linked to a Client (push target) becomes offerable.
    await prisma.client.create({
      data: {
        shopId,
        firstName: "Push",
        phone: "+15550001111",
        acuityClientKey: `qa-${randomToken(6)}`,
        magicToken: randomToken(),
      },
    });
    const retry = await offerTo(slot);
    expect(retry.entryId).toBe(unreachable.id);
    expect(retry.entry.clientId).not.toBeNull();
  });

  it("🔴 duplicate cancellation events produce ONE offer, ever", async () => {
    const slot = freshSlot();
    await makeEntry();
    await makeEntry();

    const first = await offerFreedSlot(slot, new Date());
    const second = await offerFreedSlot(slot, new Date());
    expect(first.outcome).toBe("offered");
    // The second event finds the first event's live hold and stands down.
    expect(second.outcome).toBe("unavailable");

    const holds = await prisma.waitlistOffer.count({
      where: { shopId, staffId, startsAt: slot.startsAt, status: "OFFERED" },
    });
    expect(holds).toBe(1);
  });

  it("🔴 CONCURRENT offer creation: exactly one hold survives", async () => {
    const slot = freshSlot();
    await makeEntry();
    await makeEntry();

    const [a, b] = await Promise.all([
      offerFreedSlot(slot, new Date()),
      offerFreedSlot(slot, new Date()),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["offered", "unavailable"]);
    const holds = await prisma.waitlistOffer.count({
      where: { shopId, staffId, startsAt: slot.startsAt, status: "OFFERED" },
    });
    expect(holds).toBe(1);
  });

  it("refuses an OVERLAPPING freed span while a hold lives (not just identical)", async () => {
    const slot = freshSlot();
    await makeEntry();
    await makeEntry();
    await offerTo(slot);

    // 15 minutes in - different start, same physical chair time.
    const overlapping: FreedSlot = {
      ...slot,
      startsAt: new Date(slot.startsAt.getTime() + 15 * 60_000),
      endsAt: new Date(slot.endsAt.getTime() + 15 * 60_000),
    };
    const res = await offerFreedSlot(overlapping, new Date());
    expect(res.outcome).toBe("unavailable");
  });

  it("a gap-fill (PENDING) hold blocks an offer, and a live offer blocks a hold", async () => {
    const slot = freshSlot();
    await makeEntry();

    // (a) The AI receptionist already holds this span: no offer.
    const hold = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "AI hold",
        status: "PENDING",
        holdExpiresAt: new Date(Date.now() + 60 * 60_000),
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const blocked = await offerFreedSlot(slot, new Date());
    expect(blocked.outcome).toBe("unavailable");
    await prisma.appointment.delete({ where: { id: hold.id } });

    // (b) A live offer on the span: the receptionist's own hold path (the
    // shared guard, no override) is refused the same physical time.
    await offerTo(slot);
    await expect(
      prisma.$transaction((tx) =>
        lockStaffAndAssertSlotFree(tx, {
          staffId,
          shopId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          bufferMin: 0,
          serviceDayLimit: null,
        }),
      ),
    ).rejects.toThrow(SlotTakenError);
  });

  it("the public grid HIDES a held slot, and frees it the instant the hold lapses", async () => {
    const slot = freshSlot();
    await makeEntry();
    const now = new Date();

    const grid = () =>
      computeOpenSlots({
        shopId,
        staffId,
        serviceId,
        fromDate: new Date(slot.startsAt.getTime() - 2 * 3600_000),
        toDate: new Date(slot.startsAt.getTime() + 2 * 3600_000),
        now,
      });

    const before = await grid();
    expect(before.some((s) => s.startsAt.getTime() === slot.startsAt.getTime())).toBe(true);

    const res = await offerTo(slot, now);

    const during = await grid();
    expect(during.some((s) => s.startsAt.getTime() === slot.startsAt.getTime())).toBe(false);

    // Past expiry the hold stops blocking IMMEDIATELY - no sweep required
    // (same discipline as expired receptionist holds).
    const after = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: new Date(slot.startsAt.getTime() - 2 * 3600_000),
      toDate: new Date(slot.startsAt.getTime() + 2 * 3600_000),
      now: new Date(res.expiresAt.getTime() + 1),
    });
    expect(after.some((s) => s.startsAt.getTime() === slot.startsAt.getTime())).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Claiming                                                            */
/* ------------------------------------------------------------------ */

describe("claiming", () => {
  it("a valid claim books ATOMICALLY: appointment + offer CLAIMED + entry BOOKED", async () => {
    const slot = freshSlot();
    const entry = await makeEntry();
    const res = await offerTo(slot);

    const claim = await claimOffer({ token: res.token, now: new Date() });
    expect(claim.outcome).toBe("claimed");
    if (claim.outcome !== "claimed") throw new Error("unreachable");
    expect(claim.pending).toBe(false); // normal shop: a real booking

    const appt = await prisma.appointment.findUnique({
      where: { id: claim.appointmentId },
    });
    expect(appt!.status).toBe("BOOKED");
    expect(appt!.staffId).toBe(staffId);
    expect(appt!.startsAt.getTime()).toBe(slot.startsAt.getTime());
    expect(appt!.endsAt.getTime()).toBe(slot.endsAt.getTime());
    expect(appt!.bookedVia).toBe("waitlist_offer");
    expect(appt!.clientId).not.toBeNull(); // landed in the client book

    const offer = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
    expect(offer!.status).toBe("CLAIMED");
    expect(offer!.claimedAppointmentId).toBe(claim.appointmentId);

    const e = await prisma.waitlistEntry.findUnique({ where: { id: entry.id } });
    expect(e!.status).toBe("BOOKED");
    expect(e!.bookedAppointmentId).toBe(claim.appointmentId);
  });

  it("an unknown token is just not_found - no oracle", async () => {
    const res = await claimOffer({ token: "not-a-real-token", now: new Date() });
    expect(res.outcome).toBe("invalid");
  });

  it("🔴 the 30-minute boundary is exact: 29:59.999 claims, 30:00.000 does not", async () => {
    const now = new Date();
    // Fine at the last millisecond.
    const slotA = freshSlot();
    await makeEntry();
    const a = await offerTo(slotA, now);
    const okAt = new Date(now.getTime() + HOLD_MS - 1);
    expect((await claimOffer({ token: a.token, now: okAt })).outcome).toBe("claimed");

    // Refused AT expiry, even though no worker has run - and the row is
    // flipped so the state says what happened.
    const slotB = freshSlot();
    await makeEntry();
    const b = await offerTo(slotB, now);
    const atExpiry = new Date(now.getTime() + HOLD_MS);
    expect((await claimOffer({ token: b.token, now: atExpiry })).outcome).toBe("expired");
    const row = await prisma.waitlistOffer.findUnique({ where: { id: b.offerId } });
    expect(row!.status).toBe("EXPIRED");
  });

  it("a REUSED token cannot book twice", async () => {
    const slot = freshSlot();
    await makeEntry();
    const res = await offerTo(slot);

    const first = await claimOffer({ token: res.token, now: new Date() });
    expect(first.outcome).toBe("claimed");
    const second = await claimOffer({ token: res.token, now: new Date() });
    expect(second.outcome).toBe("expired"); // generic - the hold is simply gone

    const appts = await prisma.appointment.count({
      where: { shopId, staffId, startsAt: slot.startsAt },
    });
    expect(appts).toBe(1);
  });

  it("a token only ever resolves ITS OWN shop's slot", async () => {
    // A second shop with its own everything; a token minted there can no more
    // touch the first shop than a random string can - the claim derives shop,
    // barber and time exclusively from the offer row the hash matches.
    const owner2 = await prisma.user.create({
      data: { email: `wl-c2-${randomToken(6)}@test.local`, name: "C2" },
      select: { id: true },
    });
    const shop2 = await prisma.shop.create({
      data: {
        ownerId: owner2.id,
        name: "Other Shop",
        slug: `wl-c2-${randomToken(5)}`.toLowerCase(),
        webhookSecret: randomToken(),
        timezone: TZ,
      },
      select: { id: true },
    });
    const staff2 = await prisma.staff.create({
      data: { shopId: shop2.id, name: "Bo" },
      select: { id: true },
    });
    const svc2 = await prisma.service.create({
      data: { shopId: shop2.id, name: "Trim", durationMin: 30 },
      select: { id: true },
    });
    const entry2 = await prisma.waitlistEntry.create({
      data: { shopId: shop2.id, firstName: "W2", email: `w2-${randomToken(4)}@t.local` },
      select: { id: true },
    });
    const minted = mintClaimToken();
    const startsAt = freshSlot().startsAt;
    await prisma.waitlistOffer.create({
      data: {
        shopId: shop2.id,
        entryId: entry2.id,
        staffId: staff2.id,
        serviceId: svc2.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        tokenHash: minted.hash,
        status: "OFFERED",
        expiresAt: new Date(Date.now() + HOLD_MS),
      },
    });

    const claim = await claimOffer({ token: minted.token, now: new Date() });
    expect(claim.outcome).toBe("claimed");
    if (claim.outcome !== "claimed") throw new Error("unreachable");
    // Everything about the booking is shop2's; shop1 gained nothing.
    expect(claim.shopId).toBe(shop2.id);
    const appt = await prisma.appointment.findUnique({ where: { id: claim.appointmentId } });
    expect(appt!.shopId).toBe(shop2.id);
    const inShop1 = await prisma.appointment.count({
      where: { shopId, startsAt },
    });
    expect(inShop1).toBe(0);

    await prisma.waitlistOffer.deleteMany({ where: { shopId: shop2.id } });
    await prisma.appointment.deleteMany({ where: { shopId: shop2.id } });
    await prisma.waitlistEntry.deleteMany({ where: { shopId: shop2.id } });
    await prisma.client.deleteMany({ where: { shopId: shop2.id } });
    await prisma.service.deleteMany({ where: { shopId: shop2.id } });
    await prisma.staff.deleteMany({ where: { shopId: shop2.id } });
    await prisma.shop.delete({ where: { id: shop2.id } });
    await prisma.user.delete({ where: { id: owner2.id } });
  });

  it("🔴 claim vs expiry RACE: exactly one of them decides", async () => {
    const now = new Date();
    const slot = freshSlot();
    await makeEntry();
    const res = await offerTo(slot, now);

    // The claim arrives a hair before the deadline while the worker's clock
    // says the deadline passed - the FOR UPDATE row lock and the worker's
    // compare-and-set mean whoever wins the row decides, and the loser folds.
    const claimNow = new Date(res.expiresAt.getTime() - 1);
    const workerNow = new Date(res.expiresAt.getTime());
    const [claim] = await Promise.all([
      claimOffer({ token: res.token, now: claimNow }),
      expireDueOffers(workerNow, { forceAdvance: false }),
    ]);

    const row = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
    const appts = await prisma.appointment.count({
      where: { shopId, staffId, startsAt: slot.startsAt },
    });
    if (claim.outcome === "claimed") {
      expect(row!.status).toBe("CLAIMED");
      expect(appts).toBe(1);
    } else {
      expect(claim.outcome).toBe("expired");
      expect(row!.status).toBe("EXPIRED");
      expect(appts).toBe(0);
    }
  });

  it("🔴 claim vs NORMAL BOOKING race: the held slot is the claimant's", async () => {
    const slot = freshSlot();
    await makeEntry();
    const res = await offerTo(slot);

    // A normal customer trying to book the held time goes through the same
    // guard every writer does - and is refused while the hold lives.
    const normalBooking = () =>
      prisma.$transaction(async (tx) => {
        await lockStaffAndAssertSlotFree(tx, {
          staffId,
          shopId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          bufferMin: 0,
          serviceDayLimit: { serviceId, timezone: TZ },
        });
        return tx.appointment.create({
          data: {
            shopId,
            staffId,
            serviceId,
            firstName: "Normal",
            status: "BOOKED",
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            manageToken: randomToken(),
          },
          select: { id: true },
        });
      });

    const [claim, normal] = await Promise.allSettled([
      claimOffer({ token: res.token, now: new Date() }),
      normalBooking(),
    ]);
    // The claim always wins: the normal write sees the live hold (or, if the
    // claim committed first, the freshly booked appointment) and throws.
    expect(claim.status).toBe("fulfilled");
    expect((claim as PromiseFulfilledResult<{ outcome: string }>).value.outcome).toBe(
      "claimed",
    );
    expect(normal.status).toBe("rejected");
    const appts = await prisma.appointment.count({
      where: { shopId, staffId, startsAt: slot.startsAt },
    });
    expect(appts).toBe(1);
  });

  it("after expiry the public can book normally, and the stale link fails safely", async () => {
    const now = new Date();
    const slot = freshSlot();
    await makeEntry();
    const res = await offerTo(slot, now);
    const later = new Date(res.expiresAt.getTime() + 1);

    // The hold lapsed: a normal booking sails through (no sweep needed).
    await prisma.$transaction(async (tx) => {
      await lockStaffAndAssertSlotFree(tx, {
        staffId,
        shopId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: 0,
        serviceDayLimit: null,
        now: later,
      });
      await tx.appointment.create({
        data: {
          shopId,
          staffId,
          serviceId,
          firstName: "Walkup",
          status: "BOOKED",
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          manageToken: randomToken(),
        },
      });
    });

    const claim = await claimOffer({ token: res.token, now: later });
    expect(claim.outcome).toBe("expired");
  });

  it("🔴 an ADMIN booking over the hold releases it; the claim then fails safely", async () => {
    const slot = freshSlot();
    await makeEntry();
    const res = await offerTo(slot);

    // The barber books the very time being held, from their own dashboard -
    // the guard releases the hold in the same transaction instead of refusing.
    await prisma.$transaction(async (tx) => {
      await lockStaffAndAssertSlotFree(tx, {
        staffId,
        shopId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: 0,
        serviceDayLimit: null,
        overrideWaitlistHolds: true,
      });
      await tx.appointment.create({
        data: {
          shopId,
          staffId,
          serviceId,
          firstName: "Walk-in",
          status: "BOOKED",
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          manageToken: randomToken(),
        },
      });
    });

    const offer = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
    expect(offer!.status).toBe("RELEASED");

    const claim = await claimOffer({ token: res.token, now: new Date() });
    expect(claim.outcome).toBe("expired"); // generic; nothing about the walk-in leaks
    const appts = await prisma.appointment.count({
      where: { shopId, staffId, startsAt: slot.startsAt },
    });
    expect(appts).toBe(1); // the admin's booking stands alone
  });

  it("DST fall-back weekend: the hold is 30 ABSOLUTE minutes, wall clocks be damned", async () => {
    // 2026-11-01 is the America/New_York fall-back. 06:30Z is 01:30 EST - the
    // repeated hour. The engine deals only in instants: created at T, expires
    // at T+30min of REAL time, boundary exact.
    const startsAt = new Date("2026-11-01T06:30:00.000Z");
    const slot: FreedSlot = {
      shopId,
      staffId,
      serviceId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      timezone: TZ,
      bufferMin: 0,
    };
    const now = new Date("2026-11-01T05:45:00.000Z"); // 45 min before, mid-transition night
    await makeEntry();
    const res = await offerTo(slot, now);
    expect(res.expiresAt.getTime() - now.getTime()).toBe(HOLD_MS);
    expect(
      (await claimOffer({ token: res.token, now: new Date(res.expiresAt.getTime() - 1) }))
        .outcome,
    ).toBe("claimed");
  });
});

/* ------------------------------------------------------------------ */
/* The expiry worker                                                   */
/* ------------------------------------------------------------------ */

describe("the expiry worker", () => {
  it("🔴 expires a lapsed hold and ADVANCES the slot to the next in line - never back", async () => {
    const slot = freshSlot();
    const now = new Date();
    const first = await makeEntry();
    const second = await makeEntry();

    const a = await offerTo(slot, now);
    expect(a.entryId).toBe(first.id);

    // First hold lapses -> the worker flips it and offers the SECOND entry.
    const t1 = new Date(a.expiresAt.getTime());
    const r1 = await expireDueOffers(t1, { forceAdvance: true });
    expect(r1.expired).toBe(1);
    expect(r1.advanced).toBe(1);

    const rowA = await prisma.waitlistOffer.findUnique({ where: { id: a.offerId } });
    expect(rowA!.status).toBe("EXPIRED");
    const next = await prisma.waitlistOffer.findFirst({
      where: { shopId, staffId, startsAt: slot.startsAt, status: "OFFERED" },
    });
    expect(next).not.toBeNull();
    expect(next!.entryId).toBe(second.id); // advanced, not bounced back to first

    // Second hold lapses too and nobody is left: expired, no new offer, and
    // the slot is publicly bookable again.
    const t2 = new Date(next!.expiresAt.getTime());
    const r2 = await expireDueOffers(t2, { forceAdvance: true });
    expect(r2.expired).toBe(1);
    expect(r2.advanced).toBe(0);
    const live = await prisma.waitlistOffer.count({
      where: { shopId, staffId, startsAt: slot.startsAt, status: "OFFERED" },
    });
    expect(live).toBe(0);
    const grid = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: new Date(slot.startsAt.getTime() - 3600_000),
      toDate: new Date(slot.startsAt.getTime() + 3600_000),
      now: t2,
    });
    expect(grid.some((s) => s.startsAt.getTime() === slot.startsAt.getTime())).toBe(true);
  });

  it("is idempotent across reruns and restarts", async () => {
    const slot = freshSlot();
    const now = new Date();
    await makeEntry();
    const res = await offerTo(slot, now);

    const t = new Date(res.expiresAt.getTime() + 1);
    const first = await expireDueOffers(t, { forceAdvance: false });
    expect(first.expired).toBe(1);
    // A crashed-and-restarted worker re-running the same tick finds nothing:
    // every step was a compare-and-set.
    const second = await expireDueOffers(t, { forceAdvance: false });
    expect(second.expired).toBe(0);
  });

  it("does NOT advance when the slot itself became unavailable (barber blocked it)", async () => {
    const slot = freshSlot();
    const now = new Date();
    await makeEntry();
    await makeEntry();
    const res = await offerTo(slot, now);

    // The barber blocks the whole window while the hold is live (an
    // availability exception - the calendar-level "I'm not here").
    await prisma.availabilityException.create({
      data: {
        shopId,
        staffId,
        startsAt: new Date(slot.startsAt.getTime() - 3600_000),
        endsAt: new Date(slot.endsAt.getTime() + 3600_000),
        isBlock: true,
      },
    });

    const t = new Date(res.expiresAt.getTime());
    const r = await expireDueOffers(t, { forceAdvance: true });
    expect(r.expired).toBe(1);
    expect(r.advanced).toBe(0); // isSlotBookable said no; nobody was offered a dead slot

    await prisma.availabilityException.deleteMany({ where: { shopId, staffId } });
  });

  it("notification failure leaves the hold standing and the pipeline self-heals", async () => {
    const slot = freshSlot();
    const now = new Date();
    const entry = await makeEntry();
    const res = await offerTo(slot, now);

    // Every channel fails - the email sender throws outright.
    __setSendEmailForTests(() => {
      throw new Error("smtp down");
    });
    await expect(
      notifyOffer({
        shop: { id: shopId, name: "Offer Cuts", slug: "x", timezone: TZ },
        offer: {
          entryId: entry.id,
          startsAt: slot.startsAt,
          expiresAt: res.expiresAt,
          serviceName: "Cut",
          staffName: "Sam",
          approvalRequired: false,
        },
        entry: { firstName: entry.firstName, email: entry.email, clientId: null },
        token: res.token,
        now,
      }),
    ).resolves.toBeUndefined(); // never throws

    const row = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
    expect(row!.status).toBe("OFFERED"); // the hold stands; expiry will advance it
    const e = await prisma.waitlistEntry.findUnique({ where: { id: entry.id } });
    expect(e!.notifiedAt).toBeNull(); // unreached = unstamped, so they stay eligible
  });

  it("sends exactly ONE notification for one offer (and a retry re-sends nothing)", async () => {
    const slot = freshSlot();
    const now = new Date();
    const entry = await makeEntry();
    const res = await offerTo(slot, now);

    const sent: SendEmailInput[] = [];
    __setSendEmailForTests(async (input) => {
      sent.push(input);
      return { id: "TEST", status: "sent" as const };
    });
    const args = {
      shop: { id: shopId, name: "Offer Cuts", slug: "x", timezone: TZ },
      offer: {
        entryId: entry.id,
        startsAt: slot.startsAt,
        expiresAt: res.expiresAt,
        serviceName: "Cut",
        staffName: "Sam",
        approvalRequired: false,
      },
      entry: { firstName: entry.firstName, email: entry.email, clientId: null },
      token: res.token,
      now,
    };
    await notifyOffer(args);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(entry.email);
    expect(sent[0]!.text).toContain(res.token); // the claim link carries the raw token
    expect(sent[0]!.subject.toLowerCase()).toContain("holding");

    // A duplicate cancel event cannot re-notify: it never gets an "offered"
    // outcome to notify about in the first place.
    const dup = await offerFreedSlot(slot, now);
    expect(dup.outcome).toBe("unavailable");
    expect(sent).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Product policy: cooldown, deposits, approval mode, reachability     */
/* ------------------------------------------------------------------ */

/** Flip shop columns for one test and put them back whatever happens. */
async function withShopPolicy(
  data: Record<string, unknown>,
  restore: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  await prisma.shop.update({ where: { id: shopId }, data });
  try {
    await fn();
  } finally {
    await prisma.shop.update({ where: { id: shopId }, data: restore });
  }
}

describe("🔴 the six-hour cooldown", () => {
  it("skips a recently-notified entry and offers the NEXT eligible one", async () => {
    const slot = freshSlot();
    const now = new Date();
    const cooled = await makeEntry();
    await prisma.waitlistEntry.update({
      where: { id: cooled.id },
      data: { notifiedAt: new Date(now.getTime() - 60 * 60 * 1000) }, // 1h ago
    });
    const fresh = await makeEntry();

    const res = await offerTo(slot, now);
    expect(res.entryId).toBe(fresh.id); // earliest ELIGIBLE, not earliest
  });

  it("with everyone in cooldown there is NO offer at all", async () => {
    const slot = freshSlot();
    const now = new Date();
    const only = await makeEntry();
    await prisma.waitlistEntry.update({
      where: { id: only.id },
      data: { notifiedAt: new Date(now.getTime() - 60 * 60 * 1000) },
    });
    expect((await offerFreedSlot(slot, now)).outcome).toBe("no_candidates");
  });

  it("the boundary is six hours exactly: 6h-1ms suppressed, 6h+1ms eligible", async () => {
    const now = new Date();
    const entry = await makeEntry();

    await prisma.waitlistEntry.update({
      where: { id: entry.id },
      data: { notifiedAt: new Date(now.getTime() - OFFER_COOLDOWN_MS + 1) },
    });
    expect((await offerFreedSlot(freshSlot(), now)).outcome).toBe("no_candidates");

    await prisma.waitlistEntry.update({
      where: { id: entry.id },
      data: { notifiedAt: new Date(now.getTime() - OFFER_COOLDOWN_MS - 1) },
    });
    expect((await offerFreedSlot(freshSlot(), now)).outcome).toBe("offered");
  });

  it("🔴 an ignored offer does NOT chain into a fresh email 30 minutes later", async () => {
    // The exact spam scenario: A's hold lapses, another slot frees right
    // after. A was notified 30 minutes ago -> still in cooldown -> B's turn.
    const slot = freshSlot();
    const now = new Date();
    const a = await makeEntry();
    const b = await makeEntry();

    const first = await offerTo(slot, now);
    expect(first.entryId).toBe(a.id);
    // The offer flow stamps notifiedAt when the customer is reached.
    await prisma.waitlistEntry.update({
      where: { id: a.id },
      data: { notifiedAt: now },
    });

    // A ignores it; the worker expires and advances - to B, both because A
    // already had THIS slot and because A is in cooldown.
    const t = new Date(first.expiresAt.getTime());
    await expireDueOffers(t, { forceAdvance: true });
    const next = await prisma.waitlistOffer.findFirst({
      where: { shopId, staffId, startsAt: slot.startsAt, status: "OFFERED" },
    });
    expect(next!.entryId).toBe(b.id);

    // A COMPLETELY DIFFERENT slot frees 30 minutes after A's notification:
    // still inside the 6h window, so A is skipped there too.
    const other = freshSlot();
    const later = new Date(now.getTime() + 30 * 60_000);
    const res = await offerFreedSlot(other, later);
    // B holds a live offer, A is cooling down - nobody eligible.
    expect(res.outcome).toBe("no_candidates");
  });
});

describe("🔴 deposit-required services are never auto-offered unpaid", () => {
  const DEPOSIT_ON = {
    paymentsMode: "deposit",
    connectChargesEnabled: true,
    stripeConnectAccountId: "acct_test_policy",
    depositAmountCents: 2000,
  };
  const DEPOSIT_OFF = {
    paymentsMode: "off",
    connectChargesEnabled: false,
    stripeConnectAccountId: null,
    depositAmountCents: null,
  };

  it("no offer is created; the entry stays WAITING for manual handling", async () => {
    __setConnectEnabledForTests(true);
    await prisma.service.update({ where: { id: serviceId }, data: { price: 35 } });
    const entry = await makeEntry();
    try {
      await withShopPolicy(DEPOSIT_ON, DEPOSIT_OFF, async () => {
        const res = await offerFreedSlot(freshSlot(), new Date());
        expect(res.outcome).toBe("requires_deposit");
        const offers = await prisma.waitlistOffer.count({
          where: { shopId, entryId: entry.id },
        });
        expect(offers).toBe(0);
        const e = await prisma.waitlistEntry.findUnique({ where: { id: entry.id } });
        expect(e!.status).toBe("WAITING"); // manual handling, not silently dropped
      });
    } finally {
      await prisma.service.update({ where: { id: serviceId }, data: { price: null } });
    }
  });

  it("approval-mode shops are the carve-out: they collect on approval, so offers flow", async () => {
    __setConnectEnabledForTests(true);
    await prisma.service.update({ where: { id: serviceId }, data: { price: 35 } });
    await makeEntry();
    try {
      await withShopPolicy(
        { ...DEPOSIT_ON, requireBookingApproval: true },
        { ...DEPOSIT_OFF, requireBookingApproval: false },
        async () => {
          expect((await offerFreedSlot(freshSlot(), new Date())).outcome).toBe("offered");
        },
      );
    } finally {
      await prisma.service.update({ where: { id: serviceId }, data: { price: null } });
    }
  });

  it("🔴 deposits flipped on MID-HOLD: the claim refuses, releases, and mints nothing", async () => {
    const slot = freshSlot();
    const entry = await makeEntry();
    const res = await offerTo(slot);

    __setConnectEnabledForTests(true);
    await prisma.service.update({ where: { id: serviceId }, data: { price: 35 } });
    try {
      await withShopPolicy(DEPOSIT_ON, DEPOSIT_OFF, async () => {
        const claim = await claimOffer({ token: res.token, now: new Date() });
        expect(claim.outcome).toBe("deposit_required");

        const offer = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
        expect(offer!.status).toBe("RELEASED");
        const appts = await prisma.appointment.count({
          where: { shopId, staffId, startsAt: slot.startsAt },
        });
        expect(appts).toBe(0); // never an unpaid appointment
        const e = await prisma.waitlistEntry.findUnique({ where: { id: entry.id } });
        expect(e!.status).toBe("WAITING"); // still on the list
      });
    } finally {
      await prisma.service.update({ where: { id: serviceId }, data: { price: null } });
    }
  });
});

describe("approval-mode shops keep their policy", () => {
  it("a claim creates a PENDING request that consumes the slot - never a silent booking", async () => {
    const slot = freshSlot();
    await makeEntry();
    const res = await offerTo(slot);

    await withShopPolicy(
      { requireBookingApproval: true },
      { requireBookingApproval: false },
      async () => {
        const claim = await claimOffer({ token: res.token, now: new Date() });
        expect(claim.outcome).toBe("claimed");
        if (claim.outcome !== "claimed") throw new Error("unreachable");
        expect(claim.pending).toBe(true);

        const appt = await prisma.appointment.findUnique({
          where: { id: claim.appointmentId },
        });
        expect(appt!.status).toBe("PENDING"); // the shop approves, as always
        expect(appt!.bookedVia).toBe("waitlist_offer");

        // The request still owns the physical time.
        await expect(
          prisma.$transaction((tx) =>
            lockStaffAndAssertSlotFree(tx, {
              staffId,
              shopId,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              bufferMin: 0,
              serviceDayLimit: null,
            }),
          ),
        ).rejects.toThrow(SlotTakenError);

        const offer = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
        expect(offer!.status).toBe("CLAIMED");
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* Phase D: preference-aware matching (DB side)                        */
/* The pure window/timezone/notice matrix lives in waitlistMatch.test; */
/* these prove the matcher through pickCandidate against real rows.    */
/* ------------------------------------------------------------------ */

/** Attach one preference window to an entry. */
async function addWindow(
  entryId: string,
  over: Partial<{ startDate: string | null; endDate: string | null; startMin: number | null; endMin: number | null }> = {},
) {
  await prisma.waitlistWindow.create({
    data: {
      shopId,
      entryId,
      startDate: over.startDate ?? null,
      endDate: over.endDate ?? null,
      startMin: over.startMin ?? null,
      endMin: over.endMin ?? null,
    },
  });
}

describe("phase D: the windows decide, in ranked order", () => {
  it("🔴 an OLDER entry whose window does not fit is skipped for a younger one that fits", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;

    const older = await makeEntry();
    await addWindow(older.id, {
      startDate: addDaysToDateKey(slotDate, 1), // wants ONLY the day after
      endDate: addDaysToDateKey(slotDate, 1),
    });
    const younger = await makeEntry();
    await addWindow(younger.id, { startDate: slotDate, endDate: slotDate });

    const res = await offerTo(slot);
    expect(res.entryId).toBe(younger.id);
    // The skipped entry lost nothing: still WAITING, no offer row.
    const e = await prisma.waitlistEntry.findUnique({ where: { id: older.id } });
    expect(e!.status).toBe("WAITING");
    expect(await prisma.waitlistOffer.count({ where: { entryId: older.id } })).toBe(0);
  });

  it("a full-fit time window wins; a partial-overlap one is skipped", async () => {
    const slot = freshSlot(); // 30 minutes long
    const view = wallParts(slot.startsAt, TZ);
    const slotDate = view.date;
    const startMin = view.minutes;

    const partial = await makeEntry();
    // Window covers the start but ends mid-appointment.
    await addWindow(partial.id, {
      startDate: slotDate,
      endDate: slotDate,
      startMin: Math.max(0, startMin - 60),
      endMin: startMin + 15,
    });
    const full = await makeEntry();
    await addWindow(full.id, {
      startDate: slotDate,
      endDate: slotDate,
      startMin,
      endMin: startMin + 30,
    });

    const res = await offerTo(slot);
    expect(res.entryId).toBe(full.id);
  });

  it("ranking is deterministic: same createdAt, the stable id tie-breaker decides", async () => {
    const slot = freshSlot();
    const instant = new Date("2026-01-05T12:00:00Z");
    const a = await makeEntry({ createdAt: instant });
    const b = await makeEntry({ createdAt: instant });
    const winner = [a.id, b.id].sort()[0]!;

    const res = await offerTo(slot);
    expect(res.entryId).toBe(winner);
  });

  it("minHoursNotice is honored through the engine: too-soon slots skip to the next entry", async () => {
    const slot = freshSlot(); // ~3 days out
    const fussy = await makeEntry({ minHoursNotice: 24 * 14 }); // wants 2 weeks' warning
    const easy = await makeEntry();

    const res = await offerTo(slot);
    expect(res.entryId).toBe(easy.id);

    // Alone, the fussy entry means no offer at all.
    await prisma.waitlistEntry.update({ where: { id: easy.id }, data: { status: "REMOVED" } });
    await prisma.waitlistOffer.updateMany({
      where: { shopId, status: "OFFERED" },
      data: { status: "RELEASED" },
    });
    const alone = await offerFreedSlot(freshSlot(), new Date());
    expect(alone.outcome).toBe("no_candidates");
    void fussy;
  });

  it("🔴 the ENTRY's timezone decides the calendar date, not the shop's", async () => {
    // A slot late in the New York evening is already TOMORROW in Tokyo. Two
    // entries want "exactly that Tokyo date": the Tokyo-zoned one matches,
    // the New York-zoned one does not - same window string, different clock.
    const base = freshSlot();
    const startsAt = new Date(base.startsAt.getTime() + 20 * 86_400_000); // clear of other lanes
    // Force a late-NY-evening instant: 02:30Z is 22:30 EDT the previous day.
    const lateEvening = new Date(
      Date.UTC(
        startsAt.getUTCFullYear(),
        startsAt.getUTCMonth(),
        startsAt.getUTCDate(),
        2,
        30,
      ),
    );
    const slot: FreedSlot = {
      ...base,
      startsAt: lateEvening,
      endsAt: new Date(lateEvening.getTime() + 30 * 60_000),
    };
    const tokyoDate = wallParts(slot.startsAt, "Asia/Tokyo").date;
    const nyDate = wallParts(slot.startsAt, TZ).date;
    expect(tokyoDate).not.toBe(nyDate); // the whole point

    const nyEntry = await makeEntry({ timezone: TZ });
    await addWindow(nyEntry.id, { startDate: tokyoDate, endDate: tokyoDate });
    const tokyoEntry = await makeEntry({ timezone: "Asia/Tokyo" });
    await addWindow(tokyoEntry.id, { startDate: tokyoDate, endDate: tokyoDate });

    const res = await offerTo(slot);
    expect(res.entryId).toBe(tokyoEntry.id);
  });

  it("a slot-entry join that captured no service/staff context matches ANY slot", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    // Exactly what the production dead-day form submits: no service, no staff.
    const noContext = await makeEntry({ serviceId: null, staffId: null });
    await addWindow(noContext.id, { startDate: slotDate, endDate: slotDate });

    const res = await offerTo(slot);
    expect(res.entryId).toBe(noContext.id);
    const row = await prisma.waitlistOffer.findUnique({ where: { id: res.offerId } });
    expect(row!.staffId).toBe(staffId); // the hold is concrete even if the wish wasn't
    expect(row!.serviceId).toBe(serviceId);
  });

  it("service-specific and barber-specific entries still filter before windows", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    const otherSvc = await prisma.service.create({
      data: { shopId, name: "Locs", durationMin: 60 },
      select: { id: true },
    });
    const wrongService = await makeEntry({ serviceId: otherSvc.id });
    await addWindow(wrongService.id, { startDate: slotDate, endDate: slotDate });
    const wrongBarber = await makeEntry({ staffId: otherStaffId });
    await addWindow(wrongBarber.id, { startDate: slotDate, endDate: slotDate });
    const anyAny = await makeEntry({ serviceId: null, staffId: "" });
    await addWindow(anyAny.id, { startDate: slotDate, endDate: slotDate });

    const res = await offerTo(slot);
    expect(res.entryId).toBe(anyAny.id);
  });

  it("nobody's windows fit -> no offer, and the slot stays public", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    for (let i = 0; i < 3; i++) {
      const e = await makeEntry();
      await addWindow(e.id, {
        startDate: addDaysToDateKey(slotDate, 2 + i),
        endDate: addDaysToDateKey(slotDate, 2 + i),
      });
    }
    const res = await offerFreedSlot(slot, new Date());
    expect(res.outcome).toBe("no_candidates");
    const grid = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: new Date(slot.startsAt.getTime() - 3600_000),
      toDate: new Date(slot.startsAt.getTime() + 3600_000),
      now: new Date(),
    });
    expect(grid.some((s) => s.startsAt.getTime() === slot.startsAt.getTime())).toBe(true);
  });

  it("🔴 no correctness cap: 750 ineligible candidates, number 751 still wins", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    const wrongDate = addDaysToDateKey(slotDate, 3);
    const ids = Array.from({ length: 750 }, (_, i) => `d-cap-${slotSeq}-${i}`);
    await prisma.waitlistEntry.createMany({
      data: ids.map((id, i) => ({
        id,
        shopId,
        firstName: `Cap${i}`,
        email: `cap-${i}@test.local`,
        createdAt: new Date(Date.now() - 2 * 86_400_000 + i * 1000),
      })),
    });
    await prisma.waitlistWindow.createMany({
      data: ids.map((id) => ({
        shopId, entryId: id, startDate: wrongDate, endDate: wrongDate,
        startMin: null, endMin: null,
      })),
    });
    const fit = await makeEntry(); // youngest = candidate #751
    await addWindow(fit.id, { startDate: slotDate, endDate: slotDate });

    const res = await offerTo(slot);
    expect(res.entryId).toBe(fit.id);
    expect(__lastScanStatsForTests.scanned).toBe(751);
    expect(__lastScanStatsForTests.pages).toBe(Math.ceil(751 / 50));

    // And when the winner is gone, the scan EXHAUSTS the list across many
    // pages and reports no candidate - it does not stop at some depth.
    await prisma.waitlistOffer.updateMany({
      where: { shopId, status: "OFFERED" },
      data: { status: "RELEASED" },
    });
    await prisma.waitlistEntry.update({
      where: { id: fit.id },
      data: { status: "REMOVED" },
    });
    const none = await offerFreedSlot(freshSlot(), new Date());
    expect(none.outcome).toBe("no_candidates");
    expect(__lastScanStatsForTests.scanned).toBe(750);
  });

  it("identical createdAt across page boundaries: the id cursor neither loops nor skips", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    const wrongDate = addDaysToDateKey(slotDate, 4);
    const instant = new Date(Date.now() - 86_400_000);
    // 120 same-instant, ineligible entries - the cursor must advance through
    // three pages purely on the (createdAt =, id >) branch.
    const ids = Array.from({ length: 120 }, (_, i) => `d-tie-${slotSeq}-${String(i).padStart(3, "0")}`);
    await prisma.waitlistEntry.createMany({
      data: ids.map((id, i) => ({
        id, shopId, firstName: `Tie${i}`, email: `tie-${i}@test.local`, createdAt: instant,
      })),
    });
    await prisma.waitlistWindow.createMany({
      data: ids.map((id) => ({
        shopId, entryId: id, startDate: wrongDate, endDate: wrongDate,
        startMin: null, endMin: null,
      })),
    });
    const fit = await makeEntry();
    await addWindow(fit.id, { startDate: slotDate, endDate: slotDate });

    const res = await offerTo(slot);
    expect(res.entryId).toBe(fit.id);
    expect(__lastScanStatsForTests.scanned).toBe(121); // every tie visited exactly once
  });

  it("an entry inserted WHILE the scan runs never breaks it: one offer, and the next scan sees them", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    const existing = await makeEntry();
    await addWindow(existing.id, { startDate: slotDate, endDate: slotDate });

    // Race a fitting insert (backdated to rank FIRST) against the scan.
    const insertRacer = (async () => {
      const e = await prisma.waitlistEntry.create({
        data: {
          shopId,
          firstName: "MidScan",
          email: `mid-${randomToken(4)}@test.local`,
          createdAt: new Date(Date.now() - 3 * 86_400_000),
        },
        select: { id: true },
      });
      await addWindow(e.id, { startDate: slotDate, endDate: slotDate });
      return e;
    })();
    const [offered, inserted] = await Promise.all([
      offerFreedSlot(slot, new Date()),
      insertRacer,
    ]);
    expect(offered.outcome).toBe("offered");
    // Exactly ONE hold exists regardless of interleaving.
    const holds = await prisma.waitlistOffer.count({
      where: { shopId, staffId, startsAt: slot.startsAt, status: "OFFERED" },
    });
    expect(holds).toBe(1);

    // A later slot's scan ranks the backdated newcomer first - nothing lost.
    const winner =
      offered.outcome === "offered" && offered.entryId === inserted.id
        ? existing.id
        : inserted.id;
    const next = await offerTo(freshSlot());
    expect(next.entryId).toBe(winner);
  });

  it("🔴 5,000-entry benchmark: exhaustive, bounded memory, reported numbers", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    const wrongDate = addDaysToDateKey(slotDate, 5);
    const ids = Array.from({ length: 5000 }, (_, i) => `d-bench-${slotSeq}-${String(i).padStart(4, "0")}`);
    await prisma.waitlistEntry.createMany({
      data: ids.map((id, i) => ({
        id, shopId, firstName: `B${i}`, email: `bench-${i}@test.local`,
        createdAt: new Date(Date.now() - 3 * 86_400_000 + i * 100),
      })),
    });
    await prisma.waitlistWindow.createMany({
      data: ids.map((id) => ({
        shopId, entryId: id, startDate: wrongDate, endDate: wrongDate,
        startMin: null, endMin: null,
      })),
    });
    const fit = await makeEntry();
    await addWindow(fit.id, { startDate: slotDate, endDate: slotDate });

    // Two concurrent freed-slot events over the huge list: still exactly one hold.
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      offerFreedSlot(slot, new Date()),
      offerFreedSlot(slot, new Date()),
    ]);
    const elapsed = Date.now() - t0;
    expect([a.outcome, b.outcome].sort()).toEqual(["offered", "unavailable"]);
    const holds = await prisma.waitlistOffer.count({
      where: { shopId, staffId, startsAt: slot.startsAt, status: "OFFERED" },
    });
    expect(holds).toBe(1);

    const { scanned, pages } = __lastScanStatsForTests;
    expect(scanned).toBe(5001);
    expect(pages).toBe(Math.ceil(5001 / 50)); // 101 keyset pages, one in memory at a time
    // ~2 queries per page (page + windows include); all-email fixtures, so no
    // client-batch queries. Reported for the PR:
    // eslint-disable-next-line no-console
    console.log(
      `[bench] 5,001 candidates scanned in ${elapsed}ms across ${pages} pages (~${pages * 2} queries)`,
    );
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it("a large waitlist: 300 non-fitting entries are scanned past, the one fit wins, fast", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    const wrongDate = addDaysToDateKey(slotDate, 3);

    // 300 older entries whose window is the wrong day - bulk-inserted with
    // explicit ids so the windows can reference them in one statement.
    const ids = Array.from({ length: 300 }, (_, i) => `d-perf-${slotSeq}-${i}`);
    await prisma.waitlistEntry.createMany({
      data: ids.map((id, i) => ({
        id,
        shopId,
        firstName: `Perf${i}`,
        email: `perf-${i}@test.local`,
        createdAt: new Date(Date.now() - 86_400_000 + i * 1000),
      })),
    });
    await prisma.waitlistWindow.createMany({
      data: ids.map((id) => ({
        shopId,
        entryId: id,
        startDate: wrongDate,
        endDate: wrongDate,
        startMin: null,
        endMin: null,
      })),
    });
    // The single fitting entry, YOUNGEST of all.
    const fit = await makeEntry();
    await addWindow(fit.id, { startDate: slotDate, endDate: slotDate });

    const t0 = Date.now();
    const res = await offerTo(slot);
    const elapsed = Date.now() - t0;
    expect(res.entryId).toBe(fit.id);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("reachability is explicit, never pretended", () => {
  it("email reaches; a known client's push reaches; an unknown phone-only entry waits for the barber", async () => {
    const now = new Date();

    // Oldest: unknown phone-only - must be SKIPPED (no channel exists).
    const phoneOnly = await makeEntry({ email: null, phone: "+15550002222" });
    // Next: email - reachable, and therefore the earliest ELIGIBLE.
    const emailed = await makeEntry();

    const first = await offerTo(freshSlot(), now);
    expect(first.entryId).toBe(emailed.id);
    expect(first.entry.email).not.toBeNull();

    // Link the phone-only person to a Client (a push target): now reachable.
    await prisma.client.create({
      data: {
        shopId,
        firstName: "Knows",
        phone: "+15550002222",
        acuityClientKey: `policy-${randomToken(6)}`,
        magicToken: randomToken(),
      },
    });
    const second = await offerTo(freshSlot(), now);
    expect(second.entryId).toBe(phoneOnly.id);
    expect(second.entry.clientId).not.toBeNull(); // push-capable, not pretending

    // And they stayed WAITING the whole time before that - never dropped.
    const e = await prisma.waitlistEntry.findUnique({ where: { id: phoneOnly.id } });
    expect(["WAITING"]).toContain(e!.status);
  });
});

/* ------------------------------------------------------------------ */
/* The keyset walk                                                     */
/* ------------------------------------------------------------------ */

describe("🔴 the scan visits every waiting entry exactly ONCE", () => {
  it("213 entries, ties straddling every page boundary: the trace IS the ranked list", async () => {
    const slot = freshSlot();
    const slotDate = wallParts(slot.startsAt, TZ).date;
    const wrongDate = addDaysToDateKey(slotDate, 5);
    const instant = Date.now() - 5 * 86_400_000;
    const seq = slotSeq; // fixed for the rest of this test

    // 213 = four full pages of fifty and a short fifth.
    //
    // Ties come in groups of SEVEN, and 7 does not divide 50, so no tie group
    // lines up with a page boundary: every page from the first to the fourth
    // ends in the MIDDLE of a group of same-instant entries. That is the only
    // place the (createdAt =, id >) arm of the predicate does any work, and
    // it is exactly where a hand-written cursor loses rows.
    const N = 213;
    const seeded = Array.from({ length: N }, (_, i) => ({
      // Ids are NOT in insertion order: (i * 97) mod 213 is a permutation (97
      // is coprime with 213), so ranking by createdAt alone would produce a
      // different list and the id tie-break has real work to do. Constant
      // prefix + fixed-width digits, so Postgres's collation and JavaScript's
      // string compare cannot disagree about the answer.
      id: `dwalk${seq}x${String((i * 97) % N).padStart(3, "0")}`,
      createdAt: new Date(instant + Math.floor(i / 7) * 1000),
    }));
    await prisma.waitlistEntry.createMany({
      data: seeded.map((s, i) => ({
        id: s.id,
        shopId,
        firstName: `Walk${i}`,
        email: `walk-${seq}-${i}@test.local`,
        createdAt: s.createdAt,
      })),
    });
    // Every one of them wants a different day, so none is ever SELECTED and
    // the scan has to walk the whole list to exhaustion rather than stopping
    // at the first fit.
    await prisma.waitlistWindow.createMany({
      data: seeded.map((s) => ({
        shopId,
        entryId: s.id,
        startDate: wrongDate,
        endDate: wrongDate,
        startMin: null,
        endMin: null,
      })),
    });

    const trace = __setScanTraceForTests(true);
    try {
      const res = await offerFreedSlot(slot, new Date());
      expect(res.outcome).toBe("no_candidates");
    } finally {
      __setScanTraceForTests(false);
    }

    // The ranking, derived independently of the query.
    const expected = [...seeded]
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((s) => s.id);

    // No repeats, no skips …
    expect(trace.length).toBe(N);
    expect(new Set(trace).size).toBe(N);
    // … and in exactly the ranked order. The count alone cannot tell a correct
    // walk from one that skipped a row and visited another twice - the two
    // errors cancel. Comparing identities is what makes this a proof.
    expect([...trace]).toEqual(expected);
    expect(__lastScanStatsForTests.scanned).toBe(N);
    expect(__lastScanStatsForTests.pages).toBe(Math.ceil(N / 50));
  });
});

/* ------------------------------------------------------------------ */
/* The client link                                                     */
/* ------------------------------------------------------------------ */

describe("clientId is a shortcut to the same client, never a different answer", () => {
  it("a live link reaches, even when the number matches nobody", async () => {
    const linked = await prisma.client.create({
      data: {
        shopId,
        firstName: "Linked",
        phone: `+1555100${String(1000 + slotSeq).slice(-4)}`,
        acuityClientKey: `link-${randomToken(6)}`,
        magicToken: randomToken(),
      },
      select: { id: true },
    });
    // The entry's own number matches no client at all, so the phone map is
    // empty and only the link can carry this.
    const entry = await makeEntry({
      email: null,
      phone: "+15550000404",
      clientId: linked.id,
    });

    const res = await offerTo(freshSlot());
    expect(res.entryId).toBe(entry.id);
    expect(res.entry.clientId).toBe(linked.id);
  });

  it("🔴 an ARCHIVED link falls back to the phone match - archive a duplicate, re-add the person, they stay reachable", async () => {
    const phone = "+15550000505";
    const archived = await prisma.client.create({
      data: {
        shopId,
        firstName: "Dup",
        phone,
        archivedAt: new Date(),
        acuityClientKey: `dup-${randomToken(6)}`,
        magicToken: randomToken(),
      },
      select: { id: true },
    });
    const live = await prisma.client.create({
      data: {
        shopId,
        firstName: "ReAdded",
        phone,
        acuityClientKey: `re-${randomToken(6)}`,
        magicToken: randomToken(),
      },
      select: { id: true },
    });
    const entry = await makeEntry({ email: null, phone, clientId: archived.id });

    const res = await offerTo(freshSlot());
    expect(res.entryId).toBe(entry.id);
    // The LIVE record, not the archived one the link points at.
    expect(res.entry.clientId).toBe(live.id);
  });

  it("an archived link with nothing behind it is still unreachable - a link is not a channel", async () => {
    const archived = await prisma.client.create({
      data: {
        shopId,
        firstName: "Gone",
        phone: "+15550000606",
        archivedAt: new Date(),
        acuityClientKey: `gone-${randomToken(6)}`,
        magicToken: randomToken(),
      },
      select: { id: true },
    });
    // Oldest, so it would win on rank if it were reachable at all.
    const unreachable = await makeEntry({
      email: null,
      phone: "+15550000606",
      clientId: archived.id,
      createdAt: new Date(Date.now() - 4 * 86_400_000),
    });
    const emailed = await makeEntry();

    const res = await offerTo(freshSlot());
    expect(res.entryId).toBe(emailed.id);
    // And they were skipped, not dropped.
    const still = await prisma.waitlistEntry.findUnique({ where: { id: unreachable.id } });
    expect(still!.status).toBe("WAITING");
  });
});
