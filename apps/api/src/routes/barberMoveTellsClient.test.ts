import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { __setExpoSenderForTests, __setPushSenderForTests, type PushPayload } from "../messaging/push.js";
import { notifyClientMovedByShop } from "../services/appointmentNotify.js";
import {
  armBackgroundWorkTracking,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
} from "../backgroundWork.js";

/**
 * A BOOKING THE SHOP MOVES TELLS THE CLIENT'S APP (owner report, 2026-10-26:
 * a barber rescheduled an appointment and the customer's app never showed it).
 *
 * Both barber-side moves - the Reschedule button (POST .../reschedule, which
 * the barber's booking chat also goes through) and the appointment editor
 * (PATCH) - updated the row and sent, at most, the confirmation EMAIL: titled
 * "Booking confirmed", and from the editor only when an email had gone out for
 * the old time. No push at all. Now every real move of a BOOKED visit still to
 * come pushes "Appointment moved" to the client's phone, and the email says it
 * moved.
 *
 * The mailer and both push transports are test doubles at the module seams;
 * nothing leaves the process. The shop is NOT on UTC, so a time printed in the
 * server's zone instead of the shop's would fail here.
 */

const TZ = "America/Chicago";
const app = createApp();
const password = "supersecret123";
const owners: string[] = [];
let cookie: string;
let shopId: string;
let staffId: string;
let staff2Id: string;
let serviceId: string;

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
let pushes: { token: string; payload: PushPayload }[] = [];
/** The push transport throws on every send. */
let pushDown = false;
/** Sends the transport was asked for, including ones it threw on. */
let pushAttempts = 0;

function at(daysAhead: number, hourUtc: number, minute = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d.toISOString();
}

/** "Tue, Oct 28 at 3:00 PM" in the SHOP's zone, built here independently. */
function shopWhen(iso: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} at ${time}`;
}

/** A client on file with an email, and (optionally) the app on their phone. */
async function client(opts: { app?: boolean } = {}) {
  const first = `Mov${randomToken(4)}`;
  const email = `${first.toLowerCase()}@example.com`;
  const row = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `moved-notify-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: first,
      email,
    },
    select: { id: true },
  });
  const token = `ExponentPushToken[${randomToken(10)}]`;
  if (opts.app !== false) {
    await prisma.pushSubscription.create({
      data: { shopId, clientId: row.id, kind: "expo", expoPushToken: token },
    });
  }
  return { id: row.id, email, token };
}

/**
 * A booking the barber made for the client. `told` = the confirmation email
 * went out for it (the editor's email rule keys on that); otherwise nothing
 * was sent at all. Either way the mail and push logs are cleared after.
 */
async function booked(clientId: string, startsAt: string, opts: { told?: boolean; customTime?: boolean } = {}) {
  const res = await request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({
      staffId,
      serviceId,
      clientId,
      startsAt,
      notifyClient: opts.told === true,
      ...(opts.customTime ? { customTime: true } : {}),
    });
  expect(res.status).toBe(201);
  await settleBackgroundWork();
  mails = [];
  pushes = [];
  return res.body.id as string;
}

function reschedule(id: string, startsAt: string) {
  return request(app)
    .post(`/api/booking/appointments/${id}/reschedule`)
    .set("Cookie", cookie)
    .send({ startsAt, customTime: true });
}

