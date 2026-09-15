import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { __setExpoSenderForTests, type PushPayload } from "../messaging/push.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "../engines/bookingWrite.js";
import { computeOpenSlots } from "../engines/slots.js";
import { claimTierOpening, createTierOpening, notifyInvitees } from "../engines/tierOpenings.js";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * OPENINGS HELD FOR A TIER.
 *
 * The contract, in the order it matters:
 *   1. A held slot is gone from the public grid AND refused by the booking
 *      guard - for everyone but the claim. The grid and the write agree.
 *   2. Only the members invited when it was held can book it, in the app; two
 *      of them tapping at once end with exactly one booking.
 *   3. When the hold lapses nothing has to run: the slot is simply bookable
 *      again. The barber can end it early, or book over it himself.
 *   4. A hold nobody could hear about is never made.
 */

const app = createApp();
const TZ = "America/New_York";
const emails: string[] = [];
const accountIds: string[] = [];
let cookie = "";
let shopId = "";
let slug = "";
let staffId = "";
let serviceId = "";

let gold: { accountId: string; token: string; clientId: string };
let gold2: { accountId: string; token: string; clientId: string };
let silver: { accountId: string; token: string; clientId: string };

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1629${exch}${line}`;
}

/** A fresh 30-minute slot ~3 days out on the grid, one lane per call. */
let lane = 0;
function freshStart(): Date {
  const base = Math.ceil((Date.now() + 72 * 3600_000) / 1800_000) * 1800_000;
  return new Date(base + lane++ * 2 * 3600_000);
}

async function member(tier: "BRONZE" | "SILVER" | "GOLD" | null, name: string, demo = false) {
  const phone = randomPhone();
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:${phone}`,
      magicToken: randomToken(),
      firstName: name,
      phone,
      loyaltyTier: tier,
      source: "manual",
    },
    select: { id: true },
  });
  const account = await prisma.customerAccount.create({
    data: { firstName: name, phoneE164: phone, phoneVerifiedAt: new Date(), isDemo: demo },
    select: { id: true },
  });
  accountIds.push(account.id);
  const token = mintCustomerSession(account.id, 0, { demo });
  // Linking happens on the customer's own read, exactly as in the app.
  expect((await request(app).get("/api/me/home").set("Authorization", `Bearer ${token}`)).status).toBe(200);
  return { accountId: account.id, token, clientId: client.id };
}

const asCustomer = (m: { token: string }) => ({ Authorization: `Bearer ${m.token}` });

async function publicStarts(from: Date, now = new Date()): Promise<number[]> {
  const slots = await computeOpenSlots({
    shopId,
    staffId,
    serviceId,
    fromDate: new Date(from.getTime() - 3600_000),
    toDate: new Date(from.getTime() + 3600_000),
    now,
  });
  return slots.map((s) => s.startsAt.getTime());
}

