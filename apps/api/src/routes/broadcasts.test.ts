import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { runBroadcastWorker } from "../engines/broadcastWorker.js";
import { unsubscribeTokenFor } from "../engines/unsubscribeToken.js";

/**
 * SENDING ONE MESSAGE TO MANY CLIENTS, END TO END.
 *
 * What these hold down, in the order it would hurt:
 *  - pressing send COMMITS but does not deliver: the audience is frozen, the
 *    response says QUEUED, and a worker that has never seen the request can
 *    finish the job. A restart between those two things is a delay, not a
 *    stranded blast;
 *  - a promotional email carries a WORKING unsubscribe, on a credential that
 *    can do nothing else, and clicking it stops the marketing without stopping
 *    booking confirmations;
 *  - a shop with no postal address cannot send marketing email at all, because
 *    the law requires one in the footer - but can still send notifications;
 *  - nobody is ever mailed twice, however many times send is pressed;
 *  - the barber sees the real audience before he commits, with every exclusion
 *    named, and honest progress afterwards.
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
  suppressed?: boolean;
  shop?: string;
}) {
  return prisma.client.create({
    data: {
      shopId: over.shop ?? shopId,
      acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      magicToken: randomToken(),
      firstName: "Client",
      email: over.email === undefined ? `c${randomToken(6)}@example.com` : over.email,
      emailOptedOut: over.emailOptedOut ?? false,
      optedOut: over.optedOut ?? false,
      loyaltyTier: over.tier === undefined ? "GOLD" : over.tier,
      ...(over.suppressed ? { emailSuppressedAt: new Date(), emailSuppressionReason: "hard_bounce" } : {}),
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
    return { id: `test-${outbox.length}-${randomToken(4)}`, status: "sent" as const };
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

const history = () => request(app).get("/api/broadcasts").set("Cookie", cookie);

/** Compose + commit, the two calls the dashboard makes. */
async function queue(body: {
  channel: "email" | "push";
  tiers?: string[];
  subject: string;
  body: string;
}): Promise<{ id: string; res: request.Response }> {
  const created = await draft(body);
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  return { id, res: await send(id) };
}

