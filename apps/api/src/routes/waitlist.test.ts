import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Waitlist: a customer joins from the public page (gated on waitlistEnabled),
 * and the barber lists/works entries from the dashboard. Covers the public-join
 * gate, the create->list roundtrip, status updates, and tenant isolation.
 */
const app = createApp();
const password = "supersecret123";

async function signupAndShop(email: string, shopName: string) {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Waitlist Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://wl.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie, shopId: shop.body.id as string, slug: shop.body.slug as string };
}

async function enableWaitlist(cookie: string) {
  const res = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ waitlistEnabled: true, publicPageEnabled: true });
  expect(res.status).toBe(200);
}

const emails: string[] = [];

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("waitlist", () => {
  it("404s a public join when the shop hasn't enabled the waitlist", async () => {
    const email = `wl-off-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { slug } = await signupAndShop(email, "WL Off Cuts");
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "Nope", phone: "3025550100" });
    expect(res.status).toBe(404);
  });

  it("400s a public join with no phone or email", async () => {
    const email = `wl-bad-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, slug } = await signupAndShop(email, "WL Bad Cuts");
    await enableWaitlist(cookie);
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "NoContact" });
    expect(res.status).toBe(400);
  });

  it("accepts a public join and lists it in the dashboard", async () => {
    const email = `wl-ok-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, slug } = await signupAndShop(email, "WL Ok Cuts");
    await enableWaitlist(cookie);

    const join = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({
        firstName: "Ivan",
        lastName: "Cardona",
        phone: "3025550142",
        preferredTime: "Sat morning",
      });
    expect(join.status).toBe(201);

    const list = await request(app).get("/api/dashboard/waitlist").set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(list.body.waitingCount).toBe(1);
    expect(list.body.waitlist).toHaveLength(1);
    const row = list.body.waitlist[0];
    expect(row.firstName).toBe("Ivan");
    expect(row.lastName).toBe("Cardona");
    expect(row.preferredTime).toBe("Sat morning");
    expect(row.status).toBe("WAITING");
    // Phone stored E.164.
    expect(row.phone).toBe("+13025550142");
  });

  it("updates a waitlist entry's status", async () => {
    const email = `wl-status-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, slug } = await signupAndShop(email, "WL Status Cuts");
    await enableWaitlist(cookie);
    await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "Mel", email: "mel@test.local" });

    const list = await request(app).get("/api/dashboard/waitlist").set("Cookie", cookie);
    const id = list.body.waitlist[0].id as string;

    const upd = await request(app)
      .post(`/api/dashboard/waitlist/${id}`)
      .set("Cookie", cookie)
      .send({ status: "BOOKED" });
    expect(upd.status).toBe(200);

    const after = await request(app).get("/api/dashboard/waitlist").set("Cookie", cookie);
    expect(after.body.waitingCount).toBe(0);
    expect(after.body.waitlist[0].status).toBe("BOOKED");
  });

  it("rejects an invalid status value", async () => {
    const email = `wl-badstatus-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, slug } = await signupAndShop(email, "WL BadStatus Cuts");
    await enableWaitlist(cookie);
    await request(app).post(`/api/page/${slug}/waitlist`).send({ firstName: "X", phone: "3025550111" });
    const list = await request(app).get("/api/dashboard/waitlist").set("Cookie", cookie);
    const id = list.body.waitlist[0].id as string;
    const res = await request(app)
      .post(`/api/dashboard/waitlist/${id}`)
      .set("Cookie", cookie)
      .send({ status: "NONSENSE" });
    expect(res.status).toBe(400);
  });

  it("never lists or mutates another shop's waitlist entries", async () => {
    const emailA = `wl-iso-a-${randomToken(6)}@test.local`.toLowerCase();
    const emailB = `wl-iso-b-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(emailA, emailB);
    const a = await signupAndShop(emailA, "WL Iso A");
    const b = await signupAndShop(emailB, "WL Iso B");
    await enableWaitlist(a.cookie);
    await request(app)
      .post(`/api/page/${a.slug}/waitlist`)
      .send({ firstName: "OnlyA", phone: "3025550199" });

    // Shop B sees zero of shop A's entries.
    const listB = await request(app).get("/api/dashboard/waitlist").set("Cookie", b.cookie);
    expect(listB.status).toBe(200);
    expect(listB.body.waitlist).toHaveLength(0);

    // And can't mutate shop A's entry by id.
    const listA = await request(app).get("/api/dashboard/waitlist").set("Cookie", a.cookie);
    const aId = listA.body.waitlist[0].id as string;
    const cross = await request(app)
      .post(`/api/dashboard/waitlist/${aId}`)
      .set("Cookie", b.cookie)
      .send({ status: "REMOVED" });
    expect(cross.status).toBe(404);
  });
});
