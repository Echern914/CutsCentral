import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { forShop, prisma, type Shop } from "@chairback/db";
import {
  sendPushToClient,
  __setPushSenderForTests,
  __setExpoSenderForTests,
  type PushSender,
  type ExpoSender,
} from "./push.js";

/**
 * Push send service: fan-out to a client's devices across BOTH transports (web
 * VAPID + native Expo), prune dead subscriptions, bump lastSeenAt on success, and
 * record one WEB_PUSH Nudge for audit. Real send via FAKE senders (injected, so
 * they bypass DRY_RUN exactly like the SMS suite's fake provider).
 */

const NOW = new Date("2026-06-01T16:00:00Z");

// A WebPushError-shaped reject: web-push surfaces the HTTP status as statusCode.
class FakePushError extends Error {
  constructor(public statusCode: number) {
    super(`push ${statusCode}`);
  }
}

let calls: { endpoint: string; payload: string }[] = [];
// Per-endpoint behavior the current test wants (default: accept).
let behavior: (endpoint: string) => void = () => {};

const fakeSender: PushSender = {
  async send(sub, payload) {
    calls.push({ endpoint: sub.endpoint, payload });
    behavior(sub.endpoint); // may throw a FakePushError to simulate a reject
  },
};

// Native (Expo) fake sender. Records the token it was asked to send to and runs
// the same per-recipient `expoBehavior` hook so a test can simulate a reject.
let expoCalls: string[] = [];
let expoBehavior: (token: string) => void = () => {};
const fakeExpoSender: ExpoSender = {
  async send(token) {
    expoCalls.push(token);
    expoBehavior(token);
  },
};

let userId: string;

async function makeShop(): Promise<Shop> {
  return prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Push Shop",
      bookingUrl: "https://push.test",
      webhookSecret: randomToken(),
      loyaltyTextsEnabled: true,
    },
  });
}

async function makeClient(shopId: string) {
  const key = `tel:${randomToken(8)}`;
  return forShop(shopId).client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
    create: {
      acuityClientKey: key,
      magicToken: randomToken(),
      firstName: "Pushy",
      // Deliberately NO phone / NO SMS consent: push is its own channel and must
      // work for a client who could never be texted.
    },
    update: {},
  });
}

async function addSub(shopId: string, clientId: string, endpoint: string) {
  return prisma.pushSubscription.create({
    data: {
      shopId,
      clientId,
      endpoint,
      p256dh: "p256dh-key",
      auth: "auth-secret",
    },
  });
}

/** A native (Expo) subscription row for a device. */
async function addExpoSub(shopId: string, clientId: string, token: string) {
  return prisma.pushSubscription.create({
    data: { shopId, clientId, kind: "expo", expoPushToken: token },
  });
}

beforeAll(async () => {
  __setPushSenderForTests(fakeSender);
  __setExpoSenderForTests(fakeExpoSender);
  const user = await prisma.user.create({
    data: { email: `push-${randomToken(6)}@test.local`, passwordHash: "x", name: "P" },
  });
  userId = user.id;
});

beforeEach(() => {
  calls = [];
  behavior = () => {};
  expoCalls = [];
  expoBehavior = () => {};
});

afterEach(async () => {
  await prisma.nudge.deleteMany({ where: { shop: { ownerId: userId } } });
  await prisma.pushSubscription.deleteMany({ where: { shop: { ownerId: userId } } });
});

