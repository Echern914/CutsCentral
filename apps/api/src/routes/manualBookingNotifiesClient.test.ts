import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests, ResendSendError } from "../messaging/email.js";
import { __setExpoSenderForTests, __setPushSenderForTests, type PushPayload } from "../messaging/push.js";
import {
  armBackgroundWorkTracking,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
} from "../backgroundWork.js";

/**
 * A BOOKING THE SHOP MAKES TELLS THE CLIENT (Eric, 2026-10-20: "when a barber
 * manually books appointments ... customers get notified either through email
 * or through the app notifications").
 *
 * Until now a dashboard booking - by phone, at the chair, Book again, off the
 * waitlist, a repeat - said nothing to the client; only "Didn't finish
 * booking" did. Now every one sends what a self-booked client gets (the same
 * confirmation email, never a text) plus a push to the app - once, for a time
 * still to come, unless the barber unticks it, and never at the cost of the
 * booking itself.
 *
 * The mailer and both push transports are test doubles at the module seams;
 * nothing leaves the process.
 */

const app = createApp();
const password = "supersecret123";
const owners: string[] = [];
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
let pushes: { token: string; payload: PushPayload }[] = [];
/** "reject": the provider refuses the next send. */
let failNextEmail = false;
/** The push transport is down for the next send. */
let failNextPush = false;

function at(daysAhead: number, hourUtc: number, minute = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d.toISOString();
}

function book(body: Record<string, unknown>) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, ...body });
}

