import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, apiEnv, randomToken, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import {
  armBackgroundWorkTracking,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
} from "../backgroundWork.js";
import { __setExpoSenderForTests, type PushPayload } from "../messaging/push.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { formatOpeningWhen } from "../messaging/templates.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { MessageProvider } from "../messaging/provider.js";
import { cancelAppointment } from "./appointmentPromotion.js";
import { advanceAutoFill, AUTO_FILL_START_DELAY_MS, autoFillTriggerKey } from "./autoFill.js";
import { claimTierOpening, releaseTierOpening } from "./tierOpenings.js";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * AUTO-FILL ("Fill cancellations automatically"), END TO END.
 *
 * A client cancels; Gold members get the time to themselves for 15 minutes,
 * then EVERY client of the shop with the app is told it is open, and whoever
 * books it first on the booking page gets it. The contract:
 *   1. Only a CLIENT's own cancellation starts it - never the barber's - and
 *      only at a shop that switched it on.
 *   2. Gold first, held; then everyone, told once each, with nothing held.
 *      Under two hours' notice, or nobody Gold to reach: everyone at once.
 *   3. Only this shop's clients: never another shop's, an archived or
 *      blocked one, one who switched pushes off or has no phone registered,
 *      the person who cancelled, someone already booked, or someone told
 *      twice today already.
 *   4. It stops the moment the time is gone - booked, ended by the barber -
 *      or the shop switches it off; never a time too close to start; nobody
 *      woken at night.
 *   5. The waitlist's held offer gets the time only when nobody with the app
 *      can be reached.
 *
 * Every engine call is handed a fixed `now` at midday in the shop's zone, so
 * quiet hours never depend on when this file happens to run.
 */

const app = createApp();
const TZ = "America/New_York";
const emails: string[] = [];
const accountIds: string[] = [];
const tag = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "0");
let shopId = "";
let otherShopId = "";
let slug = "";
let staffId = "";
let serviceId = "";

type Member = { accountId: string; token: string; clientId: string; device: string | null };
let gold1: Member;
let gold2: Member;
let silver1: Member;
let silverNoApp: Member;
let bronze: Member;
/** A client with the app and no rewards tier yet. */
let fresh: Member;
let archived: Member;
let optedOut: Member;
let blocked: Member;
/** A client of ANOTHER shop, with the app. */
let outsider: Member;
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

async function member(
  tier: "BRONZE" | "SILVER" | "GOLD" | null,
  name: string,
  opts: { withApp?: boolean; shop?: string } = {},
): Promise<Member> {
  const phone = randomPhone();
  const client = await prisma.client.create({
    data: {
      shopId: opts.shop ?? shopId,
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
    data: { firstName: name, phoneE164: phone, phoneVerifiedAt: new Date() },
    select: { id: true },
  });
  accountIds.push(account.id);
  const token = mintCustomerSession(account.id, 0);
  const auth = { Authorization: `Bearer ${token}` };
  expect((await request(app).get("/api/me/home").set(auth)).status).toBe(200);
  let device: string | null = null;
  if (opts.withApp ?? true) {
    device = `ExponentPushToken[${randomToken(12)}]`;
    await request(app).post("/api/me/devices").set(auth).send({ expoPushToken: device, platform: "ios" });
  }
  return { accountId: account.id, token, clientId: client.id, device };
}

/** Every push, by the phone it reached. */
let pushes: { to: string; payload: PushPayload }[] = [];
const pushedTo = (m: Member) => pushes.filter((p) => p.to === m.device);
const everyonePushes = () => pushes.filter((p) => p.payload.title === "An opening just came up");

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

/** Someone books the time, the way the booking page writes it. */
function bookedBySomeoneElse(startsAt: Date) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: walkerClientId,
      firstName: "Quick",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * MIN),
      manageToken: randomToken(),
    },
  });
}