async function hold(startsAt: Date, minTier: "BRONZE" | "SILVER" | "GOLD" = "GOLD", holdMinutes = 120) {
  const res = await request(app)
    .post("/api/tier-openings")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, startsAt: startsAt.toISOString(), minTier, holdMinutes });
  return res;
}

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  const email = `tier-open-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Opener", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Held Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  slug = shop.body.slug as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      timezone: TZ,
      bookingMode: "native",
      rewardsEnabled: true,
      publicPageEnabled: true,
      bookingLeadHours: 0,
      bookingBufferMin: 0,
    },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40 }, select: { id: true } })
  ).id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  await prisma.availabilityRule.createMany({
    data: Array.from({ length: 7 }, (_, weekday) => ({ shopId, staffId, weekday, startMin: 0, endMin: 1440 })),
  });

  gold = await member("GOLD", "Goldie");
  gold2 = await member("GOLD", "Aurum");
  silver = await member("SILVER", "Sterling");
  // The live demo: a Gold record on a demo account, LINKED like any other -
  // the linking engine refuses demo accounts, so the link is written directly.
  // It must never be invited: the App Store reviewer is not a customer here.
  const demo = await member("GOLD", "Demo", true);
  await prisma.customerClientLink.create({
    data: { accountId: demo.accountId, clientId: demo.clientId, shopId, matchedBy: "phone", status: "active" },
  });
});

afterEach(() => {
  __setExpoSenderForTests(undefined);
});

afterAll(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  for (const e of emails) await prisma.user.deleteMany({ where: { email: e } });
});

describe("holding a slot for a tier", () => {
  it("says who would hear about it before anything is held - and never counts the demo", async () => {
    // Three Gold records, but one of them is the live demo account.
    const gold = await request(app).post("/api/tier-openings/preview").set("Cookie", cookie).send({ minTier: "GOLD" });
    expect(gold.body).toEqual({ members: 3, inApp: 2 });
    const silverUp = await request(app).post("/api/tier-openings/preview").set("Cookie", cookie).send({ minTier: "SILVER" });
    expect(silverUp.body).toEqual({ members: 4, inApp: 3 });
  });

  it("🔴 a held slot is gone from the public grid AND refused by the booking guard", async () => {
    const at = freshStart();
    expect(await publicStarts(at)).toContain(at.getTime());

    const res = await hold(at);
    expect(res.status).toBe(201);
    expect(res.body.recipients).toBe(2);

    expect(await publicStarts(at)).not.toContain(at.getTime());
    const booking = await request(app)
      .post(`/api/book/${slug}`)
      .send({ staffId, serviceId, startsAt: at.toISOString(), firstName: "Walk", lastName: "Up", phone: "(302) 555-0460", email: "walkup0460@example.com" });
    expect(booking.status).toBe(409);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(0);
  });

  it("shows up in the app only for the members invited", async () => {
    const at = freshStart();
    const res = await hold(at);
    const mine = await request(app).get("/api/me/openings").set(asCustomer(gold));
    const opening = mine.body.openings.find((o: { id: string }) => o.id === res.body.openingId);
    expect(opening).toMatchObject({ tierLabel: "Gold", audience: "Gold members", serviceName: "Cut", staffName: "Sam", price: 40 });
    const theirs = await request(app).get("/api/me/openings").set(asCustomer(silver));
    expect(theirs.body.openings.map((o: { id: string }) => o.id)).not.toContain(res.body.openingId);
  });

  it("tells each invited member, and nobody else", async () => {
    const tokens = {
      gold: `ExponentPushToken[${randomToken(12)}]`,
      silver: `ExponentPushToken[${randomToken(12)}]`,
    };
    await request(app).post("/api/me/devices").set(asCustomer(gold)).send({ expoPushToken: tokens.gold, platform: "ios" });
    await request(app).post("/api/me/devices").set(asCustomer(silver)).send({ expoPushToken: tokens.silver, platform: "ios" });
    const sent: { to: string; payload: PushPayload }[] = [];
    __setExpoSenderForTests({ send: async (to, payload) => void sent.push({ to, payload }) });

    // Holding it sends the notifications itself, after its transaction commits.
    const at = freshStart();
    const created = await createTierOpening({ shopId, userId: null, staffId, serviceId, startsAt: at, minTier: "GOLD", holdMinutes: 120 });
    expect(created.outcome).toBe("held");
    if (created.outcome !== "held") return;
    const forThis = () => sent.filter((s) => s.payload.url.includes(`opening=${created.openingId}`));
    await vi.waitFor(() => expect(forThis()).toHaveLength(1), { timeout: 5_000 });

    expect(forThis().map((s) => s.to)).toEqual([tokens.gold]);
    expect(forThis()[0]!.payload.title).toBe("Held Cuts: an opening for Gold");
    expect(forThis()[0]!.payload.body).toMatch(/Cut with Sam\. Yours to book in the app until /);

    // Sending again reaches the same one person - the list is the invitation, not the tier.
    sent.length = 0;
    const again = await notifyInvitees(created.openingId);
    expect(again.recipients).toBe(2);
    expect(forThis().map((s) => s.to)).toEqual([tokens.gold]);
  });
});

describe("booking it", () => {
  it("🔴 an invited member books it; an uninvited one gets the same 404 as no opening at all", async () => {
    const at = freshStart();
    const { openingId } = (await hold(at)).body;

    const outsider = await request(app).post(`/api/me/openings/${openingId}/book`).set(asCustomer(silver));
    expect(outsider.status).toBe(404);
    const nothing = await request(app).post(`/api/me/openings/no-such-opening/book`).set(asCustomer(silver));
    expect(nothing.status).toBe(404);
    expect(outsider.body).toEqual(nothing.body);
    // 🔴 The INVITATION is what refused them, not their link to some record:
    // both answer 404 to the customer, so only the engine can tell them apart.
    expect(await claimTierOpening({ accountId: silver.accountId, openingId })).toEqual({ outcome: "not_found" });

    const booked = await request(app).post(`/api/me/openings/${openingId}/book`).set(asCustomer(gold));
    expect(booked.status).toBe(201);
    expect(booked.body.pending).toBe(false);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, startsAt: at } });
    expect(appt).toMatchObject({ clientId: gold.clientId, status: "BOOKED", bookedVia: "tier_opening", firstName: "Goldie" });
    expect(await prisma.tierOpening.findUnique({ where: { id: openingId }, select: { status: true, claimedAppointmentId: true } })).toEqual({
      status: "CLAIMED",
      claimedAppointmentId: appt.id,
    });

    const late = await request(app).post(`/api/me/openings/${openingId}/book`).set(asCustomer(gold2));
    expect(late.status).toBe(410);
    const list = await request(app).get("/api/me/openings").set(asCustomer(gold2));
    expect(list.body.openings.map((o: { id: string }) => o.id)).not.toContain(openingId);
  });

  it("🔴 two members tapping at the same moment: exactly one booking", async () => {
    const at = freshStart();
    const { openingId } = (await hold(at)).body;
    const { results, settledEarly } = await raceBehindRowLock("TierOpening", openingId, [
      () => claimTierOpening({ accountId: gold.accountId, openingId }),
      () => claimTierOpening({ accountId: gold2.accountId, openingId }),
    ]);
    expect(settledEarly).toBe(0);
    const outcomes = winners(results).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["claimed", "ended"]);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(1);
  });

  it("a member whose record the shop has since corrected cannot book as it", async () => {
    const m = await member("GOLD", "Moved");
    const at = freshStart();
    const { openingId } = (await hold(at)).body;
    // The shop fixes the phone on the record: the verified phone no longer
    // matches, so the link is re-derived away at the claim.
    await prisma.client.update({ where: { id: m.clientId }, data: { phone: randomPhone() } });
    const res = await request(app).post(`/api/me/openings/${openingId}/book`).set(asCustomer(m));
    expect(res.status).toBe(404);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(0);
  });
});

describe("then anyone", () => {
  it("🔴 when the hold lapses the slot is simply bookable again - nothing has to run", async () => {
    const at = freshStart();
    const created = await createTierOpening({ shopId, userId: null, staffId, serviceId, startsAt: at, minTier: "GOLD", holdMinutes: 30 });
    expect(created.outcome).toBe("held");
    if (created.outcome !== "held") return;
    const afterHold = new Date(created.heldUntil.getTime() + 60_000);

    expect(await publicStarts(at)).not.toContain(at.getTime());
    expect(await publicStarts(at, afterHold)).toContain(at.getTime());

    // The guard agrees with the grid on both sides of heldUntil.
    const guard = (now: Date) =>
      prisma.$transaction((tx) =>
        lockStaffAndAssertSlotFree(tx, {
          staffId,
          shopId,
          startsAt: at,
          endsAt: new Date(at.getTime() + 30 * 60_000),
          bufferMin: 0,
          serviceDayLimit: null,
          walkInCapacity: "enforce",
          now,
        }),
      );
    await expect(guard(new Date())).rejects.toBeInstanceOf(SlotTakenError);
    await expect(guard(afterHold)).resolves.toBeTruthy();

    // And the members can no longer claim it.
    expect(await claimTierOpening({ accountId: gold.accountId, openingId: created.openingId, now: afterHold })).toEqual({
      outcome: "ended",
    });
  });

  it("the barber can end a hold early", async () => {
    const at = freshStart();
    const { openingId } = (await hold(at)).body;
    expect(await publicStarts(at)).not.toContain(at.getTime());
    const res = await request(app).post(`/api/tier-openings/${openingId}/release`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(await publicStarts(at)).toContain(at.getTime());
    const list = await request(app).get("/api/tier-openings").set("Cookie", cookie);
    expect(list.body.openings.find((o: { id: string }) => o.id === openingId)).toMatchObject({ state: "released" });
  });

  it("a barber booking over it releases the hold instead of being refused; a customer's is refused", async () => {
    const at = freshStart();
    const { openingId } = (await hold(at)).body;
    const span = { staffId, shopId, startsAt: at, endsAt: new Date(at.getTime() + 30 * 60_000), bufferMin: 0 };
    await expect(
      prisma.$transaction((tx) => lockStaffAndAssertSlotFree(tx, { ...span, serviceDayLimit: null, walkInCapacity: "enforce" })),
    ).rejects.toBeInstanceOf(SlotTakenError);
    await prisma.$transaction((tx) =>
      lockStaffAndAssertSlotFree(tx, { ...span, serviceDayLimit: null, walkInCapacity: "ignore", overrideWaitlistHolds: true }),
    );
    expect((await prisma.tierOpening.findUnique({ where: { id: openingId } }))?.status).toBe("RELEASED");
  });
});

describe("refusals hold nothing", () => {
  it("nobody in that tier has the app: no hold, the slot stays public", async () => {
    const at = freshStart();
    await prisma.client.updateMany({ where: { id: { in: [gold.clientId, gold2.clientId] } }, data: { loyaltyTier: "SILVER" } });
    try {
      const res = await hold(at, "GOLD");
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("no_members");
    } finally {
      await prisma.client.updateMany({ where: { id: { in: [gold.clientId, gold2.clientId] } }, data: { loyaltyTier: "GOLD" } });
    }
    expect(await publicStarts(at)).toContain(at.getTime());
    expect(await prisma.tierOpening.count({ where: { shopId, startsAt: at } })).toBe(0);
  });

  it("a taken time, an already-held time, and a time with no hold left before it", async () => {
    const at = freshStart();
    expect((await hold(at)).status).toBe(201);
    const again = await hold(at, "SILVER");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("slot_unavailable");

    const soon = freshStart();
    const tooSoon = await createTierOpening({
      shopId,
      userId: null,
      staffId,
      serviceId,
      startsAt: soon,
      minTier: "GOLD",
      holdMinutes: 120,
      now: new Date(soon.getTime() - 5 * 60_000),
    });
    expect(tooSoon).toEqual({ outcome: "too_soon" });
  });

  it("with rewards off there are no tiers to hold for", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: false } });
    try {
      const res = await hold(freshStart());
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("rewards_off");
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: true } });
    }
  });

  it("an invalid tier or hold length is refused at the door", async () => {
    const at = freshStart().toISOString();
    for (const body of [
      { staffId, serviceId, startsAt: at, minTier: "PLATINUM", holdMinutes: 60 },
      { staffId, serviceId, startsAt: at, minTier: "GOLD", holdMinutes: 45 },
    ]) {
      const res = await request(app).post("/api/tier-openings").set("Cookie", cookie).send(body);
      expect(res.status).toBe(400);
    }
  });
});
