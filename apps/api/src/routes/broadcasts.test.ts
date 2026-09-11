import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";

/**
 * SENDING ONE MESSAGE TO MANY CLIENTS, END TO END.
 *
 * What these hold down, in the order it would hurt:
 *  - a promotional email carries a WORKING unsubscribe, and clicking it stops
 *    the marketing without stopping booking confirmations;
 *  - a shop with no postal address cannot send marketing email at all, because
 *    the law requires one in the footer - but can still send notifications;
 *  - nobody is ever mailed twice, however many times send is pressed;
 *  - the barber sees the real audience before he commits, with every exclusion
 *    named.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

let cookie: string;
let shopId: string;

/** Every email the engine tried to send, captured instead of posted. */
let outbox: SendEmailInput[] = [];

async function makeClient(over: {
  tier?: "BRONZE" | "SILVER" | "GOLD" | null;
  email?: string | null;
  emailOptedOut?: boolean;
  archived?: boolean;
  optedOut?: boolean;
}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      magicToken: randomToken(),
      firstName: "Client",
      email: over.email === undefined ? `c${randomToken(6)}@example.com` : over.email,
      emailOptedOut: over.emailOptedOut ?? false,
      optedOut: over.optedOut ?? false,
      loyaltyTier: over.tier === undefined ? "GOLD" : over.tier,
      ...(over.archived ? { archivedAt: new Date() } : {}),
    },
    select: { id: true, magicToken: true },
  });
}

beforeAll(async () => {
  // Capture instead of POSTing. Also makes emailEnabled() true, which is what
  // lets these exercise the email path at all.
  __setSendEmailForTests(async (input) => {
    outbox.push(input);
    return { id: `test-${outbox.length}`, status: "sent" as const };
  });
  const email = `bc-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "B", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Blast Cuts", bookingUrl: "https://b.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  shopIds.push(shopId);
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

beforeEach(async () => {
  outbox = [];
  await prisma.broadcast.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.shop.updateMany({
    where: { id: shopId },
    data: {
      addressStreet: "12 Main St",
      addressCity: "Newark",
      addressRegion: "NJ",
      addressPostal: "07102",
    },
  });
});

const preview = (body: unknown) =>
  request(app).post("/api/broadcasts/preview").set("Cookie", cookie).send(body as object);

const draft = (body: unknown) =>
  request(app).post("/api/broadcasts").set("Cookie", cookie).send(body as object);

const send = (id: string) =>
  request(app).post(`/api/broadcasts/${id}/send`).set("Cookie", cookie).send({});

describe("the preview, before anything is sent", () => {
  it("counts who will actually get it, and names who won't", async () => {
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "SILVER" });
    await makeClient({ tier: "GOLD", email: null });
    await makeClient({ tier: "GOLD", emailOptedOut: true });
    await makeClient({ tier: "GOLD", archived: true });

    const res = await preview({ channel: "email", tiers: ["GOLD"] });
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(2);
    expect(res.body.considered).toBe(6);
    const reasons = Object.fromEntries(
      (res.body.skipped as { reason: string; count: number }[]).map((s) => [s.reason, s.count]),
    );
    expect(reasons).toMatchObject({
      not_in_audience: 1,
      no_email: 1,
      unsubscribed: 1,
      archived: 1,
    });
    // Every exclusion carries a sentence, not a code.
    for (const s of res.body.skipped as { label: string }[]) {
      expect(typeof s.label).toBe("string");
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it("🔴 refuses marketing email from a shop with no street address", async () => {
    // CAN-SPAM requires the sender's postal address in the footer. Sending
    // without one risks the shop and the whole platform's sending reputation.
    await prisma.shop.updateMany({ where: { id: shopId }, data: { addressStreet: null } });
    await makeClient({ tier: "GOLD" });
    const res = await preview({ channel: "email", tiers: [] });
    expect(res.body.blocker.kind).toBe("no_postal_address");
    expect(res.body.blocker.message).toContain("street address");
  });

  it("...but a NOTIFICATION from that same shop is fine - it carries no such duty", async () => {
    await prisma.shop.updateMany({ where: { id: shopId }, data: { addressStreet: null } });
    const c = await makeClient({ tier: "GOLD" });
    await prisma.pushSubscription.create({
      data: { shopId, clientId: c.id, endpoint: `https://push.test/${randomToken(8)}`, kind: "web" },
    });
    const res = await preview({ channel: "push", tiers: [] });
    expect(res.body.blocker).toBeNull();
    expect(res.body.reachable).toBe(1);
  });

  it("says nobody is reachable rather than pretending", async () => {
    await makeClient({ tier: "GOLD", email: null });
    const res = await preview({ channel: "email", tiers: [] });
    expect(res.body.reachable).toBe(0);
    expect(res.body.blocker.kind).toBe("no_recipients");
  });
});

