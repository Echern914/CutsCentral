import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Bulk client import (CSV migrate-off-Booksy). Covers the behavior that matters:
 * rows become clients; TCPA-CRITICAL consent defaults OFF and is granted ONLY
 * when the barber attests AND the row has a phone; re-import is idempotent
 * (upsert by key, no duplicates), fills only blank fields - never replacing a
 * name, email or note the shop already has - and never re-stamps consent; an invalid phone is
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

  it("re-importing a row keeps the client's own name - fill blanks, never replace", async () => {
    // This case used to assert the OPPOSITE ("Ada" became "Ada Updated"): the
    // re-import overwrote the shop's record while the code comment promised it
    // only filled blanks. The promise is now what happens.
    const res = await imp({
      rows: [{ firstName: "Ada Updated", phone: "(302) 555-0111" }],
      attestConsentForAll: true, // even attesting now must NOT retro-stamp on re-import...
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.updated).toBe(0);
    expect(res.body.unchanged).toBe(1);
    expect(res.body.keptExisting).toBe(1); // the barber is told the names differed

    const ada = await prisma.client.findFirst({ where: { shopId, phone: "+13025550111" } });
    expect(ada?.firstName).toBe("Ada");
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

  it("a repeated import changes nothing and duplicates nothing", async () => {
    const rows = [
      { firstName: "Hana", lastName: "Ito", phone: "(302) 555-0333", email: "hana@example.com", notes: "Low fade" },
      { firstName: "Ivo", email: "IVO@example.com", notes: "Beard trim" },
    ];
    const first = await imp({ rows });
    expect(first.body.created).toBe(2);
    const before = await prisma.client.findMany({
      where: { shopId, firstName: { in: ["Hana", "Ivo"] } },
      orderBy: { firstName: "asc" },
    });

    const again = await imp({ rows });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 2, keptExisting: 0 });
    const after = await prisma.client.findMany({
      where: { shopId, firstName: { in: ["Hana", "Ivo"] } },
      orderBy: { firstName: "asc" },
    });
    expect(after).toHaveLength(2);
    for (const [i, c] of after.entries()) {
      const b = before[i]!;
      expect([c.id, c.firstName, c.lastName, c.email, c.notes]).toEqual([
        b.id,
        b.firstName,
        b.lastName,
        b.email,
        b.notes,
      ]);
    }
  });

  it("keeps the owner's edits and fills only what is still blank", async () => {
    const first = await imp({
      rows: [{ firstName: "Gia", phone: "(302) 555-0444", email: "gia@old.example" }],
    });
    expect(first.body.created).toBe(1);
    const gia = await prisma.client.findFirstOrThrow({ where: { shopId, phone: "+13025550444" } });

    // The barber corrects her through the real screens.
    const edit = await request(app)
      .patch(`/api/dashboard/clients/${gia.id}`)
      .set("Cookie", cookie)
      .send({ firstName: "Giovanna", email: "gia@new.example" });
    expect(edit.status).toBe(200);
    const notes = await request(app)
      .patch(`/api/dashboard/clients/${gia.id}/notes`)
      .set("Cookie", cookie)
      .send({ notes: "VIP - books Fridays" });
    expect(notes.status).toBe(200);

    // The same old export again, now carrying a last name the record lacks.
    const again = await imp({
      rows: [
        {
          firstName: "Gia",
          lastName: "Rossi",
          phone: "(302) 555-0444",
          email: "gia@old.example",
          notes: "Imported note",
        },
      ],
    });
    expect(again.body).toMatchObject({ created: 0, updated: 1, unchanged: 0, keptExisting: 1 });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: gia.id } });
    expect(after.firstName).toBe("Giovanna");
    expect(after.email).toBe("gia@new.example");
    expect(after.notes).toBe("VIP - books Fridays");
    expect(after.lastName).toBe("Rossi"); // the one blank, filled
  });

  it("does not call a differently-cased email a difference", async () => {
    await imp({ rows: [{ firstName: "Jo", phone: "(302) 555-0555", email: "Jo@Example.com" }] });
    const again = await imp({
      rows: [{ firstName: "Jo", phone: "(302) 555-0555", email: "jo@example.com" }],
    });
    expect(again.body).toMatchObject({ unchanged: 1, keptExisting: 0 });
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