function edit(id: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/booking/appointments/${id}`).set("Cookie", cookie).send(body);
}

const mailsTo = (to: string) => mails.filter((m) => m.to === to);
const pushesTo = (token: string) => pushes.filter((p) => p.token === token);

beforeAll(async () => {
  const email = `moved-${randomToken(6)}@test.local`.toLowerCase();
  owners.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Move Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Moved Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: TZ, bookingLeadHours: 1 });
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Drick" })).body.id;
  staff2Id = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId, staff2Id] });
  serviceId = service.body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 8 * 60, endMin: 18 * 60 }));
  for (const id of [staffId, staff2Id]) {
    await request(app).put(`/api/booking/staff/${id}/availability`).set("Cookie", cookie).send({ rules });
  }
  shopId = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.id;
});

beforeEach(() => {
  mails = [];
  pushes = [];
  pushDown = false;
  pushAttempts = 0;
  armBackgroundWorkTracking();
  __setSendEmailForTests(async (input) => {
    mails.push(input as Mail);
    return { id: `email_${mails.length}`, status: "sent" };
  });
  __setExpoSenderForTests({
    send: async (token, payload) => {
      pushAttempts += 1;
      if (pushDown) throw new Error("push transport exploded");
      pushes.push({ token, payload });
    },
  });
  // No browser subscriptions in this file; set so a stray one never goes live.
  __setPushSenderForTests({ send: async () => {} });
});

afterEach(async () => {
  await settleBackgroundWork();
  __setSendEmailForTests(undefined);
  __setExpoSenderForTests(undefined);
  __setPushSenderForTests(undefined);
  disarmBackgroundWorkTracking();
});

afterAll(async () => {
  for (const email of owners) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("Reschedule (and the barber chat, which moves through it)", () => {
  it("🔴 a move pushes 'Appointment moved' with the new time in the shop's zone - once - and the email says it moved", async () => {
    const c = await client();
    const id = await booked(c.id, at(3, 16));
    const to = at(3, 19, 30);
    const res = await reschedule(id, to);
    expect(res.status).toBe(200);
    await settleBackgroundWork();

    const pushed = pushesTo(c.token);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.title).toBe("Appointment moved");
    expect(pushed[0]!.payload.body).toBe(`Moved Cuts: now ${shopWhen(to)}`);
    expect(pushed[0]!.payload.url).toContain("/book/manage/");
    expect(pushed[0]!.payload.data).toEqual({ kind: "appointment_moved", appointmentId: id });

    const mine = mailsTo(c.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe(`Your appointment moved: ${shopWhen(to)}`);
    expect(mine[0]!.subject).not.toMatch(/Booking confirmed/);
    expect(mine[0]!.text).toContain(`has moved. It's now ${shopWhen(to)}`);
  });

  it("a client with no app on their phone gets the email and no push - and the move still succeeds", async () => {
    const c = await client({ app: false });
    const id = await booked(c.id, at(4, 16));
    expect((await reschedule(id, at(4, 18))).status).toBe(200);
    await settleBackgroundWork();
    expect(pushes).toHaveLength(0);
    expect(mailsTo(c.email)).toHaveLength(1);
  });

  it("🔴 a push service that throws never costs the move", async () => {
    const c = await client();
    const id = await booked(c.id, at(5, 16));
    pushDown = true;
    const to = at(5, 18);
    const res = await reschedule(id, to);
    expect(res.status).toBe(200);
    await settleBackgroundWork();
    // It really was tried (and threw) - not skipped.
    expect(pushAttempts).toBe(1);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startsAt: true, status: true } });
    expect(row.status).toBe("BOOKED");
    expect(row.startsAt.toISOString()).toBe(to);
  });

  it("an archived client is not pushed", async () => {
    const c = await client();
    const id = await booked(c.id, at(6, 16));
    await prisma.client.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
    expect((await reschedule(id, at(6, 18))).status).toBe(200);
    await settleBackgroundWork();
    expect(pushesTo(c.token)).toHaveLength(0);
  });
});

describe("The appointment editor (PATCH)", () => {
  it("🔴 a move of a booking ChairBack never emailed about still reaches the app - and still sends no email", async () => {
    const c = await client();
    const id = await booked(c.id, at(7, 16));
    const to = at(7, 19);
    const res = await edit(id, { startsAt: to, customTime: true });
    expect(res.status).toBe(200);
    await settleBackgroundWork();

    const pushed = pushesTo(c.token);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.title).toBe("Appointment moved");
    expect(pushed[0]!.payload.body).toBe(`Moved Cuts: now ${shopWhen(to)}`);
    expect(pushed[0]!.payload.data).toEqual({ kind: "appointment_moved", appointmentId: id });
    // The editor's email rule is unchanged: never mailed before, not mailed now.
    expect(mailsTo(c.email)).toHaveLength(0);
  });

  it("🔴 a client emailed about the old time gets the push AND an email that says it moved", async () => {
    const c = await client();
    const id = await booked(c.id, at(8, 16), { told: true });
    const to = at(8, 19);
    expect((await edit(id, { startsAt: to, customTime: true })).status).toBe(200);
    await settleBackgroundWork();
    expect(pushesTo(c.token)).toHaveLength(1);
    const mine = mailsTo(c.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe(`Your appointment moved: ${shopWhen(to)}`);
  });

  it("a move to someone else names who they are with now", async () => {
    const c = await client();
    const id = await booked(c.id, at(9, 16));
    expect((await edit(id, { staffId: staff2Id })).status).toBe(200);
    await settleBackgroundWork();
    const pushed = pushesTo(c.token);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.body).toBe(`Moved Cuts: now ${shopWhen(at(9, 16))} with Sam`);
  });

  it("🔴 an edit that moves nothing (notes, price, length) sends no push", async () => {
    const c = await client();
    const id = await booked(c.id, at(10, 16));
    expect((await edit(id, { notes: "bring a photo" })).status).toBe(200);
    expect((await edit(id, { price: 55, customTime: true })).status).toBe(200);
    expect((await edit(id, { durationMin: 45 })).status).toBe(200);
    await settleBackgroundWork();
    expect(pushesTo(c.token)).toHaveLength(0);
  });

  it("🔴 a visit in the past, moved around in the past, is never 'moved' news", async () => {
    const c = await client();
    const id = await booked(c.id, at(-2, 16), { customTime: true });
    expect((await edit(id, { startsAt: at(-2, 18), customTime: true })).status).toBe(200);
    await settleBackgroundWork();
    expect(pushesTo(c.token)).toHaveLength(0);
  });

  it("a cancelled booking can't be moved, and nothing goes out", async () => {
    const c = await client();
    const id = await booked(c.id, at(11, 16));
    await prisma.appointment.update({ where: { id }, data: { status: "CANCELED" } });
    expect((await edit(id, { startsAt: at(11, 18), customTime: true })).status).toBe(409);
    expect((await reschedule(id, at(11, 18))).status).toBe(409);
    await settleBackgroundWork();
    expect(pushesTo(c.token)).toHaveLength(0);
  });

  it("🔴 a push service that throws never costs the edit", async () => {
    const c = await client();
    const id = await booked(c.id, at(12, 16));
    pushDown = true;
    const to = at(12, 18);
    expect((await edit(id, { startsAt: to, customTime: true })).status).toBe(200);
    await settleBackgroundWork();
    expect(pushAttempts).toBe(1);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startsAt: true } });
    expect(row.startsAt.toISOString()).toBe(to);
  });
});

