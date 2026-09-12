import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { queueBroadcast } from "../engines/broadcast.js";
import { runBroadcastWorker } from "../engines/broadcastWorker.js";

/**
 * ROTATING THE SESSION KEY MUST NOT SILENTLY BREAK EVERY UNSUBSCRIBE LINK.
 *
 * 🔴 THE DEFECT THIS PINS, AND WHY IT WAS INVISIBLE. Unsubscribe tokens used to
 * be derived from SESSION_SECRET. Rotating that key - after a leak, on a
 * schedule, because somebody left - broke nothing at the moment of rotation,
 * which is what made it so dangerous. The stored digest still matched, so
 * yesterday's links kept working and nobody noticed. The links died at each
 * client's NEXT BROADCAST, when the worker re-derived their token under the new
 * key and overwrote the digest - at which point every link already sitting in
 * that customer's inbox stopped matching, with no error anywhere.
 *
 * So the test has to include that second broadcast. Without it, it would pass
 * against the broken implementation too.
 *
 * Nothing here is mocked but the transport: the tokens are minted by the real
 * derivation, carried in the real rendered footer, and redeemed through the
 * real public HTTP route.
 */

/**
 * 🔴 FIXED FILLER BYTES, NEVER A REAL KEY. Fixtures are committed, read in
 * review and copied by whoever wants an example, so they must be obviously
 * unusable rather than merely unused.
 */
const UNSUBSCRIBE_SECRET_A = Buffer.alloc(32, 0xa1).toString("base64");
const UNSUBSCRIBE_SECRET_B = Buffer.alloc(32, 0xb2).toString("base64");
const SESSION_SECRET_BEFORE = "session-secret-before-rotation-0000";
const SESSION_SECRET_AFTER = "session-secret-AFTER-rotation-11111";

let app: Express;
let shopId: string;
let ownerId: string;
let outbox: SendEmailInput[] = [];

const original = {
  session: process.env.SESSION_SECRET,
  unsubscribe: process.env.UNSUBSCRIBE_TOKEN_SECRET,
};

