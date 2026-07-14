import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { MessageProvider } from "../messaging/provider.js";

/**
 * The barber AI-receptionist inbox: list conversations, read a transcript, and
 * take over with a manual reply that sends FROM the shop's own number. Covers
 * tenant scoping (a cross-shop id 404s), the opt-out floor, the no-client
 * refusal, and the take-over status flip.
 */
const app = createApp();
const password = "supersecret123";

let sms: { to: string; body: string; from?: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sms.push(input);
    return { sid: `SM${sms.length}`, status: "queued" };
  },
};

const emails: string[] = [];

async function signupAndShop(
  name: string,
  twilioNumber?: string,
): Promise<{ cookie: string; shopId: string }> {
  const email = `inbox-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Inbox Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, bookingUrl: "https://inbox.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const shopId = shop.body.id as string;
  if (twilioNumber) {
    await prisma.shop.update({ where: { id: shopId }, data: { twilioNumber } });
  }
  return { cookie, shopId };
}

async function makeClient(
  shopId: string,
  phone: string,
  opts: { optedOut?: boolean } = {},
): Promise<string> {
  const c = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: phone,
      magicToken: randomToken(),
      firstName: "Pat",
      phone,
      optedOut: opts.optedOut ?? false,
      smsConsentAt: new Date(),
      source: "manual",
    },
    select: { id: true },
  });
  return c.id;
}

async function makeConversation(
  shopId: string,
  phone: string,
  clientId: string | null,
  status = "active",
): Promise<string> {
  const convo = await prisma.receptionistConversation.create({
    data: { shopId, phone, clientId, status },
    select: { id: true },
  });
  await prisma.receptionistMessage.create({
    data: { shopId, conversationId: convo.id, role: "user", content: "you open?" },
  });
  return convo.id;
}

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

beforeAll(() => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
});

afterEach(() => {
  sms = [];
});

afterAll(async () => {
  process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("receptionist inbox", () => {
  it("lists the shop's conversations with names + escalated count, newest first", async () => {
    const { cookie, shopId } = await signupAndShop("List Cuts");
    const phone1 = "+15556660001";
    const c1 = await makeClient(shopId, phone1);
    await makeConversation(shopId, phone1, c1, "escalated");

    const res = await request(app)
      .get("/api/dashboard/receptionist/conversations")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].clientName).toBe("Pat");
    expect(res.body.conversations[0].status).toBe("escalated");
    expect(res.body.escalatedCount).toBe(1);
  });

  it("returns a transcript oldest-first; a cross-shop id 404s", async () => {
    const a = await signupAndShop("Transcript A");
    const b = await signupAndShop("Transcript B");
    const phone = `+15557770001`;
    const cid = await makeClient(a.shopId, phone);
    const convoId = await makeConversation(a.shopId, phone, cid);

    const ok = await request(app)
      .get(`/api/dashboard/receptionist/conversations/${convoId}`)
      .set("Cookie", a.cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.messages[0].role).toBe("user");

    // Shop B cannot read shop A's conversation.
    const cross = await request(app)
      .get(`/api/dashboard/receptionist/conversations/${convoId}`)
      .set("Cookie", b.cookie);
    expect(cross.status).toBe(404);
  });

  it("a manual reply sends FROM the shop's own number and takes over (active -> escalated)", async () => {
    const own = "+15558887777";
    const { cookie, shopId } = await signupAndShop("Reply Cuts", own);
    const phone = "+15559990001";
    const cid = await makeClient(shopId, phone);
    const convoId = await makeConversation(shopId, phone, cid, "active");

    const res = await request(app)
      .post(`/api/dashboard/receptionist/conversations/${convoId}/reply`)
      .set("Cookie", cookie)
      .send({ body: "hey! got you Tue 2pm 👍" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("escalated");

    // Sent from the shop's own line.
    expect(sms).toHaveLength(1);
    expect(sms[0]!.to).toBe(phone);
    expect(sms[0]!.from).toBe(own);

    // Thread taken over; transcript has a system_note + the assistant message.
    const convo = await prisma.receptionistConversation.findUnique({
      where: { id: convoId },
    });
    expect(convo!.status).toBe("escalated");
    const msgs = await prisma.receptionistMessage.findMany({
      where: { conversationId: convoId },
      orderBy: { createdAt: "asc" },
    });
    expect(msgs.map((m) => m.role)).toEqual(["user", "system_note", "assistant"]);
    expect(msgs[2]!.content).toContain("Tue 2pm");
  });

  it("replying to a CLOSED thread reopens it as escalated (AI won't resume blind)", async () => {
    // Regression: a closed thread replied-to used to stay closed, so the
    // client's next text spun up a NEW conversation the AI answered with no
    // awareness of the barber's manual reply. Reply must reopen+take over.
    const { cookie, shopId } = await signupAndShop("Reopen Cuts", "+15558882222");
    const phone = "+15559990005";
    const cid = await makeClient(shopId, phone);
    const convoId = await makeConversation(shopId, phone, cid, "closed");

    const res = await request(app)
      .post(`/api/dashboard/receptionist/conversations/${convoId}/reply`)
      .set("Cookie", cookie)
      .send({ body: "hey, following up — still want Tue?" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("escalated");
    const convo = await prisma.receptionistConversation.findUnique({
      where: { id: convoId },
    });
    expect(convo!.status).toBe("escalated"); // reopened, human in control
  });

  it("refuses to send to an opted-out number (422) and records nothing", async () => {
    const { cookie, shopId } = await signupAndShop("OptOut Cuts", "+15558880000");
    const phone = "+15559990002";
    const cid = await makeClient(shopId, phone, { optedOut: true });
    const convoId = await makeConversation(shopId, phone, cid, "active");

    const res = await request(app)
      .post(`/api/dashboard/receptionist/conversations/${convoId}/reply`)
      .set("Cookie", cookie)
      .send({ body: "you around?" });
    expect(res.status).toBe(422);
    expect(sms).toHaveLength(0);
    // Not taken over, no assistant message appended.
    const convo = await prisma.receptionistConversation.findUnique({
      where: { id: convoId },
    });
    expect(convo!.status).toBe("active");
  });

  it("refuses when the thread has no resolvable client (409)", async () => {
    const { cookie, shopId } = await signupAndShop("NoClient Cuts", "+15558881111");
    const phone = "+15559990003"; // no Client row for this phone
    const convoId = await makeConversation(shopId, phone, null, "active");

    const res = await request(app)
      .post(`/api/dashboard/receptionist/conversations/${convoId}/reply`)
      .set("Cookie", cookie)
      .send({ body: "hello?" });
    expect(res.status).toBe(409);
    expect(sms).toHaveLength(0);
  });

  it("a shop with no own number replies from the shared line (from undefined)", async () => {
    const { cookie, shopId } = await signupAndShop("Shared Cuts"); // no twilioNumber
    const phone = "+15559990004";
    const cid = await makeClient(shopId, phone);
    const convoId = await makeConversation(shopId, phone, cid, "escalated");

    const res = await request(app)
      .post(`/api/dashboard/receptionist/conversations/${convoId}/reply`)
      .set("Cookie", cookie)
      .send({ body: "on my way" });
    expect(res.status).toBe(200);
    expect(sms).toHaveLength(1);
    expect(sms[0]!.from).toBeUndefined(); // provider falls back to the shared number
  });
});