afterAll(async () => {
  __setPushSenderForTests(undefined);
  __setExpoSenderForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const payload = { title: "T", body: "B", url: "https://app.test/r/x" };

describe("sendPushToClient", () => {
  it("returns empty (no delivery) when the client has no subscriptions", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    const res = await sendPushToClient({ shopId: shop.id, clientId: client.id, payload });
    expect(res).toEqual({ sent: 0, pruned: 0, failed: 0, anyDelivered: false });
    expect(calls.length).toBe(0);
    expect(await prisma.nudge.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it("delivers to every device, bumps lastSeenAt, and logs ONE WEB_PUSH Nudge", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await addSub(shop.id, client.id, "https://push.example/a");
    await addSub(shop.id, client.id, "https://push.example/b");

    const res = await sendPushToClient({
      shopId: shop.id,
      clientId: client.id,
      kind: "loyalty",
      payload,
    });

    expect(res.sent).toBe(2);
    expect(res.anyDelivered).toBe(true);
    expect(calls.length).toBe(2);
    // payload is the JSON the SW renders.
    expect(JSON.parse(calls[0]!.payload)).toMatchObject({ title: "T", body: "B" });

    const nudges = await prisma.nudge.findMany({ where: { shopId: shop.id } });
    expect(nudges.length).toBe(1);
    expect(nudges[0]!.channel).toBe("WEB_PUSH");
    expect(nudges[0]!.kind).toBe("loyalty");
    expect(nudges[0]!.status).toBe("SENT");

    // lastSeenAt refreshed past its creation time on a successful send.
    const subs = await prisma.pushSubscription.findMany({ where: { clientId: client.id } });
    for (const s of subs) expect(s.lastSeenAt.getTime()).toBeGreaterThanOrEqual(s.createdAt.getTime());
  });

  it("PRUNES a subscription the push service reports gone (410)", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await addSub(shop.id, client.id, "https://push.example/dead");
    behavior = () => {
      throw new FakePushError(410);
    };

    const res = await sendPushToClient({ shopId: shop.id, clientId: client.id, payload });

    expect(res).toMatchObject({ sent: 0, pruned: 1, anyDelivered: false });
    expect(await prisma.pushSubscription.count({ where: { clientId: client.id } })).toBe(0);
    // Nothing delivered => no audit Nudge.
    expect(await prisma.nudge.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it("a 404 also prunes (subscription no longer exists)", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await addSub(shop.id, client.id, "https://push.example/gone");
    behavior = () => {
      throw new FakePushError(404);
    };

    const res = await sendPushToClient({ shopId: shop.id, clientId: client.id, payload });
    expect(res.pruned).toBe(1);
    expect(await prisma.pushSubscription.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("a transient error (500) bumps failureCount but KEEPS the subscription", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await addSub(shop.id, client.id, "https://push.example/flaky");
    behavior = () => {
      throw new FakePushError(500);
    };

    const res = await sendPushToClient({ shopId: shop.id, clientId: client.id, payload });
    expect(res).toMatchObject({ sent: 0, failed: 1, pruned: 0, anyDelivered: false });
    const sub = await prisma.pushSubscription.findFirst({ where: { clientId: client.id } });
    expect(sub).not.toBeNull();
    expect(sub!.failureCount).toBe(1);
  });

  it("delivers to the live device even when another is pruned", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await addSub(shop.id, client.id, "https://push.example/live");
    await addSub(shop.id, client.id, "https://push.example/dead");
    behavior = (endpoint) => {
      if (endpoint.endsWith("/dead")) throw new FakePushError(410);
    };

    const res = await sendPushToClient({ shopId: shop.id, clientId: client.id, payload });
    expect(res).toMatchObject({ sent: 1, pruned: 1, anyDelivered: true });
    const remaining = await prisma.pushSubscription.findMany({ where: { clientId: client.id } });
    expect(remaining.map((s) => s.endpoint)).toEqual(["https://push.example/live"]);
  });
});

// Native (Expo) transport: the same fan-out/prune contract as web, routed through
// the Expo sender instead of VAPID. Proves a client reachable ONLY via the app
// (no web subscription) still gets push.
describe("sendPushToClient - native (expo)", () => {
  it("delivers to an expo device and logs a WEB_PUSH Nudge", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await addExpoSub(shop.id, client.id, "ExponentPushToken[abc]");

    const res = await sendPushToClient({
      shopId: shop.id,
      clientId: client.id,
      kind: "loyalty",
      payload,
    });

    expect(res).toMatchObject({ sent: 1, anyDelivered: true });
    expect(expoCalls).toEqual(["ExponentPushToken[abc]"]);
    expect(calls.length).toBe(0); // no web send
    const nudge = await prisma.nudge.findFirst({ where: { shopId: shop.id } });
    expect(nudge?.channel).toBe("WEB_PUSH");
  });

  it("PRUNES an expo device Expo reports as gone (DeviceNotRegistered -> 410)", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await addExpoSub(shop.id, client.id, "ExponentPushToken[dead]");
    expoBehavior = () => {
      throw Object.assign(new Error("DeviceNotRegistered"), { statusCode: 410 });
    };

    const res = await sendPushToClient({ shopId: shop.id, clientId: client.id, payload });
    expect(res).toMatchObject({ sent: 0, pruned: 1, anyDelivered: false });
    expect(await prisma.pushSubscription.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("fans out across BOTH transports for one client", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await addSub(shop.id, client.id, "https://push.example/web");
    await addExpoSub(shop.id, client.id, "ExponentPushToken[app]");

    const res = await sendPushToClient({ shopId: shop.id, clientId: client.id, payload });
    expect(res).toMatchObject({ sent: 2, anyDelivered: true });
    expect(calls.length).toBe(1);
    expect(expoCalls.length).toBe(1);
    // One audit Nudge for the whole delivery, not one per device.
    expect(await prisma.nudge.count({ where: { shopId: shop.id } })).toBe(1);
  });
});
