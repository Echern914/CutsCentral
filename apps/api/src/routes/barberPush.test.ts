import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setExpoSenderForTests, type PushPayload } from "../messaging/push.js";
import { createApp } from "../app.js";

/**
 * Barber/manager native push: the iOS dashboard app registers the OWNER's
 * device (user-keyed, unlike the client-keyed customer route), and a new
 * public appointment request fans out to those devices via Expo.
 */
const app = createApp();
const email = `bpush-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
const TOKEN = `ExponentPushToken[test-${randomToken(8)}]`;

const pushes: Array<{ to: string; payload: PushPayload }> = [];

// This suite exercises the push SEND path, so DRY_RUN must be off (the sender
// honors it); the injected fake keeps everything offline. Restored in afterAll.
const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setExpoSenderForTests({
    send: async (to, payload) => {
      pushes.push({ to, payload });
    },
  });

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Push Barber", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Push Cuts", bookingUrl: "https://push.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
});

afterAll(async () => {
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  __setExpoSenderForTests(undefined);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("barber native push", () => {
  it("requires auth to register", async () => {
    const res = await request(app)
      .post("/api/dashboard/push/native")
      .send({ expoPushToken: TOKEN });
    expect(res.status).toBe(401);
  });

  it("registers a USER-keyed device and upserts on re-register", async () => {
    const res = await request(app)
      .post("/api/dashboard/push/native")
      .set("Cookie", cookie)
      .send({ expoPushToken: TOKEN, platform: "ios" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Same device re-registering refreshes rather than duplicating.
    const again = await request(app)
      .post("/api/dashboard/push/native")
      .set("Cookie", cookie)
      .send({ expoPushToken: TOKEN, platform: "ios" });
    expect(again.status).toBe(200);

    const rows = await prisma.pushSubscription.findMany({
      where: { expoPushToken: TOKEN },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("expo");
    expect(rows[0]!.clientId).toBeNull();
    const user = await prisma.user.findUnique({ where: { email } });
    expect(rows[0]!.userId).toBe(user!.id);
  });

  it("rejects a malformed body", async () => {
    const res = await request(app)
      .post("/api/dashboard/push/native")
      .set("Cookie", cookie)
      .send({ nope: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("pushes the owner's devices when a public appointment request arrives", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ takesRequests: true });
    expect(patch.status).toBe(200);

    const res = await request(app)
      .post(`/api/page/${slug}/request`)
      .send({ firstName: "Marcus", phone: "(302) 555-0399" });
    expect(res.status).toBe(201);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.to).toBe(TOKEN);
    expect(pushes[0]!.payload.title).toBe("New appointment request");
    expect(pushes[0]!.payload.body).toContain("Marcus");
    expect(pushes[0]!.payload.url).toContain("/dashboard/requests");
  });
});
