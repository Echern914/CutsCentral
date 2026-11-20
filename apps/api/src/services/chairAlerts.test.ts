import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { __setPushSenderForTests, type PushPayload } from "../messaging/push.js";
import { createApp } from "../app.js";
import { alertRecipients, sendToChair, type AlertAudience } from "./chairAlerts.js";

/**
 * WHO IS TOLD WHEN SOMETHING HAPPENS ON A CHAIR.
 *
 * 🔴 THE BUG THIS EXISTS FOR. Every alert resolved one recipient as
 * `staff.userId ?? ownerId`. Right for a one-person shop, wrong the moment the
 * owner invites a barber: the owner stopped hearing about that chair at all,
 * and a booking REQUEST went only to a login that is not allowed to approve it.
 *
 * The shop here is the shape that breaks it: the owner, a barber with a login
 * (Sam's chair), and chairs nobody has a login for. Everything is
 * driven with DRY_RUN off and fake providers, so "not sent" means the provider
 * was never called rather than that a kill switch happened to be on.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const SHOP_LINE = "+13025550100";
const OWNER_DEVICE = "https://push.test/ar-owner";
const MATE_DEVICE = "https://push.test/ar-mate";

let ownerCookie = "";
let mateCookie = "";
let ownerId = "";
let mateId = "";
let ownerEmail = "";
let mateEmail = "";
let shopId = "";
let samChair = ""; // worked by the mate's login

let texts: { to: string; body: string }[] = [];
let pushes: { endpoint: string; payload: PushPayload }[] = [];
let mail: { to: string; subject: string }[] = [];

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;
const ORIGINAL_SMS = process.env.SMS_ENABLED;

const message = { title: "New booking", body: "Malik Reyes just booked a visit with Sam" };

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return {
    email,
    userId: user.id,
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
  };
}

async function device(userId: string, endpoint: string) {
  await prisma.pushSubscription.create({
    data: { shopId, userId, kind: "web", endpoint, p256dh: "fake-p256dh", auth: "fake-auth" },
  });
}

async function setPref(userId: string, data: Record<string, unknown>) {
  await prisma.barberNotifyPref.upsert({
    where: { userId_shopId: { userId, shopId } },
    create: { shopId, userId, ...data },
    update: data,
  });
}

/** One event on a chair, sent to whoever it is for. */
const send = (chairUserId: string | null, audience: AlertAudience, kind: "newBooking" | "cancel" | "conflict" = "newBooking") =>
  sendToChair({ shopId, ownerId, chairUserId, audience, kind, message });

const who = async (chairUserId: string | null, audience: AlertAudience) =>
  (await alertRecipients({ shopId, ownerId, chairUserId, audience })).map((r) => r.userId);

const devicesHit = () => pushes.map((p) => p.endpoint).sort();

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      texts.push({ to: input.to, body: input.body });
      return { sid: `SM-ar-${texts.length}`, status: "queued" };
    },
  });
  __setPushSenderForTests({
    send: async (sub, payload) => {
      pushes.push({
        endpoint: (sub as { endpoint: string }).endpoint,
        payload: JSON.parse(payload) as PushPayload,
      });
    },
  });
  __setSendEmailForTests(async (input) => {
    mail.push({ to: input.to, subject: input.subject });
    return { id: `em-ar-${mail.length}`, status: "sent" };
  });

  const owner = await signup("ar-owner");
  ownerCookie = owner.cookie;
  ownerId = owner.userId;
  ownerEmail = owner.email;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Recipient Cuts", bookingUrl: "https://ar.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;

  const sam = await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Sam" });
  expect(sam.status).toBe(201);
  samChair = sam.body.id;

  const mate = await signup("ar-mate");
  mateCookie = mate.cookie;
  mateId = mate.userId;
  mateEmail = mate.email;
  await prisma.shopMember.create({
    data: { shopId, userId: mateId, role: "BARBER", staffId: samChair },
  });
  await prisma.staff.update({ where: { id: samChair }, data: { userId: mateId } });

  await device(ownerId, OWNER_DEVICE);
  await device(mateId, MATE_DEVICE);
});

