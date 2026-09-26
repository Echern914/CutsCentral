import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";

/**
 * JOINING A SHOP'S CLIENT LIST, AND THE WAYS IT WENT WRONG - with fixture
 * accounts, end to end through the real routes.
 *
 * Reproduced here, then fixed:
 *   - an owner's Accept that could not add the customer still answered ok and
 *     DELETED the request - the customer was never added and nobody knew;
 *   - a customer whose only match was an ARCHIVED record was told the shop
 *     "already has your number" and then shown nothing to connect: a dead end.
 *
 * And the lines that must not move:
 *   - approval off lets a new customer straight in; approval on waits for the
 *     owner - the shop's own setting, no other control;
 *   - one contact on more than one of the shop's records is never enough to
 *     open either (Omari's case: one verified email, two profiles);
 *   - 🔴 one customer can never be connected to another person's record - not
 *     by joining, not by an owner's Accept, not by pasting someone else's link.
 */
const app = createApp();
const accountIds: string[] = [];
let openShop: { id: string; slug: string };
let vettedShop: { id: string; slug: string };
let vettedCookie: string;
let openCookie: string;

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1626${exch}${line}`;
}
const randomEmail = () => `cjs-${randomToken(8)}@test.local`.toLowerCase();

async function account(opts: { firstName?: string; lastName?: string; phone?: string; email?: string }) {
  const now = new Date();
  const a = await prisma.customerAccount.create({
    data: {
      firstName: opts.firstName ?? null,
      lastName: opts.lastName ?? null,
      phoneE164: opts.phone ?? null,
      phoneVerifiedAt: opts.phone ? now : null,
      emailNormalized: opts.email ?? null,
      emailVerifiedAt: opts.email ? now : null,
    },
    select: { id: true },
  });
  accountIds.push(a.id);
  return { id: a.id, token: mintCustomerSession(a.id, 0) };
}

async function signup() {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: randomEmail(), password: "supersecret123", name: "Owner", smsAttested: true });
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function makeShop(cookie: string, name: string, approveNewClients: boolean) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  await prisma.shop.update({ where: { id: res.body.id }, data: { publicPageEnabled: true, approveNewClients } });
  return { id: res.body.id as string, slug: res.body.slug as string };
}

/** A record the shop already holds, written straight in (an import, a booking). */
async function existingRecord(
  shopId: string,
  opts: { phone?: string; email?: string; firstName: string; archived?: boolean; key?: string },
) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: opts.key ?? `test:${randomToken(10)}`,
      magicToken: randomToken(),
      firstName: opts.firstName,
      phone: opts.phone ?? null,
      email: opts.email ?? null,
      archivedAt: opts.archived ? new Date() : null,
      notes: opts.archived ? "history the new customer must never see" : null,
    },
    select: { id: true, magicToken: true },
  });
}

const join = (token: string, body: Record<string, unknown>) =>
  request(app).post("/api/me/shops/join").set("Authorization", `Bearer ${token}`).send(body);
const claim = (token: string, link: string) =>
  request(app).post("/api/me/profiles/claim").set("Authorization", `Bearer ${token}`).send({ link });
const home = async (token: string) =>
  (await request(app).get("/api/me/home").set("Authorization", `Bearer ${token}`)).body as {
    shops: { handle: string | null }[];
    ambiguous: { name: string }[];
  };
const requests = async (cookie: string) =>
  ((await request(app).get("/api/dashboard/saved-by").set("Cookie", cookie)).body.requests ?? []) as {
    id: string;
    name: string;
  }[];
const accept = (cookie: string, id: string) =>
  request(app).post(`/api/dashboard/saved-by/${id}/accept`).set("Cookie", cookie);

/** The records this account is connected to at a shop. */
const linkedAt = async (accountId: string, shopId: string) =>
  (
    await prisma.customerClientLink.findMany({
      where: { accountId, shopId, status: "active" },
      select: { clientId: true },
    })
  ).map((l) => l.clientId);

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  openCookie = await signup();
  openShop = await makeShop(openCookie, `Open Door ${randomToken(4)}`, false);
  vettedCookie = await signup();
  vettedShop = await makeShop(vettedCookie, `Members Only ${randomToken(4)}`, true);
});

afterAll(async () => {
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: [openShop.id, vettedShop.id] } } });
  await prisma.$disconnect();
});

describe("the shop's own approval setting (approveNewClients)", () => {
  it("OFF: a new customer is a client straight away - one record, connected", async () => {
    const email = randomEmail();
    const me = await account({ email });
    const res = await join(me.token, { handle: openShop.slug, firstName: "Nia", lastName: "New" });
    expect(res.body.status).toBe("joined");
    const records = await prisma.client.findMany({ where: { shopId: openShop.id, email } });
    expect(records).toHaveLength(1);
    expect(await linkedAt(me.id, openShop.id)).toEqual([records[0]!.id]);
  });

  it("ON: the customer waits; the owner's Accept adds them and clears the request", async () => {
    const email = randomEmail();
    const me = await account({ email });
    expect((await join(me.token, { handle: vettedShop.slug, firstName: "Wes", lastName: "Waiting" })).body.status).toBe(
      "pending",
    );
    expect(await linkedAt(me.id, vettedShop.id)).toEqual([]);
    const req = (await requests(vettedCookie)).find((r) => r.name.startsWith("Wes"))!;
    const res = await accept(vettedCookie, req.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("joined");
    expect(await linkedAt(me.id, vettedShop.id)).toHaveLength(1);
    expect((await requests(vettedCookie)).some((r) => r.id === req.id)).toBe(false);
  });
});

describe("one verified contact on TWO of the shop's records (Omari's case)", () => {
  it("joining an open shop opens neither and makes nothing - it needs connecting", async () => {
    const email = randomEmail();
    // An import made two profiles carrying the same email.
    await existingRecord(openShop.id, { email, firstName: "Omari" });
    await existingRecord(openShop.id, { email, firstName: "Omari" });
    const me = await account({ email });
    const res = await join(me.token, { handle: openShop.slug, firstName: "Omari", lastName: "Ahead" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("needs_connecting");
    expect(await linkedAt(me.id, openShop.id)).toEqual([]);
    expect(await prisma.client.count({ where: { shopId: openShop.id, email } })).toBe(2);
    // The app shows the shop under "needs connecting" - the way forward.
    expect((await home(me.token)).ambiguous.length).toBeGreaterThan(0);
  });

  it("once the shop merges the duplicates, the same join connects to the one that is left", async () => {
    const email = randomEmail();
    const keep = await existingRecord(openShop.id, { email, firstName: "Omari" });
    const dupe = await existingRecord(openShop.id, { email, firstName: "Omari" });
    const me = await account({ email });
    expect((await join(me.token, { handle: openShop.slug, firstName: "Omari", lastName: "Ahead" })).body.status).toBe(
      "needs_connecting",
    );
    // A merge archives the loser and re-keys it (services/client.ts).
    await prisma.client.update({
      where: { id: dupe.id },
      data: { archivedAt: new Date(), acuityClientKey: `merged:${dupe.id}` },
    });
    expect((await join(me.token, { handle: openShop.slug, firstName: "Omari", lastName: "Ahead" })).body.status).toBe(
      "joined",
    );
    expect(await linkedAt(me.id, openShop.id)).toEqual([keep.id]);
  });
});

describe("🔴 an owner's Accept never reports a customer it did not add", () => {
  it("their contact is on two records: 409, the request STAYS, nobody is connected, nothing is made", async () => {
    const email = randomEmail();
    await existingRecord(vettedShop.id, { email, firstName: "Dupe" });
    await existingRecord(vettedShop.id, { email, firstName: "Dupe" });
    const me = await account({ email });
    expect((await join(me.token, { handle: vettedShop.slug, firstName: "Dupe", lastName: "Double" })).body.status).toBe(
      "pending",
    );
    const req = (await requests(vettedCookie)).find((r) => r.name.startsWith("Dupe"))!;

    const res = await accept(vettedCookie, req.id);
    // It used to be 200 { ok: true } - and the request was deleted.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("needs_connecting");
    expect((await requests(vettedCookie)).some((r) => r.id === req.id)).toBe(true);
    expect(await linkedAt(me.id, vettedShop.id)).toEqual([]);
    expect(await prisma.client.count({ where: { shopId: vettedShop.id, email } })).toBe(2);
  });
});

describe("🔴 the archived-record dead end", () => {
  it("a customer whose only match is ARCHIVED joins with a fresh record - the archived one keeps its history and audit trail, and is never theirs", async () => {
    const phone = randomPhone();
    // A record under the very key this customer derives to (tel:<phone>)...
    const old = await existingRecord(openShop.id, { phone, firstName: "Old", key: `tel:${phone}` });
    await prisma.client.update({ where: { id: old.id }, data: { notes: "history the new customer must never see" } });
    // ...that absorbed a duplicate through the REAL merge - which moves the
    // duplicate's visit onto it and writes the append-only merge event...
    const dupe = await existingRecord(openShop.id, { phone: randomPhone(), firstName: "Old" });
    const visit = await prisma.visit.create({
      data: {
        shopId: openShop.id,
        clientId: dupe.id,
        acuityAppointmentId: `hist-${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: new Date("2025-03-01T15:00:00Z"),
      },
    });
    const merged = await request(app)
      .post(`/api/dashboard/clients/${old.id}/merge`)
      .set("Cookie", openCookie)
      .send({ loserId: dupe.id, reason: "Same person, second number" });
    expect(merged.status).toBe(200);
    // ...and that the shop later archived.
    await prisma.client.update({ where: { id: old.id }, data: { archivedAt: new Date() } });
    const before = {
      record: await prisma.client.findUniqueOrThrow({ where: { id: old.id } }),
      visit: await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } }),
      events: await prisma.clientMergeEvent.findMany({ where: { survivorClientId: old.id } }),
    };
    expect(before.visit.clientId).toBe(old.id);
    expect(before.events).toHaveLength(1);
    const me = await account({ phone });

    const res = await join(me.token, { handle: openShop.slug, firstName: "Returning", lastName: "Rae" });
    // It used to be needs_connecting - with nothing anywhere to connect.
    expect(res.body.status).toBe("joined");

    const linked = await linkedAt(me.id, openShop.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]).not.toBe(old.id);
    const fresh = await prisma.client.findUniqueOrThrow({ where: { id: linked[0]! } });
    expect(fresh.archivedAt).toBeNull();
    expect(fresh.notes).toBeNull();
    // Their later bookings derive to this key, so they land on the NEW record.
    expect(fresh.acuityClientKey).toBe(`tel:${phone}`);

    // 🔴 The archived record: identical in every field but the key, which now
    // says where it went. Still archived, notes intact, nobody linked to it.
    const after = await prisma.client.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.acuityClientKey).toBe(`archived:${old.id}`);
    expect({ ...after, acuityClientKey: before.record.acuityClientKey, updatedAt: before.record.updatedAt }).toEqual(
      before.record,
    );
    expect(await prisma.customerClientLink.count({ where: { clientId: old.id } })).toBe(0);
    // Its history and audit trail did not move an inch: the visit the merge
    // brought over, and the merge event naming it...
    expect(await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).toEqual(before.visit);
    expect(await prisma.clientMergeEvent.findMany({ where: { survivorClientId: old.id } })).toEqual(before.events);
    // ...and none of it is on the new customer's record.
    expect(await prisma.visit.count({ where: { clientId: fresh.id } })).toBe(0);
    expect(await prisma.clientMergeEvent.count({ where: { survivorClientId: fresh.id } })).toBe(0);
  });

  it("the same at a shop that approves: the request waits, and Accept adds them fresh", async () => {
    const phone = randomPhone();
    const old = await existingRecord(vettedShop.id, { phone, firstName: "Gone", archived: true, key: `tel:${phone}` });
    const me = await account({ phone });
    expect((await join(me.token, { handle: vettedShop.slug, firstName: "Back", lastName: "Again" })).body.status).toBe(
      "pending",
    );
    const req = (await requests(vettedCookie)).find((r) => r.name.startsWith("Back"))!;
    expect((await accept(vettedCookie, req.id)).status).toBe(200);
    const linked = await linkedAt(me.id, vettedShop.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]).not.toBe(old.id);
  });

  it("an erased record never blocks joining either", async () => {
    const phone = randomPhone();
    await existingRecord(openShop.id, { phone, firstName: "Erased", archived: true, key: `deleted:${randomToken(8)}` });
    const me = await account({ phone });
    expect((await join(me.token, { handle: openShop.slug, firstName: "Fresh", lastName: "Start" })).body.status).toBe(
      "joined",
    );
  });
});

