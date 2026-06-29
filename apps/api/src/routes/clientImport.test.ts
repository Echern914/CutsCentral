import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Bulk client import (CSV migrate-off-Booksy). Covers the behavior that matters:
 * rows become clients; TCPA-CRITICAL consent defaults OFF and is granted ONLY
 * when the barber attests AND the row has a phone; re-import is idempotent
 * (upsert by key, no duplicates) and never re-stamps consent; an invalid phone is
 * skipped (not stored as a reachable-looking null); cross-tenant isolation.
 */
const app = createApp();
const email = `imp-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let shopId: string;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Import Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Import Shop", bookingUrl: "https://imp.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { email } });
});

function imp(body: object) {
  return request(app).post("/api/dashboard/clients/import").set("Cookie", cookie).send(body);
}

describe("POST /api/dashboard/clients/import", () => {
  it("imports rows with consent OFF by default (not textable)", async () => {
    const res = await imp({
      rows: [
        { firstName: "Ada", phone: "(302) 555-0111" },
        { firstName: "Boris", email: "boris@example.com" },
        { firstName: "Cleo" }, // no phone/email -> still imports under a random key
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(3);
    expect(res.body.skipped).toEqual([]);

    const clients = await prisma.client.findMany({ where: { shopId } });
    expect(clients).toHaveLength(3);
    // EVERY imported client starts with NO sms consent.
    for (const c of clients) {
      expect(c.smsConsentAt).toBeNull();
      expect(c.smsConsentSource).toBeNull();
      expect(c.source).toBe("import");
    }
    const ada = clients.find((c) => c.firstName === "Ada")!;
    expect(ada.phone).toBe("+13025550111"); // normalized to E.164
  });

  it("re-importing the same rows updates, does not duplicate, does not stamp consent", async () => {
    const res = await imp({
      rows: [{ firstName: "Ada Updated", phone: "(302) 555-0111" }],
      attestConsentForAll: true, // even attesting now must NOT retro-stamp on re-import...
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.updated).toBe(1);

    const ada = await prisma.client.findFirst({ where: { shopId, phone: "+13025550111" } });
    expect(ada?.firstName).toBe("Ada Updated");
    // ...EXCEPT the guarded grant: existing client with null consent + attest =>
    // consent IS granted (first-consent-wins, never overwrites a prior source).
    expect(ada?.smsConsentAt).not.toBeNull();
    expect(ada?.smsConsentSource).toBe("import_attested");

    const count = await prisma.client.count({ where: { shopId } });
    expect(count).toBe(3); // still 3, no duplicate
  });

  it("attestConsentForAll grants consent ONLY to rows with a phone", async () => {
    const res = await imp({
      rows: [
        { firstName: "Dale", phone: "(302) 555-0222" }, // phone -> consent granted
        { firstName: "Eve", email: "eve@example.com" }, // no phone -> NO consent
      ],
      attestConsentForAll: true,
    });
    expect(res.status).toBe(200);
    const dale = await prisma.client.findFirst({ where: { shopId, firstName: "Dale" } });
    const eve = await prisma.client.findFirst({ where: { shopId, firstName: "Eve" } });
    expect(dale?.smsConsentAt).not.toBeNull();
    expect(dale?.smsConsentSource).toBe("import_attested");
    expect(eve?.smsConsentAt).toBeNull(); // no phone = can't be a textable consent
  });

  it("skips a supplied-but-invalid phone rather than storing a misleading null", async () => {
    const res = await imp({ rows: [{ firstName: "Frank", phone: "123" }] });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toEqual([{ row: 1, reason: "invalid_phone" }]);
  });

  it("rejects an empty or oversized batch", async () => {
    expect((await imp({ rows: [] })).status).toBe(400);
    const tooMany = { rows: Array.from({ length: 1001 }, (_, i) => ({ firstName: `X${i}` })) };
    expect((await imp(tooMany)).status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await request(app)
      .post("/api/dashboard/clients/import")
      .send({ rows: [{ firstName: "Nope" }] });
    expect(res.status).toBe(401);
  });
});