beforeEach(async () => {
  texts = [];
  pushes = [];
  mail = [];
  await prisma.barberNotifyPref.deleteMany({ where: { shopId } });
  await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: null } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  __setSendEmailForTests(undefined);
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  if (ORIGINAL_SMS === undefined) delete process.env.SMS_ENABLED;
  else process.env.SMS_ENABLED = ORIGINAL_SMS;
  __resetEnvCacheForTests();
  await prisma.shop.deleteMany({ where: { id: shopId } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

describe("who an event on a chair is for", () => {
  it("a chair with NO login is the owner's, under every audience", async () => {
    for (const audience of ["chair", "chairAndOwner", "decider"] as const) {
      expect(await who(null, audience)).toEqual([ownerId]);
    }
  });

  it("🔴 a chair the OWNER works has exactly one recipient, never the owner twice", async () => {
    for (const audience of ["chair", "chairAndOwner", "decider"] as const) {
      expect(await who(ownerId, audience)).toEqual([ownerId]);
    }
  });

  it("a barber's chair: the barber alone for 'chair', the barber and the owner otherwise", async () => {
    expect(await who(mateId, "chair")).toEqual([mateId]);
    expect(await who(mateId, "chairAndOwner")).toEqual([mateId, ownerId]);
    // The owner is FIRST on a decision: it is his to make.
    expect(await who(mateId, "decider")).toEqual([ownerId, mateId]);
  });

  it("the owner's switch turns off NEWS of another chair, and nothing else", async () => {
    await setPref(ownerId, { otherChairsEnabled: false });
    expect(await who(mateId, "chairAndOwner")).toEqual([mateId]);
    // 🔴 Still told about anything waiting on him.
    expect(await who(mateId, "decider")).toEqual([ownerId, mateId]);
    // ...and it never silences his own chair or a chair with no login.
    expect(await who(null, "chairAndOwner")).toEqual([ownerId]);
    expect(await who(ownerId, "chairAndOwner")).toEqual([ownerId]);
  });

  it("🔴 the switch is the OWNER'S: a barber's row holding `false` changes nothing", async () => {
    await setPref(mateId, { otherChairsEnabled: false });
    expect(await who(mateId, "chairAndOwner")).toEqual([mateId, ownerId]);
  });
});

describe("push: one copy each, to the right phones", () => {
  it("🔴 a booking on a barber's chair reaches the barber AND the owner, once each", async () => {
    await send(mateId, "chairAndOwner");
    expect(devicesHit()).toEqual([MATE_DEVICE, OWNER_DEVICE].sort());
  });

  it("with the owner's switch off, only the barber is told", async () => {
    await setPref(ownerId, { otherChairsEnabled: false });
    await send(mateId, "chairAndOwner");
    expect(devicesHit()).toEqual([MATE_DEVICE]);
  });

  it("🔴 ...but a REQUEST still reaches the owner, who is the one who can approve it", async () => {
    await setPref(ownerId, { otherChairsEnabled: false });
    await send(mateId, "decider");
    expect(devicesHit()).toEqual([MATE_DEVICE, OWNER_DEVICE].sort());
  });

  it("🔴 the owner's own chair: one push, not two", async () => {
    await send(ownerId, "chairAndOwner");
    expect(devicesHit()).toEqual([OWNER_DEVICE]);
    pushes = [];
    await send(ownerId, "decider");
    expect(devicesHit()).toEqual([OWNER_DEVICE]);
  });

  it("a chair with no login: the owner, as it always was", async () => {
    await send(null, "chairAndOwner");
    expect(devicesHit()).toEqual([OWNER_DEVICE]);
  });

  it("each person's own switches govern their own copy", async () => {
    // The barber muted new bookings; the owner did not. Neither decides for
    // the other.
    await setPref(mateId, { newBookingEnabled: false });
    await send(mateId, "chairAndOwner");
    expect(devicesHit()).toEqual([OWNER_DEVICE]);

    pushes = [];
    await setPref(mateId, { newBookingEnabled: true });
    await setPref(ownerId, { newBookingEnabled: false });
    await send(mateId, "chairAndOwner");
    expect(devicesHit()).toEqual([MATE_DEVICE]);
  });
});

describe("texts: the shop line is the owner's, and one phone gets one text", () => {
  beforeEach(async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: SHOP_LINE } });
  });

  it("a barber with no number of his own is not texted; the owner's copy texts the shop line once", async () => {
    await send(mateId, "chairAndOwner");
    expect(texts.map((t) => t.to)).toEqual([SHOP_LINE]);
  });

  it("🔴 the owner can now STOP the shop line being texted for another barber's chair", async () => {
    // Before: the barber's alert borrowed the shop line, and the owner's own
    // switches were never read - there was no way to turn it off.
    await setPref(ownerId, { otherChairsEnabled: false });
    await send(mateId, "chairAndOwner");
    expect(texts).toHaveLength(0);
  });

  it("a barber with his own number is texted there, and the owner on the shop line", async () => {
    await setPref(mateId, { notifyPhone: "+13025550222" });
    await send(mateId, "chairAndOwner");
    expect(texts.map((t) => t.to).sort()).toEqual([SHOP_LINE, "+13025550222"].sort());
  });

  it("🔴 two people on ONE phone get one text, however the number was typed", async () => {
    // The barber typed the shop's number as his own, in the format a person
    // types rather than the one the shop setting stores.
    await setPref(mateId, { notifyPhone: "(302) 555-0100" });
    await send(mateId, "chairAndOwner");
    expect(texts).toHaveLength(1);
    texts = [];
    await send(mateId, "decider");
    expect(texts).toHaveLength(1);
  });

  it("the owner's own chair texts the shop line once", async () => {
    await send(ownerId, "chairAndOwner");
    expect(texts.map((t) => t.to)).toEqual([SHOP_LINE]);
  });
});