/** A client on file with an email, and (optionally) the app on their phone. */
async function client(opts: { email?: string | null; app?: boolean } = {}) {
  const first = `Cli${randomToken(4)}`;
  const email = opts.email === undefined ? `${first.toLowerCase()}@example.com` : opts.email;
  const row = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `manual-notify-${randomToken(8)}`,
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

const mailsTo = (to: string | null) => mails.filter((m) => m.to === to);
const pushesTo = (token: string) => pushes.filter((p) => p.token === token);

beforeAll(async () => {
  const email = `notify-${randomToken(6)}@test.local`.toLowerCase();
  owners.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Notify Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Notify Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Drick" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  shopId = me.body.id;
});

beforeEach(() => {
  mails = [];
  pushes = [];
  failNextEmail = false;
  failNextPush = false;
  armBackgroundWorkTracking();
  __setSendEmailForTests(async (input) => {
    if (failNextEmail) {
      failNextEmail = false;
      throw new ResendSendError(422);
    }
    mails.push(input as Mail);
    return { id: `email_${mails.length}`, status: "sent" };
  });
  __setExpoSenderForTests({
    send: async (token, payload) => {
      if (failNextPush) {
        failNextPush = false;
        throw Object.assign(new Error("push service down"), { serviceFailure: true });
      }
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

describe("New appointment tells the client", () => {
  it("🔴 a booking for a client on file: the confirmation email AND an app push, once each", async () => {
    const c = await client();
    const res = await book({ clientId: c.id, startsAt: at(3, 10), operationId: `op-${randomToken(8)}` });
    expect(res.status).toBe(201);
    // Nothing to report and nothing to wait for: the barber's answer never
    // depends on a mailer.
    expect(res.body.clientConfirmation).toBeUndefined();
    await settleBackgroundWork();

    const mine = mailsTo(c.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe("Booking confirmed: Haircut at Notify Cuts");
    const pushed = pushesTo(c.token);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.title).toBe("Notify Cuts");
    expect(pushed[0]!.payload.body).toMatch(/^You're booked: Haircut, /);
    expect(pushed[0]!.payload.url).toContain("/book/manage/");

    // The same once-only stamp the public page's confirmation writes.
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: res.body.id },
      select: { confirmationEmailSentAt: true, confirmationSentAt: true },
    });
    expect(row.confirmationEmailSentAt).not.toBeNull();
    // Never a text: SMS costs money, and the confirmation text is off.
    expect(row.confirmationSentAt).toBeNull();
    const texts = await prisma.nudge.count({ where: { clientId: c.id, channel: "SMS" } });
    expect(texts).toBe(0);
  });

  it("a client with no app gets the email; one with no email gets the push", async () => {
    const emailOnly = await client({ app: false });
    const appOnly = await client({ email: null });
    expect((await book({ clientId: emailOnly.id, startsAt: at(3, 11) })).status).toBe(201);
    expect((await book({ clientId: appOnly.id, startsAt: at(3, 12) })).status).toBe(201);
    await settleBackgroundWork();
    expect(mailsTo(emailOnly.email)).toHaveLength(1);
    expect(pushesTo(emailOnly.token)).toHaveLength(0);
    expect(pushesTo(appOnly.token)).toHaveLength(1);
    expect(mails.filter((m) => m.to === null || m.to === "")).toHaveLength(0);
  });

  it("🔴 someone NEW, typed in with an email: that address gets the confirmation", async () => {
    const email = `walkup-${randomToken(5)}@example.com`;
    const res = await book({ firstName: "Walk", lastName: "Up", phone: "(302) 555-0177", email, startsAt: at(3, 13) });
    expect(res.status).toBe(201);
    await settleBackgroundWork();
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("🔴 unticked ('Send them a confirmation' off): nothing at all", async () => {
    const c = await client();
    const res = await book({ clientId: c.id, startsAt: at(3, 14), notifyClient: false });
    expect(res.status).toBe(201);
    await settleBackgroundWork();
    expect(mailsTo(c.email)).toHaveLength(0);
    expect(pushesTo(c.token)).toHaveLength(0);
  });

  it("🔴 a booking entered after the fact (the time has passed) is never 'you're booked'", async () => {
    const c = await client();
    const res = await book({ clientId: c.id, startsAt: at(-1, 10), customTime: true });
    expect(res.status).toBe(201);
    await settleBackgroundWork();
    expect(mailsTo(c.email)).toHaveLength(0);
    expect(pushesTo(c.token)).toHaveLength(0);
  });

  it("🔴 a retried submission (same operation id) is answered from the first - and sends nothing again", async () => {
    const c = await client();
    const body = { clientId: c.id, startsAt: at(3, 15), operationId: `op-${randomToken(8)}` };
    const first = await book(body);
    expect(first.status).toBe(201);
    await settleBackgroundWork();
    const again = await book(body);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    await settleBackgroundWork();
    expect(mailsTo(c.email)).toHaveLength(1);
    expect(pushesTo(c.token)).toHaveLength(1);
  });

  it("🔴 'Didn't finish booking' (confirmClient) is the ONE notification, not a second one beside it", async () => {
    const c = await client();
    const res = await book({ clientId: c.id, startsAt: at(4, 10), confirmClient: true });
    expect(res.status).toBe(201);
    expect(res.body.clientConfirmation).toBe("email");
    await settleBackgroundWork();
    expect(mailsTo(c.email)).toHaveLength(1);
    expect(pushesTo(c.token)).toHaveLength(1);
  });

  it("confirmClient with notifyClient:false asks for two opposite things: refused, nothing booked", async () => {
    const c = await client();
    const res = await book({ clientId: c.id, startsAt: at(4, 11), confirmClient: true, notifyClient: false });
    expect(res.status).toBe(400);
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.id } })).toBe(0);
  });

  it("🔴 a repeat sends ONE confirmation for the whole run, not one per visit", async () => {
    const c = await client();
    const res = await book({ clientId: c.id, startsAt: at(5, 10), recurrence: { interval: 1, count: 3 } });
    expect(res.status).toBe(201);
    expect(res.body.series.booked).toBe(3);
    await settleBackgroundWork();
    const mine = mailsTo(c.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("This repeats: all 3 visits are booked.");
    const pushed = pushesTo(c.token);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.body).toContain("and 2 more visits");
  });

  it("a repeat the barber unticked sends nothing", async () => {
    const c = await client();
    const res = await book({
      clientId: c.id,
      startsAt: at(5, 12),
      recurrence: { interval: 1, count: 2 },
      notifyClient: false,
    });
    expect(res.status).toBe(201);
    await settleBackgroundWork();
    expect(mailsTo(c.email)).toHaveLength(0);
    expect(pushesTo(c.token)).toHaveLength(0);
  });

  it("🔴 a mailer that refuses, or a push service that is down, never costs the booking", async () => {
    const c = await client();
    failNextEmail = true;
    failNextPush = true;
    const res = await book({ clientId: c.id, startsAt: at(6, 10) });
    expect(res.status).toBe(201);
    await settleBackgroundWork();
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: res.body.id },
      select: { status: true, confirmationEmailSentAt: true },
    });
    expect(row.status).toBe("BOOKED");
    // Nothing went out, so nothing claims it did: the stamp stays empty.
    expect(row.confirmationEmailSentAt).toBeNull();
    expect(mailsTo(c.email)).toHaveLength(0);
  });

  it("an archived client is not contacted", async () => {
    const c = await client();
    await prisma.client.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
    const res = await book({ clientId: c.id, startsAt: at(6, 11) });
    expect(res.status).toBe(201);
    await settleBackgroundWork();
    expect(mailsTo(c.email)).toHaveLength(0);
    expect(pushesTo(c.token)).toHaveLength(0);
  });
});