/** An upcoming visit for this member: they are left out, as someone already booked. */
function upcomingVisit(m: Member, offsetMs: number) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: m.clientId,
      firstName: "Booked",
      status: "BOOKED",
      startsAt: at(offsetMs),
      endsAt: at(offsetMs + 30 * MIN),
      manageToken: randomToken(),
    },
  });
}

const runFor = (appointmentId: string) =>
  prisma.autoFillRun.findFirst({ where: { appointmentId }, orderBy: { createdAt: "desc" } });
const toldIn = async (runId: string) =>
  (await prisma.autoFillRecipient.findMany({ where: { runId }, select: { accountId: true } }))
    .map((r) => r.accountId)
    .sort();
const ids = (...ms: Member[]) => ms.map((m) => m.accountId).sort();

/**
 * Put a finished everyone stage back to "chosen, nobody told yet" - where a
 * restart between choosing and telling leaves it - so the next sweep sends.
 */
async function rewindToUntold(runId: string, nextAt: Date) {
  await prisma.autoFillRecipient.updateMany({ where: { runId }, data: { notifiedAt: null, delivered: null } });
  await prisma.autoFillRun.update({ where: { id: runId }, data: { state: "everyone", nextAt, outcome: null } });
}

/** Run the sweep at `when` and wait for everything it set off. */
async function sweep(when: Date) {
  await advanceAutoFill(when);
  await settleBackgroundWork();
}

const started = at(AUTO_FILL_START_DELAY_MS + 1_000);
/** Gold's head start, begun at `started`, is over. */
const headStartOver = at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN + 1_000);

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