describe("sending", () => {
  it("mails the audience and records every recipient", async () => {
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "SILVER" });

    const created = await draft({
      channel: "email",
      tiers: ["GOLD"],
      subject: "Chair open Friday",
      body: "Two spots left this Friday.",
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const res = await send(id);
    expect(res.status).toBe(202);
    expect(res.body.recipients).toBe(2);

    // The send continues after the response; wait for it to settle.
    for (let i = 0; i < 40; i++) {
      const row = await prisma.broadcast.findUnique({ where: { id }, select: { status: true } });
      if (row?.status === "SENT") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const row = await prisma.broadcast.findUnique({ where: { id } });
    expect(row!.status).toBe("SENT");
    expect(row!.recipientCount).toBe(2);
    // The silver client is on the ledger too, with the reason.
    const skipped = await prisma.broadcastSend.findMany({
      where: { broadcastId: id, status: "SKIPPED" },
      select: { reason: true },
    });
    expect(skipped.map((s) => s.reason)).toEqual(["not_in_audience"]);

    // 🔴 WHAT ACTUALLY LEFT. Every promotional email must carry a working
    // one-click unsubscribe and the sender's postal address; without both it
    // is not lawful to send, and neither belongs to a "we'll add it later".
    expect(outbox).toHaveLength(2);
    for (const mail of outbox) {
      expect(mail.stream).toBe("broadcast");
      expect(mail.unsubscribeUrl).toContain("/api/unsubscribe/");
      expect(mail.html).toContain("Unsubscribe");
      expect(mail.html).toContain("12 Main St");
      expect(mail.text).toContain("Unsubscribe:");
      // The shop's name is the From, never a bare "ChairBack" nobody knows.
      expect(mail.fromName).toBe("Blast Cuts");
      // The barber's words, not his markup.
      expect(mail.html).toContain("Two spots left this Friday.");
    }
  });

  it("🔴 escapes what the barber typed - his words go in, his markup does not", async () => {
    await makeClient({ tier: "GOLD" });
    const created = await draft({
      channel: "email",
      tiers: [],
      subject: "Deal",
      body: "<script>alert(1)</script> half off",
    });
    const id = created.body.id as string;
    await send(id);
    for (let i = 0; i < 40; i++) {
      if (outbox.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(outbox[0]!.html).not.toContain("<script>");
    expect(outbox[0]!.html).toContain("&lt;script&gt;");
  });

  it("🔴 a second press never mails anybody twice", async () => {
    await makeClient({ tier: "GOLD" });
    const created = await draft({
      channel: "email",
      tiers: [],
      subject: "Hello",
      body: "Hello there.",
    });
    const id = created.body.id as string;
    const first = await send(id);
    expect(first.status).toBe(202);
    const second = await send(id);
    expect(second.status).toBe(409);

    for (let i = 0; i < 40; i++) {
      const row = await prisma.broadcast.findUnique({ where: { id }, select: { status: true } });
      if (row?.status === "SENT") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // One row per client, however many times send was pressed.
    const sends = await prisma.broadcastSend.count({
      where: { broadcastId: id, status: { in: ["SENT", "PENDING"] } },
    });
    expect(sends).toBe(1);
  });
});

describe("🔴 unsubscribe", () => {
  it("one click stops the marketing, and nothing else", async () => {
    const c = await makeClient({ tier: "GOLD" });

    // The one-click POST that Gmail and Yahoo send, with no session at all.
    const res = await request(app).post(`/api/unsubscribe/${c.magicToken}`);
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailOptedOut: true, emailOptedOutAt: true, optedOut: true },
    });
    expect(after!.emailOptedOut).toBe(true);
    expect(after!.emailOptedOutAt).not.toBeNull();
    // 🔴 Their TEXT consent is untouched, and so is every transactional email:
    // somebody who does not want promotions has not asked to stop being told
    // when their own appointment is.
    expect(after!.optedOut).toBe(false);

    // And they drop out of the next blast.
    const p = await preview({ channel: "email", tiers: [] });
    expect(p.body.reachable).toBe(0);
  });

  it("a human clicking the link gets a page that says what happened", async () => {
    const c = await makeClient({ tier: "GOLD" });
    const res = await request(app).get(`/api/unsubscribe/${c.magicToken}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("unsubscribed");
    // It says the confirmations keep coming, because people worry about that.
    expect(res.text.toLowerCase()).toContain("reminders");
  });

  it("🔴 an unknown token answers exactly like a real one", async () => {
    // Anything else tells whoever is probing which tokens belong to people.
    const real = await makeClient({ tier: "GOLD" });
    const a = await request(app).get(`/api/unsubscribe/${real.magicToken}`);
    const b = await request(app).get(`/api/unsubscribe/${randomToken()}`);
    expect(b.status).toBe(a.status);
    expect(b.text).toBe(a.text);
  });

  it("is idempotent - clicking twice is not an error", async () => {
    const c = await makeClient({ tier: "GOLD" });
    expect((await request(app).post(`/api/unsubscribe/${c.magicToken}`)).status).toBe(200);
    expect((await request(app).post(`/api/unsubscribe/${c.magicToken}`)).status).toBe(200);
  });
});

describe("who may send one", () => {
  it("refuses an anonymous caller", async () => {
    expect((await request(app).post("/api/broadcasts/preview").send({ channel: "email" })).status).toBe(401);
  });
});