describe("the preview, before anything is sent", () => {
  it("counts who will actually get it, and names who won't", async () => {
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "SILVER" });
    await makeClient({ tier: "GOLD", email: null });
    await makeClient({ tier: "GOLD", emailOptedOut: true });
    await makeClient({ tier: "GOLD", archived: true });
    await makeClient({ tier: "GOLD", suppressed: true });

    const res = await preview({ channel: "email", tiers: ["GOLD"] });
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(2);
    expect(res.body.considered).toBe(7);
    const reasons = Object.fromEntries(
      (res.body.skipped as { reason: string; count: number }[]).map((s) => [s.reason, s.count]),
    );
    expect(reasons).toMatchObject({
      not_in_audience: 1,
      no_email: 1,
      unsubscribed: 1,
      archived: 1,
      // 🔴 A BOUNCE IS ITS OWN REASON. Folding it into "unsubscribed" would
      // tell the barber a customer made a choice they never made.
      undeliverable: 1,
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

  it("tells the compose box what fits on this channel", async () => {
    const p = await preview({ channel: "push", tiers: [] });
    expect(p.body.limits).toEqual({ subject: 60, body: 300 });
    const e = await preview({ channel: "email", tiers: [] });
    expect(e.body.limits).toEqual({ subject: 120, body: 4000 });
  });
});

describe("🔴 what the send request actually does", () => {
  it("freezes the audience and answers QUEUED - it does not deliver", async () => {
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "SILVER" });

    const { id, res } = await queue({
      channel: "email",
      tiers: ["GOLD"],
      subject: "Chair open Friday",
      body: "Two spots left this Friday.",
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("QUEUED");
    expect(res.body.recipients).toBe(2);

    // 🔴 NOTHING HAS LEFT. Telling the barber "they'll get it" at this instant
    // would be a claim about the future, not a report about the present.
    expect(outbox).toHaveLength(0);

    const row = await prisma.broadcast.findUnique({ where: { id } });
    expect(row!.status).toBe("QUEUED");
    // The number in the response is a ROW COUNT, not a forecast.
    expect(row!.recipientCount).toBe(2);
    const pending = await prisma.broadcastSend.count({
      where: { broadcastId: id, status: "PENDING" },
    });
    expect(pending).toBe(2);
    // The silver client is on the ledger too, with the reason - frozen now so
    // the report still says why a year from today.
    const skipped = await prisma.broadcastSend.findMany({
      where: { broadcastId: id, status: "SKIPPED" },
      select: { reason: true },
    });
    expect(skipped.map((s) => s.reason)).toEqual(["not_in_audience"]);
  });

  it("🔴 THE API CAN RESTART IMMEDIATELY AFTER THE 202 AND THE BLAST STILL GOES", async () => {
    // The failure this replaces: the route answered 202 and then ran the whole
    // send in a floating promise. A deploy in the following seconds killed it
    // mid-blast, left the row in SENDING, and nothing ever retried or
    // finalised it - while the barber held a receipt saying it was on its way.
    //
    // Nothing below is the request's process. The worker has never seen the
    // HTTP call; all it has is what was committed.
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "GOLD" });
    const { id, res } = await queue({
      channel: "email",
      tiers: [],
      subject: "Still going",
      body: "The request is long gone.",
    });
    expect(res.status).toBe(202);

    const pass = await runBroadcastWorker();
    expect(pass.sent).toBe(2);
    expect(outbox).toHaveLength(2);

    const row = await prisma.broadcast.findUnique({ where: { id } });
    expect(row!.status).toBe("SENT");
    expect(row!.sentCount).toBe(2);
  });

  it("what leaves is lawful to send", async () => {
    await makeClient({ tier: "GOLD" });
    await queue({
      channel: "email",
      tiers: [],
      subject: "Chair open Friday",
      body: "Two spots left this Friday.",
    });
    await runBroadcastWorker();

    // 🔴 Every promotional email must carry a working one-click unsubscribe and
    // the sender's postal address; without both it is not lawful to send, and
    // neither belongs to a "we'll add it later".
    expect(outbox).toHaveLength(1);
    const mail = outbox[0]!;
    expect(mail.stream).toBe("broadcast");
    expect(mail.unsubscribeUrl).toContain("/api/unsubscribe/");
    expect(mail.html).toContain("Unsubscribe");
    expect(mail.html).toContain("12 Main St");
    expect(mail.text).toContain("Unsubscribe:");
    // The shop's name is the From, never a bare "ChairBack" nobody knows.
    expect(mail.fromName).toBe("Blast Cuts");
    expect(mail.html).toContain("Two spots left this Friday.");
    // 🔴 The deterministic provider key is what makes a retry safe.
    expect(mail.idempotencyKey).toMatch(/^broadcast:[^:]+:[^:]+$/);
  });

  it("🔴 escapes what the barber typed - his words go in, his markup does not", async () => {
    await makeClient({ tier: "GOLD" });
    await queue({
      channel: "email",
      tiers: [],
      subject: "Deal",
      body: "<script>alert(1)</script> half off",
    });
    await runBroadcastWorker();
    expect(outbox[0]!.html).not.toContain("<script>");
    expect(outbox[0]!.html).toContain("&lt;script&gt;");
  });

  it("🔴 a second press never mails anybody twice", async () => {
    await makeClient({ tier: "GOLD" });
    const { id, res } = await queue({
      channel: "email",
      tiers: [],
      subject: "Hello",
      body: "Hello there.",
    });
    expect(res.status).toBe(202);
    // The mutex is taken inside the freeze transaction, so the loser is told
    // plainly rather than handed a cheerful receipt for work it is not doing.
    const second = await send(id);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already_sent");

    await runBroadcastWorker();
    await runBroadcastWorker();
    expect(outbox).toHaveLength(1);
    const sends = await prisma.broadcastSend.count({ where: { broadcastId: id } });
    expect(sends).toBe(1);
  });

  it("🔴 two presses in the same instant: one wins, one is refused, one email", async () => {
    await makeClient({ tier: "GOLD" });
    const created = await draft({
      channel: "email",
      tiers: [],
      subject: "Race",
      body: "Both taps land together.",
    });
    const id = created.body.id as string;

    const [a, b] = await Promise.all([send(id), send(id)]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([202, 409]);

    await runBroadcastWorker();
    expect(outbox).toHaveLength(1);
  });

  it("a draft that no longer exists is a 404, not a 409", async () => {
    const res = await send("cl0000000000000000000000");
    expect(res.status).toBe(404);
  });
});

describe("🔴 what fits on the channel", () => {
  it("refuses a 4,000-character push, and says why", async () => {
    const res = await draft({
      channel: "push",
      tiers: [],
      subject: "Long",
      body: "x".repeat(1200),
    });
    expect(res.status).toBe(400);
    // Not "invalid input": the barber needs to know his notification would
    // have been cut off on the phone, and that email is the way to send it.
    expect(String(res.body.message)).toContain("email");
  });

  it("refuses a lock-screen title nobody would read", async () => {
    const res = await draft({
      channel: "push",
      tiers: [],
      subject: "T".repeat(90),
      body: "Short enough.",
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain("lock screen");
  });

  it("the same body is fine as an email", async () => {
    const res = await draft({
      channel: "email",
      tiers: [],
      subject: "Long",
      body: "x".repeat(1200),
    });
    expect(res.status).toBe(201);
  });
});

describe("🔴 the history the barber watches", () => {
  it("shows live progress while it is still going, not zeroes", async () => {
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "GOLD" });
    const { id } = await queue({
      channel: "email",
      tiers: [],
      subject: "Progress",
      body: "Half then half.",
    });

    // One recipient done, one still to go.
    await runBroadcastWorker({ batch: 1 });
    const mid = await history();
    const row = (mid.body.broadcasts as { id: string; status: string; sentCount: number; pendingCount: number }[])
      .find((b) => b.id === id)!;
    // 🔴 The counters ON the broadcast are only written when it FINISHES.
    // Reading those mid-send would show 0 of 2 and look exactly like a feature
    // that had silently stopped - which is how a barber presses send again.
    expect(row.status).toBe("SENDING");
    expect(row.sentCount).toBe(1);
    expect(row.pendingCount).toBe(1);

    await runBroadcastWorker();
    const done = await history();
    const final = (done.body.broadcasts as { id: string; status: string; sentCount: number }[])
      .find((b) => b.id === id)!;
    expect(final.status).toBe("SENT");
    expect(final.sentCount).toBe(2);
  });
});

describe("🔴 unsubscribe", () => {
  /** Queue one email to one client, deliver it, and hand back its real link. */
  async function mailOneAndGetUnsubscribeUrl(): Promise<{ clientId: string; url: string }> {
    const c = await makeClient({ tier: "GOLD" });
    await queue({ channel: "email", tiers: [], subject: "Hi", body: "Hello there." });
    await runBroadcastWorker();
    expect(outbox).toHaveLength(1);
    return { clientId: c.id, url: outbox[0]!.unsubscribeUrl! };
  }

  it("one click stops the marketing, and nothing else", async () => {
    const { clientId, url } = await mailOneAndGetUnsubscribeUrl();

    // The one-click POST that Gmail and Yahoo send, with no session at all.
    const res = await request(app).post(new URL(url).pathname);
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({
      where: { id: clientId },
      select: { emailOptedOut: true, emailOptedOutAt: true, optedOut: true, emailSuppressedAt: true },
    });
    expect(after!.emailOptedOut).toBe(true);
    expect(after!.emailOptedOutAt).not.toBeNull();
    // 🔴 Their TEXT consent is untouched, and so is every transactional email:
    // somebody who does not want promotions has not asked to stop being told
    // when their own appointment is.
    expect(after!.optedOut).toBe(false);
    // And it is recorded as the CHOICE it was, not as a provider suppression.
    expect(after!.emailSuppressedAt).toBeNull();

    // They drop out of the next blast.
    const p = await preview({ channel: "email", tiers: [] });
    expect(p.body.reachable).toBe(0);
  });

  it("🔴 THE UNSUBSCRIBE TOKEN CANNOT OPEN THE REWARDS PAGE", async () => {
    // The whole reason this credential exists. The first cut mailed
    // Client.magicToken - the customer's entire rewards session - to a few
    // thousand people every time a shop ran a promotion.
    const c = await makeClient({ tier: "GOLD" });
    const unsub = unsubscribeTokenFor(c.id);

    const rewards = await request(app).get(`/api/rewards/${encodeURIComponent(unsub)}`);
    expect(rewards.status).toBe(404);
    // The real session key still works, so nothing about rewards was broken to
    // achieve this.
    const real = await request(app).get(`/api/rewards/${c.magicToken}`);
    expect(real.status).toBe(200);
  });

  it("🔴 and the rewards token cannot unsubscribe", async () => {
    // The two credentials are not interchangeable in EITHER direction: if a
    // magic token still worked here, every old link would keep the powerful
    // one alive and the swap would have bought nothing.
    const c = await makeClient({ tier: "GOLD" });
    const res = await request(app).post(`/api/unsubscribe/${c.magicToken}`);
    // Same calm answer as any other token that means nothing here...
    expect(res.status).toBe(200);
    // ...and nothing happened.
    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailOptedOut: true },
    });
    expect(after!.emailOptedOut).toBe(false);
  });

  it("a human clicking the link gets a page that says what happened", async () => {
    const { url } = await mailOneAndGetUnsubscribeUrl();
    const res = await request(app).get(new URL(url).pathname);
    expect(res.status).toBe(200);
    expect(res.text).toContain("unsubscribed");
    // It says the confirmations keep coming, because people worry about that.
    expect(res.text.toLowerCase()).toContain("reminders");
  });

  it("🔴 an unknown token answers exactly like a real one", async () => {
    // Anything else tells whoever is probing which tokens belong to people.
    const { url } = await mailOneAndGetUnsubscribeUrl();
    const a = await request(app).get(new URL(url).pathname);
    const b = await request(app).get(`/api/unsubscribe/${randomToken()}`);
    expect(b.status).toBe(a.status);
    expect(b.text).toBe(a.text);
  });

  it("is idempotent - clicking twice is not an error", async () => {
    const { url } = await mailOneAndGetUnsubscribeUrl();
    const path = new URL(url).pathname;
    expect((await request(app).post(path)).status).toBe(200);
    expect((await request(app).post(path)).status).toBe(200);
  });

  it("🔴 answers calmly even when the write fails", async () => {
    // A 500 from a List-Unsubscribe endpoint is read by mailbox providers as a
    // broken unsubscribe and held against the sending domain - and the human
    // would just click again and see the same wall.
    const { url } = await mailOneAndGetUnsubscribeUrl();
    const path = new URL(url).pathname;
    const original = prisma.client.updateMany;
    (prisma.client as unknown as { updateMany: unknown }).updateMany = async () => {
      throw new Error("database is on fire");
    };
    try {
      const post = await request(app).post(path);
      expect(post.status).toBe(200);
      const get = await request(app).get(path);
      expect(get.status).toBe(200);
      expect(get.text).toContain("unsubscribed");
    } finally {
      (prisma.client as unknown as { updateMany: unknown }).updateMany = original;
    }
  });
});