describe("🔴 one customer can never be connected to another person's record", () => {
  it("joining with a contact that is on a record ANOTHER account already holds connects nothing", async () => {
    const phone = randomPhone();
    const email = randomEmail();
    const theirs = await existingRecord(openShop.id, { phone, email, firstName: "Holder" });
    // The record's owner connects first, by their phone.
    const holder = await account({ phone });
    expect((await join(holder.token, { handle: openShop.slug, firstName: "Holder", lastName: "One" })).body.status).toBe(
      "joined",
    );
    expect(await linkedAt(holder.id, openShop.id)).toEqual([theirs.id]);

    // Someone else, verified on that record's email, tries to join.
    const other = await account({ email });
    const res = await join(other.token, { handle: openShop.slug, firstName: "Other", lastName: "Person" });
    expect(res.body.status).toBe("needs_connecting");
    // 🔴 The newcomer gets nothing.
    expect(await linkedAt(other.id, openShop.id)).toEqual([]);
    // And the record is now CONTESTED for everyone (identity rule 3: no
    // automatic link while another account has proven a contact on it) -
    // fail-closed, never "whoever signed in first keeps it".
    const held = await prisma.customerClientLink.findFirstOrThrow({ where: { accountId: holder.id, clientId: theirs.id } });
    expect(held.status).toBe("detached");
    expect(held.statusReason).toBe("contested");
    // The way back is the shop's own link to that record - a credential, not a contact.
    expect((await claim(holder.token, `https://getchairback.com/r/${theirs.magicToken}`)).status).toBe(200);
    expect(await linkedAt(holder.id, openShop.id)).toEqual([theirs.id]);
    expect(await linkedAt(other.id, openShop.id)).toEqual([]);
  });

  it("pasting SOMEONE ELSE's personal link opens nothing when none of your verified contacts is on it", async () => {
    const theirs = await existingRecord(openShop.id, { phone: randomPhone(), email: randomEmail(), firstName: "Private" });
    const me = await account({ phone: randomPhone() });
    const res = await claim(me.token, `https://getchairback.com/r/${theirs.magicToken}`);
    expect(res.status).toBe(404);
    expect(await linkedAt(me.id, openShop.id)).toEqual([]);
  });

  it("an owner's Accept cannot connect a customer to a record held by someone else", async () => {
    const phone = randomPhone();
    const email = randomEmail();
    const theirs = await existingRecord(vettedShop.id, { phone, email, firstName: "Keeper" });
    const keeper = await account({ phone });
    // The keeper is already a known client: joined at once, even here.
    expect((await join(keeper.token, { handle: vettedShop.slug, firstName: "Keeper", lastName: "K" })).body.status).toBe(
      "joined",
    );
    const asker = await account({ email });
    expect((await join(asker.token, { handle: vettedShop.slug, firstName: "Asker", lastName: "A" })).body.status).toBe(
      "pending",
    );
    const req = (await requests(vettedCookie)).find((r) => r.name.startsWith("Asker"))!;
    const res = await accept(vettedCookie, req.id);
    // The owner is told it did not happen, and the request stays for them.
    expect(res.status).toBe(409);
    expect((await requests(vettedCookie)).some((r) => r.id === req.id)).toBe(true);
    // 🔴 The asker is not connected to the keeper's record by the owner's click.
    expect(await linkedAt(asker.id, vettedShop.id)).toEqual([]);
    expect(await prisma.client.count({ where: { shopId: vettedShop.id, email } })).toBe(1);
    expect(
      await prisma.customerClientLink.count({ where: { accountId: asker.id, clientId: theirs.id, status: "active" } }),
    ).toBe(0);
  });
});
