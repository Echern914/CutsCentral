import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";

/**
 * "Name in their app" - what a barber sees of a customer's own My ChairBack name.
 *
 * The rules under test are the privacy ones, not the display. The name appears
 * only on a record the customer is PROVEN to be, re-derived at the moment it is
 * shown. It never overwrites the shop's own name. And a shared phone, a
 * disowned record or a corrected phone number names nobody.
 */
const app = createApp();
const email = `appname-${randomToken(6)}@test.local`.toLowerCase();
let cookie: string;
let shopId: string;
const accountIds: string[] = [];

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1628${exch}${line}`;
}

async function account(phone: string, firstName: string | null, lastName: string | null) {
  const a = await prisma.customerAccount.create({
    data: { phoneE164: phone, phoneVerifiedAt: new Date(), firstName, lastName },
    select: { id: true },
  });
  accountIds.push(a.id);
  return a.id;
}

async function client(phone: string | null, firstName: string | null = null) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `appname:${randomToken(8)}`,
      magicToken: randomToken(),
      phone,
      firstName,
    },
    select: { id: true },
  });
}

interface DetailClient {
  name: string;
  firstName: string | null;
  appName: string | null;
  nameFromApp: boolean;
}

async function detail(id: string): Promise<DetailClient> {
  const res = await request(app).get(`/api/dashboard/clients/${id}`).set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.client as DetailClient;
}

async function listRow(id: string) {
  const res = await request(app).get("/api/dashboard/clients").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return (res.body.clients as { id: string; name: string; nameFromApp: boolean }[]).find(
    (c) => c.id === id,
  );
}

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "B", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Name Cuts", bookingUrl: "https://n.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
});

afterAll(async () => {
  if (accountIds.length) {
    await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

describe("a customer's own name, on the barber's side", () => {
  it("appears beside the shop's name - and never replaces it", async () => {
    const phone = randomPhone();
    const c = await client(phone, "Jay");
    await account(phone, "Jordan", "Smith");

    const d = await detail(c.id);
    expect(d.name).toBe("Jay");
    expect(d.appName).toBe("Jordan Smith");
    expect(d.nameFromApp).toBe(false);
    // The shop's own record is untouched.
    expect(
      await prisma.client.findUnique({
        where: { id: c.id },
        select: { firstName: true, lastName: true },
      }),
    ).toEqual({ firstName: "Jay", lastName: null });
  });

  it("stands in for a record the shop never named, and says so - detail and list", async () => {
    const phone = randomPhone();
    const c = await client(phone);
    await account(phone, "Maya", "Lee");

    const d = await detail(c.id);
    expect(d.name).toBe("Maya Lee");
    expect(d.nameFromApp).toBe(true);

    const row = await listRow(c.id);
    expect(row?.name).toBe("Maya Lee");
    expect(row?.nameFromApp).toBe(true);
  });

  it("a shared phone names nobody - not the parent, not the child", async () => {
    const phone = randomPhone();
    const parent = await client(phone);
    const child = await client(phone);
    await account(phone, "Sam", "Parent");

    for (const c of [parent, child]) {
      const d = await detail(c.id);
      expect(d.appName).toBeNull();
      expect(d.name).toBe("Unknown");
      expect((await listRow(c.id))?.nameFromApp).toBe(false);
    }
  });

  it("follows the barber correcting a phone number, at the moment it is shown", async () => {
    const phone = randomPhone();
    const c = await client(phone);
    const acct = await account(phone, "Ari", "Before");
    // The customer opens their app first, so the link already exists BEFORE the
    // barber looks. That is what makes this test about re-deriving a link at
    // the moment it is shown, rather than merely creating one.
    const home = await request(app)
      .get("/api/me/home")
      .set("Authorization", `Bearer ${mintCustomerSession(acct, 0)}`);
    expect(home.status).toBe(200);
    expect(
      await prisma.customerClientLink.count({ where: { clientId: c.id, status: "active" } }),
    ).toBe(1);
    expect((await detail(c.id)).appName).toBe("Ari Before");

    // The shop fixes a typo: this record now carries somebody else's number.
    await prisma.client.update({ where: { id: c.id }, data: { phone: randomPhone() } });
    const d = await detail(c.id);
    expect(d.appName).toBeNull();
    expect(d.name).toBe("Unknown");
  });

  it("a record the customer said isn't them never carries their name", async () => {
    const phone = randomPhone();
    const c = await client(phone);
    const acct = await account(phone, "Not", "Mine");
    expect((await detail(c.id)).appName).toBe("Not Mine");

    const link = await prisma.customerClientLink.findFirstOrThrow({
      where: { accountId: acct, clientId: c.id, status: "active" },
      select: { id: true },
    });
    const notMe = await request(app)
      .post(`/api/me/shops/${link.id}/not-me`)
      .set("Authorization", `Bearer ${mintCustomerSession(acct, 0)}`);
    expect(notMe.status).toBe(200);

    expect((await detail(c.id)).appName).toBeNull();
  });

  it("does no work at all while My ChairBack is switched off", async () => {
    const phone = randomPhone();
    const c = await client(phone);
    await account(phone, "Dark", "Switch");
    process.env.CUSTOMER_ACCOUNTS_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      expect((await detail(c.id)).appName).toBeNull();
      // Not even a link was settled behind the switch.
      expect(await prisma.customerClientLink.count({ where: { clientId: c.id } })).toBe(0);
    } finally {
      process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
      __resetEnvCacheForTests();
    }
  });
});
