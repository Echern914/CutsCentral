import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Barber client edit + soft-archive through the HTTP surface. Covers profile
 * edits (name/phone/email, invalid-phone refusal), the archive/unarchive lifecycle,
 * that an archived client drops out of the active list (and the active-set counts)
 * while still being reachable by id and via the explicit "archived" filter, and
 * cross-tenant isolation.
 */
const app = createApp();
const emailA = `cli-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `cli-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;

async function signupAndShop(email: string, shopName: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Client Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://client.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return cookie;
}

async function addClient(cookie: string, firstName: string): Promise<string> {
  const res = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookie)
    .send({ firstName });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Ids on the clients list for a given filter (default = active book). */
async function listIds(cookie: string, filter?: string): Promise<string[]> {
  const qs = filter ? `?filter=${filter}` : "";
  const res = await request(app)
    .get(`/api/dashboard/clients${qs}`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return (res.body.clients as { id: string }[]).map((c) => c.id);
}

beforeAll(async () => {
  cookieA = await signupAndShop(emailA, "Client Cuts A");
  cookieB = await signupAndShop(emailB, "Client Cuts B");
});

afterAll(async () => {
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("client edit routes", () => {
  it("requires auth", async () => {
    const res = await request(app).patch("/api/dashboard/clients/whatever");
    expect(res.status).toBe(401);
  });

  it("404s editing a foreign client (cross-tenant isolation)", async () => {
    const id = await addClient(cookieA, "Foreigner");
    const res = await request(app)
      .patch(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieB)
      .send({ firstName: "Hacked" });
    expect(res.status).toBe(404);
  });

  it("rejects an empty edit body", async () => {
    const id = await addClient(cookieA, "Empty");
    const res = await request(app)
      .patch(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("edits name, phone (normalized to E.164), and email", async () => {
    const id = await addClient(cookieA, "Editable");
    const res = await request(app)
      .patch(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA)
      .send({ firstName: "Edited", lastName: "Name", phone: "302-555-0142", email: "X@Test.com" });
    expect(res.status).toBe(200);
    const detail = await request(app)
      .get(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA);
    expect(detail.body.client.firstName).toBe("Edited");
    expect(detail.body.client.lastName).toBe("Name");
    expect(detail.body.client.phone).toBe("+13025550142");
    expect(detail.body.client.email).toBe("x@test.com"); // lowercased
  });

  it("refuses an unparseable phone (loud, not a silent null)", async () => {
    const id = await addClient(cookieA, "BadPhone");
    const res = await request(app)
      .patch(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA)
      .send({ phone: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_phone");
  });

  it("clears a field with an empty string", async () => {
    const id = await addClient(cookieA, "Clearable");
    await request(app)
      .patch(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA)
      .send({ phone: "302-555-0142", email: "keep@test.com" });
    const cleared = await request(app)
      .patch(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA)
      .send({ phone: "" });
    expect(cleared.status).toBe(200);
    const detail = await request(app)
      .get(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA);
    expect(detail.body.client.phone).toBeNull();
    expect(detail.body.client.email).toBe("keep@test.com"); // untouched
  });

  it("does NOT touch SMS consent on a profile edit", async () => {
    const id = await addClient(cookieA, "Consentless"); // added with no consent
    await request(app)
      .patch(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA)
      .send({ firstName: "StillConsentless" });
    const detail = await request(app)
      .get(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA);
    expect(detail.body.client.smsConsent).toBe(false);
  });
});

describe("client soft-archive", () => {
  it("archives, hiding the client from the active list but keeping it reachable", async () => {
    const id = await addClient(cookieA, "ToArchive");
    expect(await listIds(cookieA)).toContain(id);

    const archived = await request(app)
      .post(`/api/dashboard/clients/${id}/archive`)
      .set("Cookie", cookieA);
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);

    // Gone from the default list and the active filter...
    expect(await listIds(cookieA)).not.toContain(id);
    expect(await listIds(cookieA, "active")).not.toContain(id);
    // ...but present under the explicit archived filter...
    expect(await listIds(cookieA, "archived")).toContain(id);
    // ...and still reachable by id (so it can be inspected + restored).
    const detail = await request(app)
      .get(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA);
    expect(detail.status).toBe(200);
    expect(detail.body.client.archived).toBe(true);
  });

  it("restores an archived client back into the active book", async () => {
    const id = await addClient(cookieA, "ToRestore");
    await request(app).post(`/api/dashboard/clients/${id}/archive`).set("Cookie", cookieA);
    expect(await listIds(cookieA)).not.toContain(id);

    const restored = await request(app)
      .post(`/api/dashboard/clients/${id}/unarchive`)
      .set("Cookie", cookieA);
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);
    expect(await listIds(cookieA)).toContain(id);
  });

  it("404s archiving a foreign client (cross-tenant isolation)", async () => {
    const id = await addClient(cookieA, "ForeignArchive");
    const res = await request(app)
      .post(`/api/dashboard/clients/${id}/archive`)
      .set("Cookie", cookieB);
    expect(res.status).toBe(404);
  });

  it("excludes an archived client from bulk consent attestation", async () => {
    const id = await addClient(cookieA, "BulkArchived");
    await request(app).post(`/api/dashboard/clients/${id}/archive`).set("Cookie", cookieA);
    const res = await request(app)
      .post("/api/dashboard/clients/bulk")
      .set("Cookie", cookieA)
      .send({ action: "attestConsent", clientIds: [id] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0); // archived rows are skipped
    const detail = await request(app)
      .get(`/api/dashboard/clients/${id}`)
      .set("Cookie", cookieA);
    expect(detail.body.client.smsConsent).toBe(false);
  });
});