describe("the notifier reads the saved row, never the caller", () => {
  it("a booked visit still to come is announced (the control for the two below)", async () => {
    const c = await client();
    const id = await booked(c.id, at(13, 16));
    await notifyClientMovedByShop({ shopId, appointmentId: id });
    expect(pushesTo(c.token)).toHaveLength(1);
  });

  it("a booking cancelled by the time it runs is not announced", async () => {
    const c = await client();
    const id = await booked(c.id, at(13, 18));
    await prisma.appointment.update({ where: { id }, data: { status: "CANCELED" } });
    await notifyClientMovedByShop({ shopId, appointmentId: id });
    expect(pushesTo(c.token)).toHaveLength(0);
  });

  it("a visit whose time has passed is not announced", async () => {
    const c = await client();
    const id = await booked(c.id, at(-3, 16), { customTime: true });
    await notifyClientMovedByShop({ shopId, appointmentId: id });
    expect(pushesTo(c.token)).toHaveLength(0);
  });

});

describe("My ChairBack: the customer's own app account", () => {
  beforeAll(() => {
    process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
    __resetEnvCacheForTests();
  });
  afterAll(async () => {
    await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
    delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
    __resetEnvCacheForTests();
  });

  const accountIds: string[] = [];

  /** A client whose ONLY device is the phone signed in to their account. */
  async function appCustomer(pushEnabled: boolean) {
    const exch = 200 + Math.floor(Math.random() * 700);
    const phone = `+1628${exch}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
    const c = await prisma.client.create({
      data: { shopId, acuityClientKey: `moved-acct-${randomToken(8)}`, firstName: "Jordan", phone, magicToken: randomToken() },
      select: { id: true },
    });
    const acct = await prisma.customerAccount.create({
      data: { phoneE164: phone, phoneVerifiedAt: new Date(), pushEnabled },
    });
    accountIds.push(acct.id);
    const token = `ExponentPushToken[${randomToken(12)}]`;
    await prisma.customerDevice.create({ data: { accountId: acct.id, expoPushToken: token, platform: "ios" } });
    // Their first read links the record, as opening the app does.
    const home = await request(app)
      .get("/api/me/home")
      .set("Authorization", `Bearer ${mintCustomerSession(acct.id, 0)}`);
    expect(home.status).toBe(200);
    return { clientId: c.id, token };
  }

  it("🔴 the app on their own account is told - the phone that was showing the old time", async () => {
    const me = await appCustomer(true);
    const id = await booked(me.clientId, at(14, 16));
    const to = at(14, 18);
    expect((await reschedule(id, to)).status).toBe(200);
    await settleBackgroundWork();
    const pushed = pushesTo(me.token);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.body).toBe(`Moved Cuts: now ${shopWhen(to)}`);
  });

  it("one who switched notifications off in the app hears nothing", async () => {
    const me = await appCustomer(false);
    const id = await booked(me.clientId, at(15, 16));
    expect((await reschedule(id, at(15, 18))).status).toBe(200);
    await settleBackgroundWork();
    expect(pushesTo(me.token)).toHaveLength(0);
  });
});
