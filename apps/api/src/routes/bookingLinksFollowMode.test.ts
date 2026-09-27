import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { apiEnv, randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * WHERE "BOOK" SENDS A CUSTOMER, for a shop that booked through Acuity and then
 * started taking bookings in ChairBack - the state its links used to get wrong.
 *
 * Switching modes never clears the saved Acuity link, and several surfaces
 * read that column directly: after the switch the rewards page, the SMS
 * preview and every message kept sending customers back to Acuity. Every one
 * of them now asks the shared rule (config/bookingLinks.ts), and this follows
 * one shop through the switch end to end.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
let cookie = "";
let shopId = "";
let slug = "";
let magicToken = "";

const ACUITY_LINK = "https://links-studio.as.me/schedule.php";
const base = () => apiEnv().APP_BASE_URL.replace(/\/+$/, "");

async function setShop(data: { bookingMode?: string; publicPageEnabled?: boolean }) {
  await prisma.shop.update({
    where: { id: shopId },
    data: data as { bookingMode?: "native" | "acuity" | "link" | "square"; publicPageEnabled?: boolean },
  });
}

const rewards = async () => {
  const res = await request(app).get(`/api/rewards/${magicToken}`);
  expect(res.status).toBe(200);
  return res.body as { shop: { bookingUrl: string | null } };
};

const smsPreview = async () => {
  const res = await request(app).post("/api/shops/me/sms-preview").set("Cookie", cookie).send({});
  expect(res.status).toBe(200);
  return res.body.preview as string;
};

beforeAll(async () => {
  const email = `links-${randomToken(6).toLowerCase()}@test.chairback`;
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Owner", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Links Studio", bookingUrl: ACUITY_LINK, smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  slug = shop.body.slug as string;
  expect(slug).toBeTruthy();
  magicToken = randomToken();
  await prisma.client.create({
    data: { shopId, acuityClientKey: `links-${randomToken(6)}`, magicToken, firstName: "Casey" },
  });
});

afterAll(async () => {
  for (const e of emails) {
    const user = await prisma.user.findUnique({ where: { email: e }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("while the shop books through Acuity", () => {
  it("the rewards page and the SMS preview send customers to the Acuity link", async () => {
    await setShop({ bookingMode: "acuity", publicPageEnabled: true });
    expect((await rewards()).shop.bookingUrl).toBe(ACUITY_LINK);
    expect(await smsPreview()).toContain(ACUITY_LINK);
  });
});

describe("after it starts taking bookings in ChairBack (the Acuity link still saved)", () => {
  it("the rewards page and the SMS preview send customers to its booking page", async () => {
    await setShop({ bookingMode: "native", publicPageEnabled: true });
    try {
      expect((await rewards()).shop.bookingUrl).toBe(`${base()}/book/${slug}`);
      const preview = await smsPreview();
      expect(preview).toContain(`/book/${slug}`);
      expect(preview).not.toContain(ACUITY_LINK);
    } finally {
      await setShop({ bookingMode: "acuity" });
    }
  });

  it("with its page switched off, there is no booking link at all - not the old one", async () => {
    await setShop({ bookingMode: "native", publicPageEnabled: false });
    try {
      expect((await rewards()).shop.bookingUrl).toBeNull();
    } finally {
      await setShop({ bookingMode: "acuity", publicPageEnabled: true });
    }
  });
});

describe('"Book the usual" on the rewards page', () => {
  it("is offered on ChairBack booking, and withdrawn while the page is off", async () => {
    const staff = await prisma.staff.create({ data: { shopId, name: "Dre" } });
    const service = await prisma.service.create({ data: { shopId, name: "Fade", durationMin: 30 } });
    const clientRow = await prisma.client.findFirstOrThrow({ where: { shopId, magicToken } });
    const startsAt = new Date(Date.now() - 20 * 86_400_000);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        clientId: clientRow.id,
        firstName: "Casey",
        status: "COMPLETED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
    });
    const usual = async () =>
      (await request(app).get(`/api/rewards/${magicToken}`)).body.usual as { url: string } | null;

    await setShop({ bookingMode: "native", publicPageEnabled: true });
    try {
      expect((await usual())?.url).toContain(`/book/${slug}?service=`);
      // The booking page refuses a shop whose page is off - so no button to it.
      await setShop({ publicPageEnabled: false });
      expect(await usual()).toBeNull();
    } finally {
      await setShop({ bookingMode: "acuity", publicPageEnabled: true });
    }
  });
});