async function ownerShop(name: string): Promise<string> {
  const email = `autofill-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Filler", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(shop.status).toBe(201);
  return shop.body.id as string;
}

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests(noSms);
  __setSendEmailForTests(async () => ({ id: "email", status: "sent" }));
  armBackgroundWorkTracking();
  shopId = await ownerShop("Fill Cuts");
  slug = `fill-cuts-${tag}`;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      slug,
      timezone: TZ,
      bookingMode: "native",
      rewardsEnabled: true,
      autoFillEnabled: true,
      publicPageEnabled: true,
      bookingLeadMinutes: 0,
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

  otherShopId = await ownerShop("Other Cuts");
  await prisma.shop.update({
    where: { id: otherShopId },
    data: { timezone: TZ, bookingMode: "native", rewardsEnabled: true, publicPageEnabled: true },
  });

  gold1 = await member("GOLD", "Goldie");
  gold2 = await member("GOLD", "Aurum");
  silver1 = await member("SILVER", "Sterling");
  silverNoApp = await member("SILVER", "Paper", { withApp: false });
  bronze = await member("BRONZE", "Copper");
  fresh = await member(null, "Newbie");
  archived = await member("SILVER", "Gone");
  await prisma.client.update({ where: { id: archived.clientId }, data: { archivedAt: NOW } });
  optedOut = await member("BRONZE", "Quiet");
  await prisma.customerAccount.update({ where: { id: optedOut.accountId }, data: { pushEnabled: false } });
  blocked = await member("BRONZE", "Banned");
  await prisma.client.update({ where: { id: blocked.clientId }, data: { bookingBlockedAt: NOW } });
  outsider = await member("GOLD", "Elsewhere", { shop: otherShopId });
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
  await prisma.autoFillRun.deleteMany({ where: { shopId } }); // and its recipients
  await prisma.waitlistOffer.deleteMany({ where: { shopId } });
  await prisma.waitlistEntry.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.service.update({ where: { id: serviceId }, data: { visibility: "public" } });
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
  for (const id of [shopId, otherShopId]) if (id) await prisma.emailIntent.deleteMany({ where: { shopId: id } });
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  for (const id of [shopId, otherShopId]) if (id) await prisma.shop.deleteMany({ where: { id } });
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
    await sweep(started);

    expect(await prisma.autoFillRun.count({ where: { shopId } })).toBe(0);
    expect(pushes).toEqual([]);
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
    await prisma.waitlistOffer.deleteMany({ where: { shopId } });
    await prisma.waitlistEntry.deleteMany({ where: { shopId } });
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Fresh", email: `f-${randomToken(4)}@t.local` } });

    // ...with it, the run owns the time.
    await prisma.shop.update({ where: { id: shopId }, data: { autoFillEnabled: true } });
    const withIt = await clientCancels();
    await settleBackgroundWork();
    expect(await runFor(withIt.id)).toMatchObject({ state: "queued" });
    expect(await prisma.waitlistOffer.count({ where: { shopId, startsAt: withIt.startsAt } })).toBe(0);
  });
});

describe("Gold's head start, then everyone", () => {
  it("🔴 Gold alone, held for 15 minutes; nobody else hears yet", async () => {
    const appt = await clientCancels();
    await sweep(started);

    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId }, include: { recipients: true } });
    expect(opening).toMatchObject({ source: "auto", minTier: "GOLD", heldUntil: at(AUTO_FILL_START_DELAY_MS + 1_000 + 15 * MIN), startsAt: appt.startsAt });
    expect(opening.recipients.map((r) => r.accountId).sort()).toEqual(ids(gold1, gold2));
    expect(opening.recipients.every((r) => r.wave === "gold" && r.notifiedAt !== null)).toBe(true);
    const run = await runFor(appt.id);
    expect(run).toMatchObject({ state: "gold", openingId: opening.id, nextAt: opening.heldUntil });

    expect(pushedTo(gold1)).toHaveLength(1);
    expect(pushedTo(gold1)[0]!.payload.title).toBe("Fill Cuts: first pick for Gold members");
    expect(pushes).toHaveLength(2);
    expect(await toldIn(run!.id)).toEqual([]);
  });

  it("🔴 then everyone with the app at THIS shop hears, once each - exactly the right people", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    const appt = await clientCancels();
    await sweep(started);
    pushes = [];

    await sweep(headStartOver);
    const run = await runFor(appt.id);
    // Silver, Bronze, and a client with no tier yet. Not Gold (told already),
    // not Paper (no phone registered), not the archived, blocked or
    // opted-out client, and not another shop's client.
    expect(await toldIn(run!.id)).toEqual(ids(silver1, bronze, fresh));
    for (const m of [silver1, bronze, fresh]) expect(pushedTo(m), m.accountId).toHaveLength(1);
    for (const m of [gold1, gold2, archived, optedOut, blocked, outsider]) expect(pushedTo(m)).toEqual([]);
    expect(pushes).toHaveLength(3);

    const p = pushedTo(fresh)[0]!.payload;
    expect(p.title).toBe("An opening just came up");
    expect(p.body).toBe(`Fill Cuts: ${formatOpeningWhen(appt.startsAt, TZ)} - tap to book`);
    expect(formatOpeningWhen(appt.startsAt, TZ)).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2} at \d{1,2}:\d{2} (AM|PM)$/);
    const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
    expect(p.url).toBe(`${base}/book/${slug}?service=${serviceId}&staff=${staffId}`);
    // No client's name in it: the same words go to everyone.
    expect(JSON.stringify(p)).not.toMatch(/Walker|Newbie|Goldie/);

    // Everyone told: the run is done, nothing is held, and the waitlist's
    // held offer is NOT made - the time is on the booking page for whoever
    // books first.
    expect(run).toMatchObject({ state: "closed", outcome: "broadcast" });
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);
    const recipients = await prisma.autoFillRecipient.findMany({ where: { runId: run!.id } });
    expect(recipients.every((r) => r.notifiedAt !== null && r.delivered === true && r.shopId === shopId)).toBe(true);

    // A later sweep tells nobody again.
    pushes = [];
    await sweep(at(40 * MIN));
    expect(pushes).toEqual([]);
  });

  it("🔴 a Gold member books it during the head start: nobody else is told", async () => {
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    expect((await claimTierOpening({ accountId: gold2.accountId, openingId: opening.id, now: at(5 * MIN) })).outcome).toBe("claimed");
    pushes = [];

    await sweep(headStartOver);
    const run = await runFor(appt.id);
    expect(run).toMatchObject({ state: "closed", outcome: "claimed" });
    expect(await toldIn(run!.id)).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("🔴 booked on the booking page the moment the head start ended: nobody is told", async () => {
    const appt = await clientCancels();
    await sweep(started);
    pushes = [];
    await bookedBySomeoneElse(appt.startsAt);

    await sweep(headStartOver);
    const run = await runFor(appt.id);
    expect(run).toMatchObject({ state: "closed", outcome: "filled" });
    expect(await toldIn(run!.id)).toEqual([]);
    expect(pushes).toEqual([]);
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 under two hours' notice: no head start - everyone, Gold included, at once", async () => {
    const appt = await clientCancels({ startOffsetMs: 90 * MIN });
    await sweep(started);
    expect(await prisma.tierOpening.count({ where: { shopId } })).toBe(0);
    const run = await runFor(appt.id);
    expect(await toldIn(run!.id)).toEqual(ids(gold1, gold2, silver1, bronze, fresh));
    expect(everyonePushes()).toHaveLength(5);
    expect(pushes).toHaveLength(5);
    expect(run).toMatchObject({ state: "closed", outcome: "broadcast" });
  });

  it("nobody Gold to reach: everyone at once", async () => {
    await upcomingVisit(gold1, 3 * 24 * 60 * MIN);
    await upcomingVisit(gold2, 3 * 24 * 60 * MIN + 60 * MIN);
    const appt = await clientCancels();
    await sweep(started);
    expect(await prisma.tierOpening.count({ where: { shopId } })).toBe(0);
    expect(await toldIn((await runFor(appt.id))!.id)).toEqual(ids(silver1, bronze, fresh));
  });
});

describe("who is never told", () => {
  it("🔴 the person who cancelled - through the record they cancelled, or its email", async () => {
    const copperEmail = `copper-${randomToken(4)}@t.local`;
    await prisma.client.update({ where: { id: silver1.clientId }, data: { email: copperEmail } });
    try {
      const own = await clientCancels({ clientId: bronze.clientId, startOffsetMs: 60 * MIN });
      await sweep(started);
      expect(await toldIn((await runFor(own.id))!.id)).not.toContain(bronze.accountId);

      const byEmail = await clientCancels({ email: copperEmail.toUpperCase(), startOffsetMs: 90 * MIN });
      await sweep(started);
      expect(await toldIn((await runFor(byEmail.id))!.id)).not.toContain(silver1.accountId);
    } finally {
      await prisma.client.update({ where: { id: silver1.clientId }, data: { email: null } });
    }
  });

  it("🔴 someone who already has a visit booked here", async () => {
    await upcomingVisit(silver1, 2 * 24 * 60 * MIN);
    const appt = await clientCancels({ startOffsetMs: 90 * MIN });
    await sweep(started);
    expect(await toldIn((await runFor(appt.id))!.id)).toEqual(ids(gold1, gold2, bronze, fresh));
  });

  it("🔴 nobody hears more than twice a day from one shop: the third opening tells nobody", async () => {
    for (const offset of [60, 90]) {
      await clientCancels({ startOffsetMs: offset * MIN });
      await sweep(started);
    }
    expect(pushedTo(fresh)).toHaveLength(2);
    pushes = [];

    const third = await clientCancels({ startOffsetMs: 120 * MIN });
    await sweep(started);
    expect(pushes).toEqual([]);
    // Nobody with the app left to tell: the waitlist's turn.
    expect(await runFor(third.id)).toMatchObject({ state: "closed", outcome: "no_members" });
  });

  it("🔴 the head start counts against the cap too", async () => {
    // Gold 1 was invited (and told) twice in the last few hours.
    for (const h of [0, 1]) {
      const old = await prisma.tierOpening.create({
        data: { shopId, staffId, serviceId, startsAt: at(5 * 24 * 60 * MIN + h * 60 * MIN), endsAt: at(5 * 24 * 60 * MIN + h * 60 * MIN + 30 * MIN), minTier: "GOLD", heldUntil: at(-60 * MIN), status: "RELEASED" },
        select: { id: true },
      });
      await prisma.tierOpeningRecipient.create({
        data: { openingId: old.id, accountId: gold1.accountId, clientId: gold1.clientId, createdAt: at(-3 * 60 * MIN), notifiedAt: at(-3 * 60 * MIN), delivered: true },
      });
    }
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId, source: "auto" }, include: { recipients: true } });
    expect(opening.recipients.map((r) => r.accountId)).toEqual([gold2.accountId]);
    await sweep(headStartOver);
    expect(await toldIn((await runFor(appt.id))!.id)).not.toContain(gold1.accountId);
    expect(pushedTo(gold1)).toEqual([]);
  });
});

describe("when it stops, or never starts", () => {
  it("🔴 too close to the start: held for nobody, told to nobody - the booking page has it", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    const appt = await clientCancels({ startOffsetMs: 40 * MIN });
    await sweep(started);
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "too_soon" });
    expect(await prisma.tierOpening.count({ where: { shopId } })).toBe(0);
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);
    expect(pushes).toEqual([]);
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

  it("at night with no time left by morning: nothing", async () => {
    const p = zonedDateParts(NOW, TZ);
    const night = zonedWallTimeToUtc(p.year, p.month0, p.day, 23 * 60, TZ);
    const morning = zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 8 * 60, TZ);
    // 08:30: the deadline is 08:00, exactly when quiet hours end.
    const appt = await clientCancels({ startOffsetMs: morning.getTime() - NOW.getTime() + 30 * MIN, cancelAt: night });
    await sweep(new Date(night.getTime() + AUTO_FILL_START_DELAY_MS + 1_000));
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "quiet_hours" });
    expect(await prisma.tierOpening.count({ where: { shopId } })).toBe(0);
    expect(pushes).toEqual([]);
  });

  it("🔴 a head start that ends after 21:00: everyone hears at 08:00, not at night", async () => {
    const p = zonedDateParts(NOW, TZ);
    // Cancelled 20:34: Gold alone until 20:50.
    const evening = zonedWallTimeToUtc(p.year, p.month0, p.day, 20 * 60 + 34, TZ);
    const night = zonedWallTimeToUtc(p.year, p.month0, p.day, 21 * 60 + 1, TZ);
    const morning = zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 8 * 60, TZ);
    const nextLate = zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 11 * 60, TZ);
    const appt = await clientCancels({ startOffsetMs: nextLate.getTime() - NOW.getTime(), cancelAt: evening });
    await sweep(new Date(evening.getTime() + AUTO_FILL_START_DELAY_MS + 1_000));
    expect(await runFor(appt.id)).toMatchObject({ state: "gold" });
    pushes = [];

    // The sweep that should have opened it at 20:50 runs late, at 21:01.
    await sweep(night);
    const run = await runFor(appt.id);
    expect(run).toMatchObject({ state: "gold", nextAt: morning });
    expect(await toldIn(run!.id)).toEqual([]);
    expect(pushes).toEqual([]);

    await sweep(morning);
    expect(await toldIn(run!.id)).toEqual(ids(silver1, bronze, fresh));
    expect(everyonePushes()).toHaveLength(3);
  });

  it("🔴 a service the booking page hides, rewards off, or the switch off since the cancel: nothing", async () => {
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
      {
        setup: () => prisma.shop.update({ where: { id: shopId }, data: { autoFillEnabled: false } }),
        undo: () => prisma.shop.update({ where: { id: shopId }, data: { autoFillEnabled: true } }),
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

  it("🔴 the service hidden during the head start: nobody else is pushed, and the waitlist gets it", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    const appt = await clientCancels();
    await sweep(started);
    await prisma.service.update({ where: { id: serviceId }, data: { visibility: "hidden" } });
    pushes = [];
    await sweep(headStartOver);
    const run = await runFor(appt.id);
    expect(run).toMatchObject({ state: "closed", outcome: "service_hidden" });
    expect(await toldIn(run!.id)).toEqual([]);
    expect(pushes).toEqual([]);
    expect(await prisma.waitlistOffer.count({ where: { shopId, startsAt: appt.startsAt } })).toBe(1);
  });

  it("🔴 switched off while everyone is being told: the rest are not, and nothing is handed on", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    const appt = await clientCancels({ startOffsetMs: 90 * MIN });
    await sweep(started);
    const run = (await runFor(appt.id))!;
    await rewindToUntold(run.id, started);
    await prisma.shop.update({ where: { id: shopId }, data: { autoFillEnabled: false } });
    pushes = [];

    await sweep(at(3 * MIN));
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "gates" });
    expect(pushes).toEqual([]);
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 booked before the next batch goes out: the rest are not told", async () => {
    const appt = await clientCancels({ startOffsetMs: 90 * MIN });
    await sweep(started);
    const run = (await runFor(appt.id))!;
    await rewindToUntold(run.id, started);
    await bookedBySomeoneElse(appt.startsAt);
    pushes = [];

    await sweep(at(3 * MIN));
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "filled" });
    expect(pushes).toEqual([]);
  });

  it("🔴 booked while the pushes are going out: it stops within ten", async () => {
    // Nine more clients with the app, so fourteen are told in all.
    const extra: Member[] = [];
    for (let i = 0; i < 9; i++) extra.push(await member(null, `Extra${i}`));
    try {
      const appt = await clientCancels({ startOffsetMs: 90 * MIN });
      let booked = false;
      __setExpoSenderForTests({
        send: async (to, payload) => {
          pushes.push({ to, payload });
          if (!booked) {
            booked = true;
            await bookedBySomeoneElse(appt.startsAt);
          }
        },
      });
      await sweep(started);
      const run = (await runFor(appt.id))!;
      expect(run).toMatchObject({ state: "closed", outcome: "filled" });
      // The time was taken during the first push; the check after every tenth caught it.
      expect(pushes).toHaveLength(10);
      expect(await prisma.autoFillRecipient.count({ where: { runId: run.id, notifiedAt: null } })).toBe(14 - 10);
    } finally {
      await prisma.client.updateMany({ where: { id: { in: extra.map((m) => m.clientId) } }, data: { archivedAt: NOW } });
    }
  });

  it("🔴 undone before it starts: closed, and nobody told", async () => {
    const appt = await clientCancels();
    await prisma.appointment.update({ where: { id: appt.id }, data: { status: "BOOKED", canceledAt: null } });
    await sweep(started);
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "restored" });
    expect(pushes).toEqual([]);
  });
});

describe("the head start's own endings", () => {
  it("🔴 nobody with the app left after Gold: the waitlist gets its turn", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    for (const [i, m] of [silver1, bronze, fresh].entries()) await upcomingVisit(m, 3 * 24 * 60 * MIN + i * 60 * MIN);
    const appt = await clientCancels();
    await sweep(started);
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);

    await sweep(headStartOver);
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "no_members" });
    const offer = await prisma.waitlistOffer.findFirstOrThrow({ where: { shopId } });
    expect(offer.startsAt).toEqual(appt.startsAt);
    // At an Auto-fill shop each waitlist hold is 15 minutes too.
    expect(offer.expiresAt).toEqual(new Date(headStartOver.getTime() + 15 * MIN));
  });

  it("🔴 a service hidden after the push is not booked through the app; the hold goes", async () => {
    await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    await prisma.service.update({ where: { id: serviceId }, data: { visibility: "hidden" } });
    const tap = await claimTierOpening({ accountId: gold1.accountId, openingId: opening.id, now: at(5 * MIN) });
    expect(tap.outcome).toBe("not_found");
    expect(await prisma.tierOpening.findUniqueOrThrow({ where: { id: opening.id } })).toMatchObject({ status: "RELEASED" });
    expect(await prisma.appointment.count({ where: { shopId, status: "BOOKED" } })).toBe(0);
  });

  it("🔴 the barber ends it: Auto-fill stops, tells nobody else and hands nothing on", async () => {
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Patient", email: `p-${randomToken(4)}@t.local` } });
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    expect(await releaseTierOpening(shopId, opening.id, at(5 * MIN))).toBe(true);
    pushes = [];
    await sweep(headStartOver);
    const run = await runFor(appt.id);
    expect(run).toMatchObject({ state: "closed", outcome: "released" });
    expect(await toldIn(run!.id)).toEqual([]);
    expect(pushes).toEqual([]);
    expect(await prisma.waitlistOffer.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 the waitlist never gets back the time its own canceller just gave up", async () => {
    const leaver = `leaver-${randomToken(4)}@t.local`;
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Leaver", email: leaver } });
    const other = await prisma.waitlistEntry.create({
      data: { shopId, firstName: "Other", email: `o-${randomToken(4)}@t.local`, createdAt: new Date(Date.now() + 1_000) },
      select: { id: true },
    });
    const appt = await clientCancels({ email: leaver.toUpperCase() });
    // Rewards switched off before the run starts: the time goes straight on to the waitlist.
    await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: false } });
    await sweep(started);
    expect(await runFor(appt.id)).toMatchObject({ outcome: "gates" });
    const offer = await prisma.waitlistOffer.findFirstOrThrow({ where: { shopId } });
    expect(offer.entryId).toBe(other.id);
  });
});

describe("two things at once", () => {
  it("🔴 a Gold member booking as the head start ends: one booking, and nobody told after a claim", async () => {
    const appt = await clientCancels();
    await sweep(started);
    const opening = await prisma.tierOpening.findFirstOrThrow({ where: { shopId } });
    pushes = [];

    const { results, settledEarly } = await raceBehindRowLock<unknown>("TierOpening", opening.id, [
      () => claimTierOpening({ accountId: gold1.accountId, openingId: opening.id, now: new Date(opening.heldUntil.getTime() - 1_000) }),
      () => advanceAutoFill(headStartOver),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(winners(results).some((r) => (r as { outcome?: string }).outcome === "claimed")).toBe(true);
    await settleBackgroundWork();

    expect(await prisma.appointment.count({ where: { shopId, startsAt: appt.startsAt, status: "BOOKED" } })).toBe(1);
    const run = (await runFor(appt.id))!;
    expect(run.state).toBe("closed");
    if (run.outcome === "claimed") {
      // The booking won: nobody was chosen for a time already taken.
      expect(await toldIn(run.id)).toEqual([]);
      expect(pushes).toEqual([]);
    } else {
      // The stage opened first, then the booking landed: it stopped on it.
      expect(["filled", "broadcast"]).toContain(run.outcome);
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

  it("🔴 two sweeps telling everyone at once: each person hears exactly once", async () => {
    const appt = await clientCancels({ startOffsetMs: 90 * MIN });
    await sweep(started);
    const run = (await runFor(appt.id))!;
    await rewindToUntold(run.id, started);
    const [first] = await prisma.autoFillRecipient.findMany({
      where: { runId: run.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1,
    });
    pushes = [];

    // Both sweeps choose the same unsent list, then meet at the first stamp.
    const { results, settledEarly } = await raceBehindRowLock<unknown>("AutoFillRecipient", first!.id, [
      () => advanceAutoFill(at(3 * MIN)),
      () => advanceAutoFill(at(3 * MIN)),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    await settleBackgroundWork();

    for (const m of [gold1, gold2, silver1, bronze, fresh]) expect(pushedTo(m), m.accountId).toHaveLength(1);
    expect(pushes).toHaveLength(5);
    expect(await runFor(appt.id)).toMatchObject({ state: "closed", outcome: "broadcast" });
  });
});
