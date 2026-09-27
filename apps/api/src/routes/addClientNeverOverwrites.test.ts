import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * ADD CLIENT NEVER OVERWRITES ANOTHER CLIENT.
 *
 * The form used to upsert on the client's key (its phone, else its email), so
 * adding a family member with the shared phone replaced the name and notes of
 * the client already on file. Now a phone or email that is already a client's
 * is refused with nothing written, and the owner is told whose it is and the
 * safe way to add someone who shares it.
 */
const app = createApp();
const email = `addc-${randomToken(6)}@test.local`.toLowerCase();
let cookie = "";
let shopId = "";

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Add Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Add Shop", bookingUrl: "https://add.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

const add = (body: object) =>
  request(app).post("/api/dashboard/clients").set("Cookie", cookie).send(body);

describe("Add client", () => {
  it("🔴 refuses a phone that is already a client's - and changes nothing on that client", async () => {
    const jayden = await add({ firstName: "Jayden", lastName: "Park", phone: "(302) 555-0911", notes: "Low fade" });
    expect(jayden.status).toBe(201);
    const before = await prisma.client.count({ where: { shopId } });

    const mason = await add({
      firstName: "Mason",
      lastName: "Park",
      phone: "302-555-0911", // the same number, typed differently
      notes: "Buzz cut",
      smsConsent: true,
    });
    expect(mason.status).toBe(409);
    expect(mason.body.error).toBe("client_exists");
    // Says whose it is, that nothing changed, and never that the shared number
    // could make a separate client.
    expect(mason.body.message).toContain("Jayden Park already has this phone number");
    expect(mason.body.message).toContain("nothing was added or changed");
    expect(mason.body.message).toContain("their own phone or email, or with no contact details");

    const after = await prisma.client.findUniqueOrThrow({ where: { id: jayden.body.id as string } });
    expect([after.firstName, after.lastName, after.notes, after.smsConsentAt]).toEqual([
      "Jayden",
      "Park",
      "Low fade",
      null,
    ]);
    expect(await prisma.client.count({ where: { shopId } })).toBe(before);
  });

  it("the safe path for someone who shares it: their own email, or no contact details, makes a separate client", async () => {
    const own = await add({ firstName: "Mason", lastName: "Park", email: "mason.p@example.com" });
    expect(own.status).toBe(201);
    const none = await add({ firstName: "Lil", lastName: "Park" });
    expect(none.status).toBe(201);
    const parks = await prisma.client.findMany({ where: { shopId, lastName: "Park" }, select: { firstName: true } });
    expect(parks.map((p) => p.firstName).sort()).toEqual(["Jayden", "Lil", "Mason"]);
  });

  it("refuses an email that is already a client's the same way", async () => {
    const res = await add({ firstName: "Someone", email: "MASON.P@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Mason Park already has this email address");
    const mason = await prisma.client.findFirstOrThrow({ where: { shopId, email: "mason.p@example.com" } });
    expect(mason.firstName).toBe("Mason");
  });
});