describe("who may send one", () => {
  it("refuses an anonymous caller", async () => {
    expect((await request(app).post("/api/broadcasts/preview").send({ channel: "email" })).status).toBe(401);
  });

  it("🔴 cannot send another shop's draft, or count its clients", async () => {
    const otherEmail = `bc2-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(otherEmail);
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: otherEmail, password, name: "C", smsAttested: true });
    const otherCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    const otherShop = await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({ name: "Other Cuts", bookingUrl: "https://o.test", smsAttested: true });
    const otherShopId = otherShop.body.id as string;
    shopIds.push(otherShopId);

    // A client in each shop. The draft belongs to ours.
    await makeClient({ tier: "GOLD" });
    await makeClient({ tier: "GOLD", shop: otherShopId });
    const created = await draft({
      channel: "email",
      tiers: [],
      subject: "Ours",
      body: "Only our clients.",
    });
    const id = created.body.id as string;

    // The other shop's owner cannot reach it at all.
    const stolen = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set("Cookie", otherCookie)
      .send({});
    expect(stolen.status).toBe(404);
    expect(
      (await request(app).get("/api/broadcasts").set("Cookie", otherCookie)).body.broadcasts,
    ).toHaveLength(0);

    // And when we send it, only OUR client is frozen into it.
    expect((await send(id)).body.recipients).toBe(1);
    const rows = await prisma.broadcastSend.findMany({
      where: { broadcastId: id },
      select: { shopId: true },
    });
    expect(rows.every((r) => r.shopId === shopId)).toBe(true);
  });
});
