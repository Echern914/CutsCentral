import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  __setMessageProviderForTests,
  getMessageProvider,
} from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { createApp } from "../app.js";

/**
 * Public "Request an appointment" lead form + the barber's dashboard inbox.
 * Leads only flow when the barber opts in (takesRequests); they notify by SMS
 * when notifyPhone is set, never fail when the notify send throws, and are
 * strictly tenant-scoped.
 */
const app = createApp();
const emailA = `req-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `req-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let slugA: string;

let sent: SendMessageInput[] = [];

async function signupAndShop(email: string, name: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Req", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, bookingUrl: "https://req.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return cookie;
}

beforeAll(async () => {
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `SM-fake-${sent.length}`, status: "queued" };
    },
  });
  cookieA = await signupAndShop(emailA, "Req Cuts A");
  cookieB = await signupAndShop(emailB, "Req Cuts B");
  const me = await request(app).get("/api/shops/me").set("Cookie", cookieA);
  slugA = me.body.slug;
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("public request submission", () => {
  it("404s when the shop hasn't opted into requests", async () => {
    const res = await request(app)
      .post(`/api/page/${slugA}/request`)
      .send({ firstName: "Lead", phone: "(302) 555-0300" });
    expect(res.status).toBe(404);
  });

  it("404s on an unknown slug", async () => {
    const res = await request(app)
      .post(`/api/page/no-such-shop/request`)
      .send({ firstName: "Lead", phone: "(302) 555-0300" });
    expect(res.status).toBe(404);
  });

  it("accepts a lead once takesRequests is on (no notify phone)", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ takesRequests: true });
    expect(patch.status).toBe(200);

    const res = await request(app)
      .post(`/api/page/${slugA}/request`)
      .send({ firstName: "Marcus", phone: "(302) 555-0301", message: "Fade please" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(sent).toHaveLength(0); // no notifyPhone -> no SMS

    const list = await request(app)
      .get("/api/dashboard/requests")
      .set("Cookie", cookieA);
    expect(list.status).toBe(200);
    const lead = list.body.requests.find((r: { firstName: string }) => r.firstName === "Marcus");
    expect(lead).toBeTruthy();
    expect(lead.status).toBe("NEW");
    expect(lead.phone).toBe("+13025550301"); // normalized
  });

  it("rejects a lead with neither phone nor email", async () => {
    const res = await request(app)
      .post(`/api/page/${slugA}/request`)
      .send({ firstName: "NoContact" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("texts the barber when notifyPhone is set", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ takesRequests: true, notifyPhone: "(302) 555-0999" });
    expect(patch.status).toBe(200);

    const res = await request(app)
      .post(`/api/page/${slugA}/request`)
      .send({ firstName: "Dana", email: "dana@test.local" });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+13025550999");
    expect(sent[0]!.body).toContain("Dana");
  });

  it("still saves the lead when the notify SMS throws", async () => {
    __setMessageProviderForTests({
      channel: "SMS",
      send: async () => {
        throw new Error("twilio down");
      },
    });
    const res = await request(app)
      .post(`/api/page/${slugA}/request`)
      .send({ firstName: "Resilient", phone: "(302) 555-0302" });
    expect(res.status).toBe(201);
    // restore the recording provider for later tests
    __setMessageProviderForTests({
      channel: "SMS",
      send: async (input) => {
        sent.push(input);
        return { sid: `SM-fake-${sent.length}`, status: "queued" };
      },
    });
    const list = await request(app)
      .get("/api/dashboard/requests")
      .set("Cookie", cookieA);
    expect(
      list.body.requests.some((r: { firstName: string }) => r.firstName === "Resilient"),
    ).toBe(true);
  });
});

describe("dashboard request inbox", () => {
  it("rejects an invalid notifyPhone on save", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ notifyPhone: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_phone");
  });

  it("updates a lead's status NEW -> CONTACTED -> CLOSED", async () => {
    const list = await request(app)
      .get("/api/dashboard/requests")
      .set("Cookie", cookieA);
    const id = list.body.requests[0].id as string;

    const contacted = await request(app)
      .post(`/api/dashboard/requests/${id}`)
      .set("Cookie", cookieA)
      .send({ status: "CONTACTED" });
    expect(contacted.status).toBe(200);
    expect(contacted.body.status).toBe("CONTACTED");

    const closed = await request(app)
      .post(`/api/dashboard/requests/${id}`)
      .set("Cookie", cookieA)
      .send({ status: "CLOSED" });
    expect(closed.body.status).toBe("CLOSED");
  });

  it("rejects an unknown status", async () => {
    const list = await request(app)
      .get("/api/dashboard/requests")
      .set("Cookie", cookieA);
    const id = list.body.requests[0].id as string;
    const res = await request(app)
      .post(`/api/dashboard/requests/${id}`)
      .set("Cookie", cookieA)
      .send({ status: "BOGUS" });
    expect(res.status).toBe(400);
  });

  it("another shop cannot see or modify my requests", async () => {
    const listA = await request(app)
      .get("/api/dashboard/requests")
      .set("Cookie", cookieA);
    const id = listA.body.requests[0].id as string;

    // B's inbox is empty (it never enabled requests / got leads).
    const listB = await request(app)
      .get("/api/dashboard/requests")
      .set("Cookie", cookieB);
    expect(listB.body.requests).toHaveLength(0);

    // B cannot update A's lead.
    const res = await request(app)
      .post(`/api/dashboard/requests/${id}`)
      .set("Cookie", cookieB)
      .send({ status: "CLOSED" });
    expect(res.status).toBe(404);
  });
});