describe("while texting is switched off", () => {
  beforeAll(() => {
    process.env.SMS_ENABLED = "false";
    __resetEnvCacheForTests();
  });
  afterAll(() => {
    process.env.SMS_ENABLED = "true";
    __resetEnvCacheForTests();
  });

  it("🔴 a barber without a number of his own STILL gets the email that stands in for the text", async () => {
    // This is how production runs today, and how a barber without the app has
    // been hearing about his bookings. Narrowing the text fallback to the
    // owner must not have cut him off.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: SHOP_LINE } });
    await send(mateId, "chairAndOwner");
    expect(texts).toHaveLength(0);
    expect(mail.map((m) => m.to).sort()).toEqual([mateEmail, ownerEmail].sort());
  });
});

describe("the settings API", () => {
  it("🔴 a barber cannot write the owner's switch, and nothing is stored", async () => {
    const res = await request(app)
      .put("/api/notifications")
      .set("Cookie", mateCookie)
      .send({ otherChairsEnabled: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
    expect(
      await prisma.barberNotifyPref.findUnique({
        where: { userId_shopId: { userId: mateId, shopId } },
      }),
    ).toBeNull();
  });

  it("...and sending it alongside something he MAY change saves neither", async () => {
    const res = await request(app)
      .put("/api/notifications")
      .set("Cookie", mateCookie)
      .send({ cancelEnabled: false, otherChairsEnabled: false });
    expect(res.status).toBe(403);
    expect(
      await prisma.barberNotifyPref.findUnique({
        where: { userId_shopId: { userId: mateId, shopId } },
      }),
    ).toBeNull();
  });

  it("a barber can still save his own settings", async () => {
    const res = await request(app)
      .put("/api/notifications")
      .set("Cookie", mateCookie)
      .send({ cancelEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.prefs.cancelEnabled).toBe(false);
  });

  it("the owner can turn it off, and it starts ON", async () => {
    const before = await request(app).get("/api/notifications").set("Cookie", ownerCookie);
    expect(before.body.prefs.otherChairsEnabled).toBe(true);
    const res = await request(app)
      .put("/api/notifications")
      .set("Cookie", ownerCookie)
      .send({ otherChairsEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.prefs.otherChairsEnabled).toBe(false);
  });

  it("only an owner with another login on a chair is shown the switch", async () => {
    const owner = await request(app).get("/api/notifications").set("Cookie", ownerCookie);
    expect(owner.body.otherChairsApplies).toBe(true);
    const mate = await request(app).get("/api/notifications").set("Cookie", mateCookie);
    expect(mate.body.otherChairsApplies).toBe(false);

    // Take the login off the chair: nobody else works one, so there is
    // nothing for the switch to change and the settings look as they did.
    await prisma.staff.update({ where: { id: samChair }, data: { userId: null } });
    try {
      const alone = await request(app).get("/api/notifications").set("Cookie", ownerCookie);
      expect(alone.body.otherChairsApplies).toBe(false);
    } finally {
      await prisma.staff.update({ where: { id: samChair }, data: { userId: mateId } });
    }
  });

  it("🔴 only the owner is shown the shop's alert number", async () => {
    // A barber no longer falls back to it, so "blank uses the shop's number"
    // would be a promise of a text that is never sent - and it is the owner's
    // phone number.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: SHOP_LINE } });
    const owner = await request(app).get("/api/notifications").set("Cookie", ownerCookie);
    expect(owner.body.shopNotifyPhone).toBe(SHOP_LINE);
    const mate = await request(app).get("/api/notifications").set("Cookie", mateCookie);
    expect(mate.body.shopNotifyPhone).toBeNull();
  });
});
