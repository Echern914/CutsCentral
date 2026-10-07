import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { __setExpoSenderForTests, __setPushSenderForTests, type PushPayload } from "../messaging/push.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "../engines/bookingWrite.js";
import { computeOpenSlots } from "../engines/slots.js";
import {
  claimTierOpening,
  createTierOpening,
  notifyInvitees,
  resendUnnotifiedOpenings,
} from "../engines/tierOpenings.js";
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
  __setPushSenderForTests(undefined);
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

    // The first send runs in the background and has a second invitation to
    // get through after gold's push: wait until it has claimed and stamped
    // both, or the call below can win the second claim and read as a resend.
    await vi.waitFor(
      async () =>
        expect(
          await prisma.tierOpeningRecipient.count({ where: { openingId: created.openingId, delivered: null } }),
        ).toBe(0),
      { timeout: 5_000 },
    );

    // The list is the invitation, not the tier - and each person on it is told
    // once. Sending again reaches nobody.
    sent.length = 0;
    const again = await notifyInvitees(created.openingId);
    expect(again.recipients).toBe(2);
    expect(again.sent).toBe(0);
    expect(forThis()).toEqual([]);
  });
});

/**
 * 🔴 TELLING THE INVITED MEMBERS: at most once each, never about a time that is
 * gone, and never lost to a restart.
 *
 * The first send runs after the hold commits, fire-and-forget. Before: it read
 * the list once and pushed to everyone on it, so a second call pushed everyone
 * again, a member who booked it mid-loop did not stop the rest being told, and
 * a deploy at the wrong moment left people invited and never told, with the
 * time held for them.
 */
