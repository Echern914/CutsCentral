import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import {
  armBackgroundWorkTracking,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
} from "../backgroundWork.js";
import { __setExpoSenderForTests, type PushPayload } from "../messaging/push.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { MessageProvider } from "../messaging/provider.js";
import { cancelAppointment } from "./appointmentPromotion.js";
import { advanceAutoFill, AUTO_FILL_START_DELAY_MS, autoFillTriggerKey } from "./autoFill.js";
import { claimTierOpening, releaseTierOpening } from "./tierOpenings.js";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * AUTO-FILL, END TO END.
 *
 * A client cancels; the time goes to Gold members in the app, then Silver,
 * then the waitlist, then the booking page. The contract:
 *   1. Only a CLIENT's own cancellation starts it - never the barber's.
 *   2. Gold first; Silver joins the same opening; nobody is told twice.
 *   3. Never the person who cancelled, someone already booked, someone the
 *      shop blocked, someone the app cannot reach, or someone told too often.
 *   4. Never a time too close to start, nobody woken at night, never a
 *      service the booking page hides or one a claim would have to pay for.
 *   5. When the tiers pass, the waitlist gets its turn; when a member books
 *      it or the barber steps in, everything stops.
 *
 * Every engine call is handed a fixed `now` at midday in the shop's zone, so
 * quiet hours never depend on when this file happens to run.
 */

const app = createApp();
const TZ = "America/New_York";
const emails: string[] = [];
const accountIds: string[] = [];
let cookie = "";
let shopId = "";
let staffId = "";
let serviceId = "";

type Member = { accountId: string; token: string; clientId: string; device: string | null };
let gold1: Member;
let gold2: Member;
let silver1: Member;
let silverNoApp: Member;
let bronze: Member;
let walkerClientId = "";

/** Tomorrow, 12:00 in the shop's zone. */
function middayTomorrow(): Date {
  const p = zonedDateParts(new Date(), TZ);
  return zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 12 * 60, TZ);
}
const NOW = middayTomorrow();
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1629${exch}${line}`;
}

async function member(tier: "BRONZE" | "SILVER" | "GOLD" | null, name: string, withApp = true): Promise<Member> {
  const phone = randomPhone();
  const client = await prisma.client.create({
    data: { shopId, acuityClientKey: `tel:${phone}`, magicToken: randomToken(), firstName: name, phone, loyaltyTier: tier, source: "manual" },
    select: { id: true },
  });
  const account = await prisma.customerAccount.create({
    data: { firstName: name, phoneE164: phone, phoneVerifiedAt: new Date() },
    select: { id: true },
  });
  accountIds.push(account.id);
  const token = mintCustomerSession(account.id, 0);
  const auth = { Authorization: `Bearer ${token}` };
  expect((await request(app).get("/api/me/home").set(auth)).status).toBe(200);
  let device: string | null = null;
  if (withApp) {
    device = `ExponentPushToken[${randomToken(12)}]`;
    await request(app).post("/api/me/devices").set(auth).send({ expoPushToken: device, platform: "ios" });
  }
  return { accountId: account.id, token, clientId: client.id, device };
}

/** Every push, by the phone it reached. */
let pushes: { to: string; payload: PushPayload }[] = [];
const pushedTo = (m: Member) => pushes.filter((p) => p.to === m.device);

/** A booked visit `startOffsetMs` after NOW, cancelled by the client at `cancelAt`. */
let lane = 0;
async function clientCancels(opts: { startOffsetMs?: number; clientId?: string; email?: string | null; cancelAt?: Date } = {}) {
  const startsAt = at(opts.startOffsetMs ?? (3 + lane++) * 60 * MIN);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: opts.clientId ?? walkerClientId,
      firstName: "Walker",
      email: opts.email ?? null,
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * MIN),
      manageToken: randomToken(),
    },
    select: { id: true, manageToken: true },
  });
  await cancelAppointment(shopId, appt.id, "CANCELED", opts.cancelAt ?? NOW, {
    applyPolicyFee: true,
    initiator: "customer",
  });
  return { id: appt.id, startsAt, manageToken: appt.manageToken };
}

const runFor = (appointmentId: string) =>
  prisma.autoFillRun.findFirst({ where: { appointmentId }, orderBy: { createdAt: "desc" } });

/** Run the sweep at `when` and wait for everything it set off. */
async function sweep(when: Date) {
  await advanceAutoFill(when);
  await settleBackgroundWork();
}

const started = at(AUTO_FILL_START_DELAY_MS + 1_000);

// The waitlist half really offers and really sends - with DRY_RUN on it would
// suppress every offer, and the tests below that say "the waitlist was not
// offered it" would pass for the wrong reason. Every send reaches a fake.
const ORIGINAL_DRY_RUN = process.env.DRY_RUN;
const noSms: MessageProvider = {
  channel: "SMS",
  async send() {
    return { sid: "SM0", status: "queued" };
  },
};

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests(noSms);
  __setSendEmailForTests(async () => ({ id: "email", status: "sent" }));
  armBackgroundWorkTracking();
  const email = `autofill-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Filler", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Fill Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      timezone: TZ,
      bookingMode: "native",
      rewardsEnabled: true,
      autoFillEnabled: true,
      publicPageEnabled: true,
      bookingLeadHours: 0,
      bookingBufferMin: 0,
      waitlistEnabled: true,
      slotOpenedTextsEnabled: true,
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

  gold1 = await member("GOLD", "Goldie");
  gold2 = await member("GOLD", "Aurum");
  silver1 = await member("SILVER", "Sterling");
  silverNoApp = await member("SILVER", "Paper", false);
  bronze = await member("BRONZE", "Copper");
  walkerClientId = (
    await prisma.client.create({
      data: { shopId, acuityClientKey: `walker-${randomToken(6)}`, magicToken: randomToken(), firstName: "Walker", source: "manual" },
      select: { id: true },
    })
  ).id;
});

