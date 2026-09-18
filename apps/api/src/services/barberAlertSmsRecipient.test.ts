import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import request from "supertest";
import { __setMessageProviderForTests, type MessageProvider } from "../messaging/twilio.js";
import { createApp } from "../app.js";
import { sendToBarber } from "./barberNotify.js";

/**
 * WHERE A BARBER ALERT'S SMS ACTUALLY GOES - and where it does NOT.
 *
 * 🔴 THIS FILE EXISTS BECAUSE A SCHEMA COMMENT LIED. `BarberNotifyPref.
 * notifyPhone` was documented as "Where SMS goes. Falls back to
 * Shop.notifyPhone, then the owner's phone." There is no owner-phone fallback,
 * and there cannot be one: the `User` model has no phone column at all. The
 * real chain is exactly two links:
 *
 *     to = BarberNotifyPref.notifyPhone || Shop.notifyPhone
 *
 * A wrong answer here is not cosmetic. It is what you consult before pointing
 * anything at production - "the owner will get a text anyway" is how a
 * verification run texts a real person, and how an operator assumes an alert
 * was delivered when it reached nobody.
 *
 * So the chain is pinned by BEHAVIOUR rather than by a comment, with DRY_RUN
 * off and a fake provider injected, so "no SMS attempt" means the provider was
 * genuinely never called rather than that the kill switch happened to be on.
 */
const sent: { to: string; body: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sent.push({ to: input.to, body: input.body });
    return { sid: `SM${sent.length}`, status: "queued" };
  },
};

// The suite runs with the messaging kill switch ON; this path is only real with
// it off, so it is flipped here and restored in afterAll.
const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

const app = createApp();
let shopId = "";
let ownerId = "";

const message = {
  title: "Double-booked chair",
  body: "A walk-in was recorded over time that was already booked. Nothing was discarded - check the other booking.",
};

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);

  const email = `smsrecip-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Recip", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Recip Cuts", bookingUrl: "https://r.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  ownerId = (
    await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { ownerId: true } })
  ).ownerId;
});

beforeEach(async () => {
  sent.length = 0;
  await prisma.barberNotifyPref.deleteMany({ where: { shopId } });
  await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: null } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  __setMessageProviderForTests(null);
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
});

const alert = () => sendToBarber({ shopId, userId: ownerId, kind: "conflict", message });

describe("the SMS recipient chain is exactly two links", () => {
  it("🔴 NEITHER phone configured => NO SMS attempt at all", async () => {
    // The state a freshly created shop is in - and the state a production
    // verification fixture must be in before anything is allowed to alert.
    // smsEnabled defaults TRUE, so this is not the switch being off: there is
    // simply nowhere to send.
    const res = await alert();
    expect(sent).toHaveLength(0);
    expect(res.texted).toBe(false);
  });

  it("🔴 ...and the owner's account being the only contact changes nothing", async () => {
    // The stale comment's claim, tested directly. The owner exists, has an
    // email and owns the shop - and still no text goes anywhere, because User
    // has no phone column for a fallback to read.
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(Object.keys(owner)).not.toContain("phone");
    expect(await alert()).toMatchObject({ texted: false });
    expect(sent).toHaveLength(0);
  });

  it("CONTROL: Shop.notifyPhone alone DOES get the text", async () => {
    // Without this the test above proves nothing - a send path broken for
    // every shop would also send nothing here.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: "+15551230001" } });
    const res = await alert();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+15551230001");
    expect(res.texted).toBe(true);
  });

  it("the barber's own number WINS over the shop line", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: "+15551230001" } });
    await prisma.barberNotifyPref.create({
      data: { userId: ownerId, shopId, notifyPhone: "+15559990002" },
    });
    await alert();
    expect(sent.map((s) => s.to)).toEqual(["+15559990002"]);
  });

  it("a blank barber number falls through to the shop line, not to nothing", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: "+15551230001" } });
    await prisma.barberNotifyPref.create({
      data: { userId: ownerId, shopId, notifyPhone: "   " },
    });
    await alert();
    expect(sent.map((s) => s.to)).toEqual(["+15551230001"]);
  });

  it("smsEnabled off silences it even with a number", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: "+15551230001" } });
    await prisma.barberNotifyPref.create({
      data: { userId: ownerId, shopId, smsEnabled: false },
    });
    await alert();
    expect(sent).toHaveLength(0);
  });
});