describe("telling the invited members", () => {
  let goldToken = "";

  /**
   * The next 12:00 in the shop's zone. An Auto-fill opening is never pushed
   * in quiet hours, so its tests run at a midday they choose rather than
   * whenever this file happens to run.
   */
  const NOON = (() => {
    const real = new Date();
    const p = zonedDateParts(real, TZ);
    const today = zonedWallTimeToUtc(p.year, p.month0, p.day, 12 * 60, TZ);
    return today.getTime() > real.getTime() ? today : zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 12 * 60, TZ);
  })();
  const beforeNoon = (ms: number) => new Date(NOON.getTime() - ms);

  beforeAll(async () => {
    goldToken = `ExponentPushToken[${randomToken(12)}]`;
    await request(app).post("/api/me/devices").set(asCustomer(gold)).send({ expoPushToken: goldToken, platform: "ios" });
  });

  /** People with an invitation and no app link: a send to them reaches nobody. */
  async function bareInvitee(i: number) {
    const phone = randomPhone();
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `tel:${phone}`, magicToken: randomToken(), firstName: `Extra${i}`, phone, source: "manual" },
      select: { id: true },
    });
    const account = await prisma.customerAccount.create({
      data: { firstName: `Extra${i}`, phoneE164: phone, phoneVerifiedAt: new Date() },
      select: { id: true },
    });
    accountIds.push(account.id);
    return { accountId: account.id, clientId: client.id };
  }

  /**
   * An opening written straight to the database: createTierOpening sends on its
   * own, after commit, and that send would race whatever the test does next.
   */
  async function rawOpening(
    invited: { accountId: string; clientId: string; createdAt?: Date }[],
    opts: { source?: "manual" | "auto"; heldUntil?: Date } = {},
  ): Promise<string> {
    const at = freshStart();
    const opening = await prisma.tierOpening.create({
      data: {
        shopId,
        staffId,
        serviceId,
        startsAt: at,
        endsAt: new Date(at.getTime() + 30 * 60_000),
        minTier: "GOLD",
        // Held until just before it starts (days away) unless a test says otherwise.
        heldUntil: opts.heldUntil ?? new Date(at.getTime() - 60_000),
        source: opts.source ?? "manual",
        recipientCount: invited.length,
      },
      select: { id: true },
    });
    const base = Date.now() - 1_000;
    await prisma.tierOpeningRecipient.createMany({
      data: invited.map((p, i) => ({
        openingId: opening.id,
        accountId: p.accountId,
        clientId: p.clientId,
        createdAt: p.createdAt ?? new Date(base + i),
      })),
    });
    return opening.id;
  }

  /** Every push to gold's phone for one opening. */
  function capture(openingId: string, onSend?: () => Promise<void>) {
    const pushes: PushPayload[] = [];
    __setExpoSenderForTests({
      send: async (to, payload) => {
        if (to !== goldToken || !payload.url.includes(`opening=${openingId}`)) return;
        pushes.push(payload);
        await onSend?.();
      },
    });
    return pushes;
  }

  it("🔴 tells each person once - a second send reaches nobody, and the send is recorded", async () => {
    const openingId = await rawOpening([gold]);
    const pushes = capture(openingId);

    const first = await notifyInvitees(openingId);
    expect(first).toEqual({ recipients: 1, sent: 1, delivered: 1, stoppedEarly: false });
    expect(pushes).toHaveLength(1);

    const second = await notifyInvitees(openingId);
    expect(second.sent).toBe(0);
    expect(pushes).toHaveLength(1);

    const row = await prisma.tierOpeningRecipient.findFirstOrThrow({ where: { openingId } });
    expect(row.notifiedAt).not.toBeNull();
    expect(row.delivered).toBe(true);
  });

  it("🔴 two senders at once: exactly one push", async () => {
    const openingId = await rawOpening([gold]);
    const pushes = capture(openingId);
    const invite = await prisma.tierOpeningRecipient.findFirstOrThrow({ where: { openingId }, select: { id: true } });

    // Both read the invitation as unsent, then queue at the claim.
    const { results, settledEarly } = await raceBehindRowLock("TierOpeningRecipient", invite.id, [
      () => notifyInvitees(openingId),
      () => notifyInvitees(openingId),
    ]);
    expect(settledEarly).toBe(0);
    expect(winners(results).map((r) => r.sent).sort()).toEqual([0, 1]);
    expect(pushes).toHaveLength(1);
  });

  it("🔴 stops when the opening ends part way down the list", async () => {
    const extras = await Promise.all(Array.from({ length: 11 }, (_, i) => bareInvitee(i)));
    // Gold first in line; the other eleven after.
    const openingId = await rawOpening([gold, ...extras]);
    // Gold books it the moment their phone buzzes.
    capture(openingId, async () => {
      await prisma.tierOpening.update({ where: { id: openingId }, data: { status: "CLAIMED" } });
    });

    const result = await notifyInvitees(openingId);
    // The opening is re-read every ten sends: the ten already under way go
    // out, and nobody after that is told about a time that is gone.
    expect(result.stoppedEarly).toBe(true);
    expect(result.sent).toBe(10);
    expect(await prisma.tierOpeningRecipient.count({ where: { openingId, notifiedAt: null } })).toBe(2);
  });

  it("an opening that has already ended tells nobody", async () => {
    const released = await rawOpening([gold]);
    await prisma.tierOpening.update({ where: { id: released }, data: { status: "RELEASED" } });
    const lapsed = await rawOpening([gold], { heldUntil: new Date(Date.now() - 60_000) });
    const urls: string[] = [];
    __setExpoSenderForTests({ send: async (_to, payload) => void urls.push(payload.url) });
    for (const id of [released, lapsed]) {
      const r = await notifyInvitees(id);
      expect(r).toMatchObject({ sent: 0, stoppedEarly: true });
    }
    expect(urls.filter((u) => u.includes(`opening=${released}`) || u.includes(`opening=${lapsed}`))).toEqual([]);
  });

  it("🔴 an Auto-fill send a restart lost is picked up by the sweep, once", async () => {
    // Invited five minutes ago; the process died before anyone was told.
    const openingId = await rawOpening([{ ...gold, createdAt: beforeNoon(5 * 60_000) }], { source: "auto" });
    const pushes = capture(openingId);

    await resendUnnotifiedOpenings(NOON);
    expect(pushes).toHaveLength(1);
    await resendUnnotifiedOpenings(NOON);
    expect(pushes).toHaveLength(1);
  });

  it("🔴 the sweep never resends a MANUAL opening - a build from before send stamps already told everyone", async () => {
    // What a manual opening made by the previous build looks like here during
    // a deploy: sent to everyone, and nothing recorded.
    const openingId = await rawOpening([{ ...gold, createdAt: beforeNoon(5 * 60_000) }]);
    const pushes = capture(openingId);
    await resendUnnotifiedOpenings(NOON);
    expect(pushes).toEqual([]);
  });

  it("🔴 an Auto-fill opening wakes nobody: in quiet hours the invitation waits in the app", async () => {
    const p = zonedDateParts(NOON, TZ);
    const night = zonedWallTimeToUtc(p.year, p.month0, p.day, 23 * 60, TZ);
    const openingId = await rawOpening([gold], { source: "auto" });
    const pushes = capture(openingId);
    expect(await notifyInvitees(openingId, { now: night })).toMatchObject({ sent: 0 });
    expect(pushes).toEqual([]);
    expect(await prisma.tierOpeningRecipient.count({ where: { openingId, notifiedAt: null } })).toBe(1);
  });

  it("the sweep leaves alone an invitation too old to be worth sending, or on an opening that is over", async () => {
    const stale = await rawOpening([{ ...gold, createdAt: beforeNoon(20 * 60_000) }], { source: "auto" });
    const over = await rawOpening([{ ...gold, createdAt: beforeNoon(5 * 60_000) }], { source: "auto" });
    await prisma.tierOpening.update({ where: { id: over }, data: { status: "RELEASED" } });
    const sent: string[] = [];
    __setExpoSenderForTests({ send: async (_to, payload) => void sent.push(payload.url) });

    await resendUnnotifiedOpenings(NOON);
    expect(sent.filter((u) => u.includes(`opening=${stale}`) || u.includes(`opening=${over}`))).toEqual([]);
    expect(await prisma.tierOpeningRecipient.count({ where: { openingId: { in: [stale, over] }, notifiedAt: null } })).toBe(2);
  });

  it("🔴 an Auto-fill opening goes to the app only, and never onto the marketing ledger", async () => {
    // Gold also subscribed in a browser - a manual opening reaches it.
    const browser = await prisma.pushSubscription.create({
      data: { shopId, clientId: gold.clientId, kind: "web", endpoint: `https://push.test/${randomToken(10)}`, p256dh: "k", auth: "a" },
      select: { id: true },
    });
    try {
      const web: string[] = [];
      __setPushSenderForTests({ send: async (_sub, payload) => void web.push(payload) });
      const nudges = () => prisma.nudge.count({ where: { clientId: gold.clientId } });

      const auto = await rawOpening([gold], { source: "auto" });
      const autoPushes = capture(auto);
      const before = await nudges();
      await notifyInvitees(auto, { now: NOON });
      expect(autoPushes).toHaveLength(1);
      expect(web.filter((p) => p.includes(`opening=${auto}`))).toEqual([]);
      // Not marketing: no Nudge row, so attribution, the dashboard counts and
      // the 21-day nudge rule never see it.
      expect(await nudges()).toBe(before);

      // A manual opening behaves exactly as it shipped.
      const manual = await rawOpening([gold]);
      capture(manual);
      await notifyInvitees(manual);
      expect(web.filter((p) => p.includes(`opening=${manual}`))).toHaveLength(1);
      expect(await nudges()).toBe(before + 1);
    } finally {
      await prisma.pushSubscription.deleteMany({ where: { id: browser.id } });
    }
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

/**
 * 🔴 A CLAIM AND A BARBER'S BOOKING OVER THE HOLD NEVER DEADLOCK.
 *
 * The claim used to lock the opening row FIRST and ask for the barber's lock
 * after; a barber writing over the hold (a booking, or Undo on the cancel that
 * freed it) takes the barber's lock and THEN releases that row. Opposite
 * orders: Postgres killed one of them (40P01) and it surfaced as a 500.
 * The barrier holds the row so both are mid-flight before either finishes.
 */
describe("a claim against a barber writing over the hold", () => {
  const barberBooks = (startsAt: Date) =>
    prisma.$transaction(async (tx) => {
      await lockStaffAndAssertSlotFree(tx, {
        staffId,
        shopId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
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
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          manageToken: randomToken(),
        },
        select: { id: true },
      });
    });

  it("🔴 queue instead of deadlocking: one booking, no 500", async () => {
    const startsAt = freshStart();
    const held = await hold(startsAt);
    expect(held.status).toBe(201);
    const openingId = held.body.openingId as string;

    const { results, settledEarly } = await raceBehindRowLock<unknown>("TierOpening", openingId, [
      () => claimTierOpening({ accountId: gold.accountId, openingId }),
      () => barberBooks(startsAt),
    ]);
    expect(settledEarly).toBe(0);
    // Nothing died of a deadlock. The barber may lose to an appointment the
    // claim already made (that is the guard, not a deadlock) - nothing else.
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(SlotTakenError);
    }
    expect(JSON.stringify(results)).not.toMatch(/40P01|deadlock/i);
    const booked = await prisma.appointment.count({
      where: { shopId, staffId, startsAt, status: { in: ["BOOKED", "PENDING"] } },
    });
    expect(booked).toBe(1);
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

describe("🔴 a client the shop blocked from booking", () => {
  it("is not invited, not shown an opening held before the block, and cannot book it", async () => {
    const blocked = await member("GOLD", "Barred");
    const preview = async () =>
      (await request(app).post("/api/tier-openings/preview").set("Cookie", cookie).send({ minTier: "GOLD" })).body as {
        members: number;
        inApp: number;
      };

    // Held while they could still book: invited like any Gold member.
    const at = freshStart();
    const { openingId } = (await hold(at)).body;
    expect(await prisma.tierOpeningRecipient.count({ where: { openingId, accountId: blocked.accountId } })).toBe(1);
    const before = await preview();

    await prisma.client.update({ where: { id: blocked.clientId }, data: { bookingBlockedAt: new Date() } });

    // The barber's count drops by exactly them.
    expect(await preview()).toEqual({ members: before.members - 1, inApp: before.inApp - 1 });
    // Gone from their app, and a stale tap books nothing - the app reads the
    // 404 as "that one's gone", never a word about a block.
    const list = await request(app).get("/api/me/openings").set(asCustomer(blocked));
    expect(list.body.openings.map((o: { id: string }) => o.id)).not.toContain(openingId);
    expect(await claimTierOpening({ accountId: blocked.accountId, openingId })).toEqual({ outcome: "contact_shop" });
    const tap = await request(app).post(`/api/me/openings/${openingId}/book`).set(asCustomer(blocked));
    expect(tap.status).toBe(404);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(0);
    // Still held for everyone else invited.
    expect((await prisma.tierOpening.findUniqueOrThrow({ where: { id: openingId } })).status).toBe("HELD");

    // Held after the block: never invited at all.
    const later = (await hold(freshStart())).body.openingId as string;
    expect(await prisma.tierOpeningRecipient.count({ where: { openingId: later, accountId: blocked.accountId } })).toBe(0);
    expect(await prisma.tierOpeningRecipient.count({ where: { openingId: later, accountId: gold2.accountId } })).toBe(1);
  });
});