beforeAll(async () => {
  process.env.SESSION_SECRET = SESSION_SECRET_BEFORE;
  process.env.UNSUBSCRIBE_TOKEN_SECRET = UNSUBSCRIBE_SECRET_A;
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  __setSendEmailForTests(async (input) => {
    outbox.push(input);
    return { id: `msg-${randomToken(6)}`, status: "sent" as const };
  });

  // Built directly rather than over HTTP: the barber's session cookie is signed
  // with SESSION_SECRET, and this test rotates it halfway through. The
  // unsubscribe path is public and unaffected, which is the whole point.
  const user = await prisma.user.create({
    data: { email: `rot-${randomToken(6)}@test.local`, passwordHash: "x", name: "R" },
    select: { id: true },
  });
  ownerId = user.id;
  const shop = await prisma.shop.create({
    data: {
      name: "Rotation Cuts",
      ownerId,
      slug: `rotation-cuts-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      bookingUrl: "https://r.test",
      webhookSecret: randomToken(16),
      addressStreet: "8 Rotation Way",
      addressCity: "Newark",
      addressRegion: "NJ",
      addressPostal: "07102",
    },
    select: { id: true },
  });
  shopId = shop.id;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  if (original.session === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = original.session;
  if (original.unsubscribe === undefined) delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
  else process.env.UNSUBSCRIBE_TOKEN_SECRET = original.unsubscribe;
  __resetEnvCacheForTests();
});

async function makeClient(): Promise<{ id: string }> {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      magicToken: randomToken(),
      firstName: "Client",
      email: `c${randomToken(6)}@example.com`,
      loyaltyTier: "GOLD",
    },
    select: { id: true },
  });
}

/**
 * Actually send a blast, and hand back the link IT carried to THIS person.
 *
 * The recipient is matched by address rather than by taking the first mail in
 * the outbox: a worker pass drains every due row it can see, across shops, so
 * "the first email" is not reliably this one.
 */
async function sendBlastAndCaptureLink(clientId: string): Promise<string> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { email: true },
  });
  outbox = [];
  const b = await prisma.broadcast.create({
    data: {
      shopId,
      createdByUserId: ownerId,
      channel: "email",
      audienceTiers: [],
      subject: "Friday",
      body: "Two spots open.",
      status: "DRAFT",
    },
    select: { id: true },
  });
  const queued = await queueBroadcast({ shopId, broadcastId: b.id });
  expect(queued.ok, JSON.stringify(queued)).toBe(true);
  await runBroadcastWorker();
  const mail = outbox.find((m) => m.to === client!.email && m.unsubscribeUrl);
  expect(mail, "the blast carried no unsubscribe link to this client").toBeDefined();
  return new URL(mail!.unsubscribeUrl!).pathname;
}

const optedOut = async (clientId: string): Promise<boolean> =>
  (await prisma.client.findUnique({ where: { id: clientId }, select: { emailOptedOut: true } }))!
    .emailOptedOut;

function rotate(vars: { session?: string; unsubscribe?: string }): void {
  if (vars.session) process.env.SESSION_SECRET = vars.session;
  if (vars.unsubscribe) process.env.UNSUBSCRIBE_TOKEN_SECRET = vars.unsubscribe;
  __resetEnvCacheForTests();
}

describe("🔴 rotating SESSION_SECRET", () => {
  it("leaves an unsubscribe link in an already-sent email working", async () => {
    const client = await makeClient();
    const link = await sendBlastAndCaptureLink(client.id);

    // The rotation itself.
    rotate({ session: SESSION_SECRET_AFTER });

    // 🔴 AND THE SECOND BROADCAST, which is where the old bug actually bit.
    // The worker re-derives this client's token and writes their digest; under
    // the old scheme that digest was now a function of the NEW session key, so
    // the link already in their inbox stopped matching. Without this step the
    // test would pass against the broken implementation.
    const linkAfter = await sendBlastAndCaptureLink(client.id);
    expect(linkAfter).toBe(link);

    // The link from the FIRST email, redeemed through the real public route.
    const res = await request(app).post(link);
    expect(res.status).toBe(200);
    expect(await optedOut(client.id)).toBe(true);
  });

  it("and a link sent before the rotation still works even with no send in between", async () => {
    const client = await makeClient();
    const link = await sendBlastAndCaptureLink(client.id);
    rotate({ session: `${SESSION_SECRET_AFTER}-again` });

    const res = await request(app).get(link);
    expect(res.status).toBe(200);
    expect(res.text).toContain("unsubscribed");
    expect(await optedOut(client.id)).toBe(true);
  });
});

describe("🔴 rotating UNSUBSCRIBE_TOKEN_SECRET", () => {
  it("MAY invalidate outstanding links - it is the one key that should", async () => {
    const client = await makeClient();
    const oldLink = await sendBlastAndCaptureLink(client.id);

    rotate({ unsubscribe: UNSUBSCRIBE_SECRET_B });
    // The next broadcast re-derives and overwrites the stored digest.
    const newLink = await sendBlastAndCaptureLink(client.id);
    expect(newLink).not.toBe(oldLink);

    // The old link still answers 200 - every token does, real or invented, so
    // that a failing lookup cannot be used to tell them apart - but it no
    // longer means anything.
    expect((await request(app).post(oldLink)).status).toBe(200);
    expect(await optedOut(client.id)).toBe(false);

    // The link from the message actually sent under the new key does work.
    expect((await request(app).post(newLink)).status).toBe(200);
    expect(await optedOut(client.id)).toBe(true);
  });

  it("the derivation really does depend on the key, not on the client alone", async () => {
    // Belt for the two tests above: if the token ignored the secret entirely,
    // both would pass for the wrong reason.
    const client = await makeClient();
    rotate({ unsubscribe: UNSUBSCRIBE_SECRET_A });
    const underA = await sendBlastAndCaptureLink(client.id);
    rotate({ unsubscribe: UNSUBSCRIBE_SECRET_B });
    const underB = await sendBlastAndCaptureLink(client.id);
    expect(underA).not.toBe(underB);

    // ...and the session key is genuinely not an input to it.
    rotate({ unsubscribe: UNSUBSCRIBE_SECRET_A, session: "a-completely-different-session-key" });
    expect(await sendBlastAndCaptureLink(client.id)).toBe(underA);
  });
});