beforeEach(() => {
  pushes = [];
  __setExpoSenderForTests({ send: async (to, payload) => void pushes.push({ to, payload }) });
});

afterEach(async () => {
  await settleBackgroundWork();
  __setExpoSenderForTests(undefined);
  // Each test starts from nobody invited and nobody booked: the caps and the
  // "already booked" rule would otherwise carry from one test to the next.
  await prisma.tierOpening.deleteMany({ where: { shopId } });
  await prisma.autoFillRun.deleteMany({ where: { shopId } });
  await prisma.waitlistOffer.deleteMany({ where: { shopId } });
  await prisma.waitlistEntry.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: { autoFillEnabled: true, rewardsEnabled: true, requireCardToBook: false, paymentsMode: "off" },
  });
});

afterAll(async () => {
  disarmBackgroundWorkTracking();
  __setMessageProviderForTests(undefined);
  __setSendEmailForTests(undefined);
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  if (shopId) await prisma.emailIntent.deleteMany({ where: { shopId } });
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  for (const e of emails) await prisma.user.deleteMany({ where: { email: e } });
});

describe("what starts it", () => {
  it("🔴 a client's own cancellation queues one run, named for that cancellation", async () => {
    const appt = await clientCancels();
    const run = await runFor(appt.id);
    expect(run).toMatchObject({
      triggerKey: autoFillTriggerKey(appt.id, 1),
      state: "queued",
      nextAt: at(AUTO_FILL_START_DELAY_MS),
    });
  });

  it("🔴 the barber's own cancel, a no-show, a time over a week out, or the switch off: nothing", async () => {
    const make = async (offsetMs: number) => {
      const startsAt = at(offsetMs);
      return prisma.appointment.create({
        data: { shopId, staffId, serviceId, clientId: walkerClientId, firstName: "W", status: "BOOKED", startsAt, endsAt: new Date(startsAt.getTime() + 30 * MIN), manageToken: randomToken() },
        select: { id: true },
      });
    };
    const barbers = await make(4 * 60 * MIN);
    await cancelAppointment(shopId, barbers.id, "CANCELED", NOW); // the dashboard's call
    const noShow = await make(5 * 60 * MIN);
    await cancelAppointment(shopId, noShow.id, "NO_SHOW", NOW, { initiator: "customer" });
    const farOut = await make(8 * 24 * 60 * MIN);
    await cancelAppointment(shopId, farOut.id, "CANCELED", NOW, { applyPolicyFee: true, initiator: "customer" });
    await prisma.shop.update({ where: { id: shopId }, data: { autoFillEnabled: false } });
    const off = await make(6 * 60 * MIN);
    await cancelAppointment(shopId, off.id, "CANCELED", NOW, { applyPolicyFee: true, initiator: "customer" });

    expect(await prisma.autoFillRun.count({ where: { shopId } })).toBe(0);
  });

  it("the manage page's cancel is the client's", async () => {
    // A real-clock route: a visit a few hours from now.
    const startsAt = new Date(Math.ceil((Date.now() + 5 * 60 * MIN) / (30 * MIN)) * 30 * MIN);
    const appt = await prisma.appointment.create({
      data: { shopId, staffId, serviceId, clientId: walkerClientId, firstName: "W", status: "BOOKED", startsAt, endsAt: new Date(startsAt.getTime() + 30 * MIN), manageToken: randomToken() },
      select: { id: true, manageToken: true },
    });
    const res = await request(app).post(`/api/book/manage/${appt.manageToken}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(await runFor(appt.id)).toMatchObject({ state: "queued" });
  });

  it("🔴 with a run queued, the waitlist is not offered the time behind its back", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    // Without Auto-fill, this cancellation offers the waitlist the time at once...
    await prisma.shop.update({ where: { id: shopId }, data: { autoFillEnabled: false } });
    const without = await clientCancels();
    await settleBackgroundWork();
    expect(await prisma.waitlistOffer.count({ where: { shopId, startsAt: without.startsAt } })).toBe(1);
    // A fresh person for the second half: whoever was just offered one is
    // holding it, and in the six-hour cooldown besides.
    await prisma.waitlistOffer.deleteMany({ where: { shopId } });
    await prisma.waitlistEntry.deleteMany({ where: { shopId } });
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Fresh", email: `f-${randomToken(4)}@t.local` } });

    // ...with it, the run owns the time, and the waitlist waits its turn.
    await prisma.shop.update({ where: { id: shopId }, data: { autoFillEnabled: true } });
    const withIt = await clientCancels();
    await settleBackgroundWork();
    expect(await runFor(withIt.id)).toMatchObject({ state: "queued" });
    expect(await prisma.waitlistOffer.count({ where: { shopId, startsAt: withIt.startsAt } })).toBe(0);
  });
});

describe("Gold first, then Silver", () => {
  it("🔴 both tiers and time for two stages: Gold alone for 15 minutes, held for 30", async () => {
    const appt = await clientCancels();
    await sweep(started);

    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId }, include: { recipients: true } });
    expect(opening).toMatchObject({ source: "auto", minTier: "GOLD", heldUntil: at(AUTO_FILL_START_DELAY_MS + 1_000 + 30 * MIN), startsAt: appt.startsAt });
    expect(opening.recipients.map((r) => r.accountId).sort()).toEqual([gold1.accountId, gold2.accountId].sort());
    expect(opening.recipients.every((r) => r.wave === "gold" && r.notifiedAt !== null)).toBe(true);
    expect(await runFor(appt.id)).toMatchObject({ state: "gold", openingId: opening.id });

    expect(pushedTo(gold1)).toHaveLength(1);
    expect(pushedTo(gold1)[0]!.payload.title).toBe("Fill Cuts: first pick for Gold members");
    expect(pushedTo(silver1)).toEqual([]);
    expect(pushedTo(bronze)).toEqual([]);
  });

  it("🔴 after 15 minutes Silver joins the SAME opening; Gold is not told twice and can still book", async () => {
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    pushes = [];

    await sweep(at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN + 1_000));
    const widened = await prisma.tierOpening.findUniqueOrThrow({ where: { id: opening.id }, include: { recipients: true } });
    expect(widened.minTier).toBe("SILVER");
    expect(widened.recipientCount).toBe(3);
    expect(widened.recipients.find((r) => r.accountId === silver1.accountId)?.wave).toBe("silver");
    expect(pushedTo(silver1)).toHaveLength(1);
    expect(pushedTo(silver1)[0]!.payload.title).toBe("Fill Cuts: an opening for Silver and Gold members");
    expect(pushedTo(gold1)).toEqual([]);
    expect(await runFor(appt.id)).toMatchObject({ state: "silver", nextAt: widened.heldUntil });

    // A Gold member who waited still has their invitation.
    const booked = await claimTierOpening({ accountId: gold1.accountId, openingId: opening.id, now: at(25 * MIN) });
    expect(booked.outcome).toBe("claimed");
    await sweep(new Date(widened.heldUntil.getTime() + 1_000));
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "claimed" });
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 a Gold member books it in the first stage: Silver is never invited", async () => {
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    expect((await claimTierOpening({ accountId: gold2.accountId, openingId: opening.id, now: at(5 * MIN) })).outcome).toBe("claimed");
    pushes = [];

    await sweep(at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN + 1_000));
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "claimed" });
    expect(await prisma.tierOpeningRecipient.count({ where: { openingId: opening.id, wave: "silver" } })).toBe(0);
    expect(pushedTo(silver1)).toEqual([]);
  });

  it("only Gold can be reached: one stage of 15 minutes, for Gold", async () => {
    // Silver already has a visit booked.
    await prisma.appointment.create({
      data: { shopId, staffId, serviceId, clientId: silver1.clientId, firstName: "S", status: "BOOKED", startsAt: at(3 * 24 * 60 * MIN), endsAt: at(3 * 24 * 60 * MIN + 30 * MIN), manageToken: randomToken() },
    });
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    expect(opening).toMatchObject({ minTier: "GOLD", heldUntil: at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN) });
    expect(await runFor(appt.id)).toMatchObject({ state: "silver", nextAt: opening.heldUntil });
  });

  it("under half an hour to spare: both tiers at once, for one stage", async () => {
    // Starts an hour from now: nothing held past 30 minutes before, so about
    // 29 minutes once the run starts - not enough for two stages.
    const appt = await clientCancels({ startOffsetMs: 60 * MIN });
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId }, include: { recipients: true } });
    expect(opening.minTier).toBe("SILVER");
    expect(opening.recipients).toHaveLength(3);
    expect(opening.heldUntil).toEqual(at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN));
    expect(pushedTo(gold1)[0]!.payload.title).toBe("Fill Cuts: an opening for Silver and Gold members");
    expect(await runFor(appt.id)).toMatchObject({ state: "silver" });
  });
});

describe("who is never asked", () => {
  it("🔴 the person who cancelled - through the record they cancelled, or its email", async () => {
    const goldEmail = `goldie-${randomToken(4)}@t.local`;
    await prisma.client.update({ where: { id: gold2.clientId }, data: { email: goldEmail } });
    try {
      // Gold 1 cancels their own visit; Gold 2's record shares the email on the
      // visit Walker cancelled.
      await clientCancels({ clientId: gold1.clientId });
      await sweep(started);
      const first = await prisma.tierOpening.findFirstOrThrow({ where: { shopId }, include: { recipients: true } });
      expect(first.recipients.map((r) => r.accountId)).not.toContain(gold1.accountId);
      await prisma.tierOpening.deleteMany({ where: { shopId } });

      await clientCancels({ email: goldEmail.toUpperCase() });
      await sweep(started);
      const second = await prisma.tierOpening.findFirstOrThrow({ where: { shopId }, include: { recipients: true } });
      expect(second.recipients.map((r) => r.accountId)).not.toContain(gold2.accountId);
    } finally {
      await prisma.client.update({ where: { id: gold2.clientId }, data: { email: null } });
    }
  });

  it("🔴 someone already booked, someone blocked, someone without the app, and Bronze", async () => {
    await prisma.appointment.create({
      data: { shopId, staffId, serviceId, clientId: gold2.clientId, firstName: "G", status: "BOOKED", startsAt: at(2 * 24 * 60 * MIN), endsAt: at(2 * 24 * 60 * MIN + 30 * MIN), manageToken: randomToken() },
    });
    await prisma.client.update({ where: { id: gold1.clientId }, data: { bookingBlockedAt: NOW } });
    try {
      await clientCancels();
      await sweep(started);
      const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId }, include: { recipients: true } });
      // Silver 1 is all that is left: Gold 2 is booked, Gold 1 blocked,
      // Paper has no app, Copper is Bronze.
      expect(opening.recipients.map((r) => r.accountId)).toEqual([silver1.accountId]);
    } finally {
      await prisma.client.update({ where: { id: gold1.clientId }, data: { bookingBlockedAt: null } });
    }
  });

  it("🔴 nobody hears more than twice a day from one shop", async () => {
    // Gold 1 was invited (and told) twice in the last few hours.
    const old = await prisma.tierOpening.create({
      data: { shopId, staffId, serviceId, startsAt: at(5 * 24 * 60 * MIN), endsAt: at(5 * 24 * 60 * MIN + 30 * MIN), minTier: "GOLD", heldUntil: at(-60 * MIN), status: "RELEASED" },
      select: { id: true },
    });
    const other = await prisma.tierOpening.create({
      data: { shopId, staffId, serviceId, startsAt: at(5 * 24 * 60 * MIN + 60 * MIN), endsAt: at(5 * 24 * 60 * MIN + 90 * MIN), minTier: "GOLD", heldUntil: at(-60 * MIN), status: "RELEASED" },
      select: { id: true },
    });
    for (const openingId of [old.id, other.id]) {
      await prisma.tierOpeningRecipient.create({
        data: { openingId, accountId: gold1.accountId, clientId: gold1.clientId, createdAt: at(-3 * 60 * MIN), notifiedAt: at(-3 * 60 * MIN), delivered: true },
      });
    }
    await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId, source: "auto" }, include: { recipients: true } });
    expect(opening.recipients.map((r) => r.accountId)).not.toContain(gold1.accountId);
    expect(opening.recipients.map((r) => r.accountId)).toContain(gold2.accountId);
  });
});

describe("when it holds nothing", () => {
  it("🔴 too close to the start: held for nobody - the booking page has it", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    // 40 minutes out: the deadline is 10 minutes away. At an Auto-fill shop
    // nothing is held inside it, the waitlist included, so anyone can book
    // it while they still can.
    const appt = await clientCancels({ startOffsetMs: 40 * MIN });
    await sweep(started);
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "too_soon" });
    expect(await prisma.tierOpening.count({ where: { shopId } })).toBe(0);
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);
    expect(pushes).toEqual([]);
  });

  it("🔴 a Silver stage that falls after 21:00 invites nobody; Gold keeps the rest of its hold", async () => {
    const p = zonedDateParts(NOW, TZ);
    // Cancelled 20:34: Gold alone until 20:50, held until 21:05.
    const evening = zonedWallTimeToUtc(p.year, p.month0, p.day, 20 * 60 + 34, TZ);
    const night = zonedWallTimeToUtc(p.year, p.month0, p.day, 21 * 60 + 1, TZ);
    const nextMorning = zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 11 * 60, TZ);
    const appt = await clientCancels({ startOffsetMs: nextMorning.getTime() - NOW.getTime(), cancelAt: evening });
    await sweep(new Date(evening.getTime() + AUTO_FILL_START_DELAY_MS + 1_000));
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    expect(await runFor(appt.id)).toMatchObject({ state: "gold" });
    expect(opening.heldUntil.getTime()).toBeGreaterThan(night.getTime());

    // The sweep that should have widened at 20:50 runs late, at 21:01.
    await sweep(night);
    expect(await prisma.tierOpeningRecipient.count({ where: { openingId: opening.id, wave: "silver" } })).toBe(0);
    expect(await runFor(appt.id)).toMatchObject({ state: "silver", nextAt: opening.heldUntil });
    expect(pushedTo(silver1)).toEqual([]);
  });

  it("🔴 the service hidden during the Gold stage: Silver is never pushed, and the waitlist gets it", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    const appt = await clientCancels();
    await sweep(started);
    await prisma.service.update({ where: { id: serviceId }, data: { visibility: "hidden" } });
    try {
      await sweep(at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN + 1_000));
      expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "service_hidden" });
      expect(pushedTo(silver1)).toEqual([]);
      expect(await prisma.waitlistOffer.count({ where: { shopId, startsAt: appt.startsAt } })).toBe(1);
    } finally {
      await prisma.service.update({ where: { id: serviceId }, data: { visibility: "public" } });
    }
  });

  it("🔴 at night it waits for 08:00, then runs", async () => {
    const p = zonedDateParts(NOW, TZ);
    const night = zonedWallTimeToUtc(p.year, p.month0, p.day, 23 * 60, TZ);
    const morning = zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 8 * 60, TZ);
    const appt = await clientCancels({ startOffsetMs: morning.getTime() - NOW.getTime() + 6 * 60 * MIN, cancelAt: night });

    await sweep(new Date(night.getTime() + AUTO_FILL_START_DELAY_MS + 1_000));
    expect(await runFor(appt.id)).toMatchObject({ state: "queued", nextAt: morning });
    expect(pushes).toEqual([]);

    await sweep(morning);
    expect(await runFor(appt.id)).toMatchObject({ state: "gold" });
    expect(pushedTo(gold1)).toHaveLength(1);
  });

  it("at night with no time left by morning: no hold", async () => {
    const p = zonedDateParts(NOW, TZ);
    const night = zonedWallTimeToUtc(p.year, p.month0, p.day, 23 * 60, TZ);
    const morning = zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 8 * 60, TZ);
    // 08:30: the deadline is 08:00, exactly when quiet hours end.
    const appt = await clientCancels({ startOffsetMs: morning.getTime() - NOW.getTime() + 30 * MIN, cancelAt: night });
    await sweep(new Date(night.getTime() + AUTO_FILL_START_DELAY_MS + 1_000));
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "quiet_hours" });
    expect(await prisma.tierOpening.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 a service the booking page hides, or rewards switched off since the cancel: nothing held", async () => {
    const cases: { setup: () => Promise<unknown>; undo: () => Promise<unknown>; outcome: string }[] = [
      {
        setup: () => prisma.service.update({ where: { id: serviceId }, data: { visibility: "hidden" } }),
        undo: () => prisma.service.update({ where: { id: serviceId }, data: { visibility: "public" } }),
        outcome: "service_hidden",
      },
      {
        setup: () => prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: false } }),
        undo: () => prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: true } }),
        outcome: "gates",
      },
    ];
    for (const c of cases) {
      const appt = await clientCancels();
      await c.setup();
      try {
        await sweep(started);
        expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: c.outcome });
      } finally {
        await c.undo();
      }
    }
    expect(await prisma.tierOpening.count({ where: { shopId } })).toBe(0);
    expect(pushes).toEqual([]);
  });

  it("🔴 undone before it starts: closed, and nobody told", async () => {
    const appt = await clientCancels();
    await prisma.appointment.update({ where: { id: appt.id }, data: { status: "BOOKED", canceledAt: null } });
    await sweep(started);
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "restored" });
    expect(pushes).toEqual([]);
  });
});

describe("how it ends", () => {
  it("🔴 nobody in the tiers takes it: the waitlist gets its turn when the hold runs out", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    // Only Gold reachable, so one 15-minute stage.
    await prisma.appointment.create({
      data: { shopId, staffId, serviceId, clientId: silver1.clientId, firstName: "S", status: "BOOKED", startsAt: at(3 * 24 * 60 * MIN), endsAt: at(3 * 24 * 60 * MIN + 30 * MIN), manageToken: randomToken() },
    });
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);

    const after = new Date(opening.heldUntil.getTime() + 1_000);
    await sweep(after);
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "lapsed" });
    const offer = await prisma.waitlistOffer.findFirstOrThrow({ where: { shopId } });
    expect(offer.startsAt).toEqual(appt.startsAt);
    // At an Auto-fill shop each waitlist hold is 15 minutes too.
    expect(offer.expiresAt).toEqual(new Date(after.getTime() + 15 * MIN));
  });

  it("🔴 a service hidden after the push is not booked through the app; the hold goes", async () => {
    await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    await prisma.service.update({ where: { id: serviceId }, data: { visibility: "hidden" } });
    try {
      const tap = await claimTierOpening({ accountId: gold1.accountId, openingId: opening.id, now: at(5 * MIN) });
      expect(tap.outcome).toBe("not_found");
      expect(await prisma.tierOpening.findUniqueOrThrow({ where: { id: opening.id } })).toMatchObject({ status: "RELEASED" });
      expect(await prisma.appointment.count({ where: { shopId, status: "BOOKED" } })).toBe(0);
    } finally {
      await prisma.service.update({ where: { id: serviceId }, data: { visibility: "public" } });
    }
  });

  it("🔴 the barber ends it: Auto-fill stops and hands nothing on", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    expect(await releaseTierOpening(shopId, opening.id, at(5 * MIN))).toBe(true);
    await sweep(at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN + 1_000));
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "released" });
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 the waitlist never gets back the time its own canceller just gave up", async () => {
    const leaver = `leaver-${randomToken(4)}@t.local`;
    // The canceller is FIRST on the waitlist, under the same email.
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Leaver", email: leaver } });
    const other = await prisma.waitlistEntry.create({
      data: { shopId, firstName: "Other", email: `o-${randomToken(4)}@t.local`, createdAt: new Date(Date.now() + 1_000) },
      select: { id: true },
    });
    const appt = await clientCancels({ email: leaver.toUpperCase() });
    // Rewards switched off before the run starts: no tiers, so the time goes
    // straight on to the waitlist.
    await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: false } });
    await sweep(started);
    expect(await runFor(appt.id)).toMatchObject({ outcome: "gates" });
    const offer = await prisma.waitlistOffer.findFirstOrThrow({ where: { shopId } });
    expect(offer.entryId).toBe(other.id);
  });

  it("🔴 nor a member who was offered it in the app and let it go", async () => {
    const goldEmail = `goldie-${randomToken(4)}@t.local`;
    await prisma.client.update({ where: { id: gold1.clientId }, data: { email: goldEmail } });
    try {
      await prisma.waitlistEntry.create({ data: { shopId, firstName: "Goldie", email: goldEmail } });
      const other = await prisma.waitlistEntry.create({
        data: { shopId, firstName: "Other", email: `o-${randomToken(4)}@t.local`, createdAt: new Date(Date.now() + 1_000) },
        select: { id: true },
      });
      // Only Gold, one stage; nobody books it.
      await prisma.appointment.create({
        data: { shopId, staffId, serviceId, clientId: silver1.clientId, firstName: "S", status: "BOOKED", startsAt: at(3 * 24 * 60 * MIN), endsAt: at(3 * 24 * 60 * MIN + 30 * MIN), manageToken: randomToken() },
      });
      await clientCancels();
      await sweep(started);
      const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
      await sweep(new Date(opening.heldUntil.getTime() + 1_000));
      const offer = await prisma.waitlistOffer.findFirstOrThrow({ where: { shopId } });
      expect(offer.entryId).toBe(other.id);
    } finally {
      await prisma.client.update({ where: { id: gold1.clientId }, data: { email: null } });
    }
  });
});

describe("two things at once", () => {
  it("🔴 a Gold member booking while Silver is added: one booking, and no invitations after it", async () => {
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    const widenAt = at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN + 1_000);

    const { results, settledEarly } = await raceBehindRowLock<unknown>("TierOpening", opening.id, [
      () => claimTierOpening({ accountId: gold1.accountId, openingId: opening.id, now: widenAt }),
      () => advanceAutoFill(widenAt),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(winners(results).some((r) => (r as { outcome?: string }).outcome === "claimed")).toBe(true);
    await settleBackgroundWork();

    expect(await prisma.appointment.count({ where: { shopId, startsAt: appt.startsAt, status: "BOOKED" } })).toBe(1);
    const run = await runFor(appt.id);
    const silverInvites = await prisma.tierOpeningRecipient.count({ where: { openingId: opening.id, wave: "silver" } });
    if (run?.state === "closed") {
      // The booking won: nobody else was invited to a time already taken.
      expect(run.outcome).toBe("claimed");
      expect(silverInvites).toBe(0);
    } else {
      // Silver was added first, then the booking: both are fine.
      expect(run?.state).toBe("silver");
    }
  });

  it("🔴 two sweeps at once start one opening", async () => {
    const appt = await clientCancels();
    const run = await runFor(appt.id);
    const { results, settledEarly } = await raceBehindRowLock<unknown>("AutoFillRun", run!.id, [
      () => advanceAutoFill(started),
      () => advanceAutoFill(started),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    await settleBackgroundWork();
    expect(await prisma.tierOpening.count({ where: { shopId } })).toBe(1);
    expect(pushedTo(gold1)).toHaveLength(1);
  });
});
