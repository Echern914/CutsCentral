import { createHash } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setExpoSenderForTests, sendPushToUser } from "../messaging/push.js";
import { raceBehindBarrier, type HeldBarrier } from "../testing/raceBarrier.js";
import { registerUserDevice } from "./userDevice.js";

/**
 * SIGNING OUT STOPS THE BOOKING ALERTS - on the right phone, for the right
 * person, and a registration racing the sign-out can't put them back.
 *
 * A shared front-desk phone kept showing "new booking" alerts, with clients'
 * names, after the barber signed out in the app. Alerts already sitting in the
 * phone's notification list are the phone's: the server can only stop the
 * NEXT ones, which is what this pins.
 */

const app = createApp();
const emails: string[] = [];
const sent: { to: string; title: string }[] = [];

interface Barber {
  userId: string;
  cookie: string;
  shopId: string;
}

async function barber(name: string): Promise<Barber> {
  const email = `device-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: `${name} Cuts`, smsAttested: true });
  expect(shop.status).toBe(201);
  return { userId: signup.body.id as string, cookie, shopId: shop.body.id as string };
}

const register = (b: { cookie: string }, token: string) =>
  request(app).post("/api/barber/push/native").set("Cookie", b.cookie).send({ expoPushToken: token, platform: "ios" });

const devices = (userId: string) => prisma.pushSubscription.count({ where: { userId } });

/** A shop alert to this barber, through the real send path. */
async function alert(b: Barber, title: string) {
  await sendPushToUser({ userId: b.userId, shopId: b.shopId, payload: { title, body: "Sam Cole, 2:30 PM - Fade", url: "/dashboard" } });
}

beforeAll(() => {
  __setExpoSenderForTests({ send: async (to, payload) => void sent.push({ to, title: payload.title }) });
});

afterEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  __setExpoSenderForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) continue;
    await prisma.pushSubscription.deleteMany({ where: { userId: user.id } });
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

describe("signing out stops the booking alerts", () => {
  it("🔴 account A signs out, account B signs in on the same phone: B never gets A's alerts", async () => {
    const a = await barber("Ash");
    const b = await barber("Bea");
    const phone = `ExponentPushToken[shared-${randomToken(6)}]`;

    expect((await register(a, phone)).status).toBe(200);
    await alert(a, "Ash's shop: new booking");
    expect(sent).toEqual([{ to: phone, title: "Ash's shop: new booking" }]);
    sent.length = 0;

    expect((await request(app).post("/api/auth/logout").set("Cookie", a.cookie)).status).toBe(200);
    // Signed out, before anyone else signs in: A's alerts reach no phone.
    await alert(a, "Ash's shop: cancellation");
    expect(sent).toEqual([]);

    expect((await register(b, phone)).status).toBe(200);
    await alert(a, "Ash's shop: another booking");
    expect(sent).toEqual([]);
    await alert(b, "Bea's shop: new booking");
    expect(sent).toEqual([{ to: phone, title: "Bea's shop: new booking" }]);
    expect(await devices(a.userId)).toBe(0);
  });

  it("🔴 a registration arriving after sign-out, on the old session, is refused and writes nothing", async () => {
    const a = await barber("Cal");
    expect((await request(app).post("/api/auth/logout").set("Cookie", a.cookie)).status).toBe(200);

    const late = await register(a, `ExponentPushToken[late-${randomToken(6)}]`);
    expect(late.status).toBe(401);
    expect(await devices(a.userId)).toBe(0);
    // The engine itself, given the version the dead session carried.
    const version = (await prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).tokenVersion;
    expect(
      await registerUserDevice({
        userId: a.userId,
        sessionVersion: version - 1,
        shopId: a.shopId,
        expoPushToken: `ExponentPushToken[late2-${randomToken(6)}]`,
        platform: "ios",
      }),
    ).toBe(false);
    expect(await devices(a.userId)).toBe(0);
  });

  it("🔴 a registration racing a sign-out waits for it, then refuses - the phone is not put back", async () => {
    const a = await barber("Dee");
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).tokenVersion;

    // The sign-out, mid-flight: version bumped and devices deleted, NOT yet
    // committed. A registration that already passed requireUser (it carries
    // the old version) starts now.
    const signOut = holdUncommittedSignOut(a.userId);
    const barrier = await signOut;
    const { results, settledEarly } = await raceBehindBarrier(barrier, [
      () =>
        registerUserDevice({
          userId: a.userId,
          sessionVersion: before,
          shopId: a.shopId,
          expoPushToken: `ExponentPushToken[race-${randomToken(6)}]`,
          platform: "ios",
        }),
    ]);
    // It really did wait on the sign-out (the user-row lock) ...
    expect(settledEarly).toBe(0);
    // ... and, seeing the bumped version, wrote nothing.
    expect(results[0]).toEqual({ status: "fulfilled", value: false });
    expect(await devices(a.userId)).toBe(0);
  });

  it("the lost-phone button and a password reset drop the devices too", async () => {
    const a = await barber("Eve");
    expect((await register(a, `ExponentPushToken[lost-${randomToken(6)}]`)).status).toBe(200);
    expect((await request(app).post("/api/notifications/sign-out-everywhere").set("Cookie", a.cookie)).status).toBe(200);
    expect(await devices(a.userId)).toBe(0);

    const b = await barber("Fay");
    expect((await register(b, `ExponentPushToken[reset-${randomToken(6)}]`)).status).toBe(200);
    const raw = randomToken(24);
    await prisma.passwordResetToken.create({
      data: {
        userId: b.userId,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const reset = await request(app).post("/api/auth/reset-password").send({ token: raw, newPassword: "anotherpass123" });
    expect(reset.status).toBe(200);
    expect(await devices(b.userId)).toBe(0);
  });

  it("signing in again registers the phone again", async () => {
    const a = await barber("Gus");
    const phone = `ExponentPushToken[again-${randomToken(6)}]`;
    expect((await register(a, phone)).status).toBe(200);
    expect((await request(app).post("/api/auth/logout").set("Cookie", a.cookie)).status).toBe(200);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: emails[emails.length - 1], password: "supersecret123" });
    expect(login.status).toBe(200);
    const fresh = { cookie: (login.headers["set-cookie"] as unknown as string[])[0]! };
    expect((await register(fresh, phone)).status).toBe(200);
    expect(await devices(a.userId)).toBe(1);
  });
});

/**
 * Open the sign-out's own transaction (bump + delete, under the user-row lock)
 * and hold it uncommitted until released - the window a racing registration
 * must not slip through.
 */
async function holdUncommittedSignOut(userId: string): Promise<HeldBarrier> {
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ready = new Promise<void>((r) => (acquired = r));
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL row_security = off");
      await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
      await tx.pushSubscription.deleteMany({ where: { userId } });
      acquired();
      await gate;
    },
    { timeout: 30_000, maxWait: 30_000 },
  );
  await ready;
  return {
    async release() {
      release();
      await held;
    },
  };
}
