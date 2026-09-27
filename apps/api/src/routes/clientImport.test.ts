import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Bulk client import (CSV migrate-off-Booksy). Covers the behavior that matters:
 * rows become clients; TCPA-CRITICAL: an import grants NO SMS consent - not
 * to a new client (a file-wide checkbox is evidence about no one), and never to a
 * client who already exists, whose consent is kept as it is; re-import is
 * idempotent (matched by key, no duplicates); a row that matches an existing
 * client by a shared phone or email but would change or add to it is NEVER
 * written - the client is untouched and the row is skipped with what it
 * matched (a family on one phone is two people); an invalid phone is skipped
 * (not stored as a reachable-looking null); cross-tenant isolation.
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

  it("a row that differs from the client on its phone is skipped - the client is untouched", async () => {
    // This case used to assert that "Ada" BECAME "Ada Updated": the re-import
    // overwrote the shop's record. A shared phone is not proof it is Ada.
    const res = await imp({
      rows: [{ firstName: "Ada Updated", phone: "(302) 555-0111" }],
      attestConsentForAll: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, unchanged: 0 });
    expect(res.body.skipped).toEqual([
      { row: 1, reason: "matches_existing", name: "Ada Updated", matchedBy: "phone", existingName: "Ada" },
    ]);

    const ada = await prisma.client.findFirst({ where: { shopId, phone: "+13025550111" } });
    expect(ada?.firstName).toBe("Ada");
    // Untouched means untouched: not even the attested consent lands on it.
    expect(ada?.smsConsentAt).toBeNull();

    const count = await prisma.client.count({ where: { shopId } });
    expect(count).toBe(3); // still 3, no duplicate
  });

  it("🔴 an attestation over the file never grants consent to a client who already exists", async () => {
    // Every field matches, and it is still no evidence THIS client agreed to texts.
    const res = await imp({ rows: [{ firstName: "Ada", phone: "(302) 555-0111" }], attestConsentForAll: true });
    expect(res.body).toMatchObject({ created: 0, unchanged: 1, skipped: [] });
    const ada = await prisma.client.findFirstOrThrow({ where: { shopId, phone: "+13025550111" } });
    expect(ada.smsConsentAt).toBeNull();
    expect(ada.smsConsentSource).toBeNull();
  });

  it("🔴 an import grants no SMS consent to a new client - not even with the old file-wide flag", async () => {
    // A checkbox over a whole file is evidence about no individual row. The
    // flag is still accepted (an older web build sends it) and ignored.
    const res = await imp({
      rows: [
        { firstName: "Dale", phone: "(302) 555-0222" },
        { firstName: "Eve", email: "eve@example.com" },
      ],
      attestConsentForAll: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    const dale = await prisma.client.findFirstOrThrow({ where: { shopId, firstName: "Dale" } });
    const eve = await prisma.client.findFirstOrThrow({ where: { shopId, firstName: "Eve" } });
    expect([dale.smsConsentAt, dale.smsConsentSource]).toEqual([null, null]);
    expect([eve.smsConsentAt, eve.smsConsentSource]).toEqual([null, null]);
  });

  it("an attesting re-import never re-stamps consent a client already has", async () => {
    const phone = "+13025550233";
    const consentedAt = new Date("2026-02-02T00:00:00Z");
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `tel:${phone}`,
        magicToken: randomToken(),
        firstName: "Joined",
        phone,
        smsConsentAt: consentedAt,
        smsConsentSource: "join_page",
      },
    });
    const res = await imp({ rows: [{ firstName: "Joined", phone }], attestConsentForAll: true });
    expect(res.status).toBe(200);
    const after = await prisma.client.findFirstOrThrow({ where: { shopId, phone } });
    // The customer's own opt-in, when they gave it - not the import's attestation.
    expect(after.smsConsentAt?.toISOString()).toBe(consentedAt.toISOString());
    expect(after.smsConsentSource).toBe("join_page");
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
    expect(again.body).toMatchObject({ created: 0, unchanged: 2, skipped: [] });
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

  it("keeps the owner's edits, and fills nothing - not even a blank", async () => {
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
    expect(again.body).toMatchObject({ created: 0, unchanged: 0 });
    expect(again.body.skipped).toEqual([
      { row: 1, reason: "matches_existing", name: "Gia Rossi", matchedBy: "phone", existingName: "Giovanna" },
    ]);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: gia.id } });
    expect(after.firstName).toBe("Giovanna");
    expect(after.email).toBe("gia@new.example");
    expect(after.notes).toBe("VIP - books Fridays");
    expect(after.lastName).toBeNull(); // a blank is not filled on a shared phone's say-so
  });

  it("a row that would only fill blanks is skipped too - fills are not automatic", async () => {
    await imp({ rows: [{ firstName: "Kai", phone: "(302) 555-0666" }] });
    const again = await imp({
      rows: [{ firstName: "Kai", lastName: "Lee", phone: "(302) 555-0666", notes: "Skin fade, #1 sides" }],
    });
    expect(again.body).toMatchObject({ created: 0, unchanged: 0 });
    expect(again.body.skipped).toHaveLength(1);
    const kai = await prisma.client.findFirstOrThrow({ where: { shopId, phone: "+13025550666" } });
    expect(kai.lastName).toBeNull();
    expect(kai.notes).toBeNull();
  });

  it("🔴 two family members on one phone: the second is never written onto the first", async () => {
    // Same file: Jayden is added; Mason, on the same phone, is held.
    const res = await imp({
      rows: [
        { firstName: "Jayden", lastName: "Park", phone: "(302) 555-0777" },
        { firstName: "Mason", lastName: "Park", phone: "(302) 555-0777", notes: "Buzz cut, #2" },
      ],
      attestConsentForAll: true,
    });
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toEqual([
      { row: 2, reason: "matches_existing", name: "Mason Park", matchedBy: "phone", existingName: "Jayden Park" },
    ]);

    // A later file: Mason again, and a note - still never onto Jayden.
    const later = await imp({
      rows: [{ firstName: "Mason", phone: "302-555-0777", email: "mason.park@example.com", notes: "Buzz cut, #2" }],
    });
    expect(later.body).toMatchObject({ created: 0, unchanged: 0 });
    expect(later.body.skipped).toHaveLength(1);

    const onPhone = await prisma.client.findMany({ where: { shopId, phone: "+13025550777" } });
    expect(onPhone).toHaveLength(1);
    const jayden = onPhone[0]!;
    expect([jayden.firstName, jayden.lastName, jayden.email, jayden.notes]).toEqual(["Jayden", "Park", null, null]);

    // The screen's next step for "someone else": Add client with their OWN
    // contact, not the shared phone. That makes Mason, and leaves Jayden be.
    const added = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: "Mason", lastName: "Park", email: "mason.park@example.com" });
    expect(added.status).toBe(201);
    const mason = await prisma.client.findUniqueOrThrow({ where: { id: added.body.id } });
    expect(mason.id).not.toBe(jayden.id);
    expect(mason.firstName).toBe("Mason");
    const jaydenAfter = await prisma.client.findUniqueOrThrow({ where: { id: jayden.id } });
    expect([jaydenAfter.firstName, jaydenAfter.notes]).toEqual(["Jayden", null]);
  });

  it("a shared email is skipped the same way", async () => {
    await imp({ rows: [{ firstName: "Rae", email: "family@example.com" }] });
    const res = await imp({ rows: [{ firstName: "Sol", email: "Family@Example.com" }] });
    expect(res.body.skipped).toEqual([
      { row: 1, reason: "matches_existing", name: "Sol", matchedBy: "email", existingName: "Rae" },
    ]);
    const rae = await prisma.client.findFirstOrThrow({ where: { shopId, acuityClientKey: "mail:family@example.com" } });
    expect(rae.firstName).toBe("Rae");
  });

  it("does not call a differently-cased email or name a difference", async () => {
    await imp({ rows: [{ firstName: "Jo", phone: "(302) 555-0555", email: "Jo@Example.com" }] });
    const again = await imp({
      rows: [{ firstName: "JO", phone: "(302) 555-0555", email: "jo@example.com" }],
    });
    expect(again.body).toMatchObject({ unchanged: 1, skipped: [] });
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
