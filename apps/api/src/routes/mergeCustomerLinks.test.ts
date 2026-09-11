import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { __setMergeFaultForTests } from "../services/client.js";

/**
 * WHAT A MERGE DOES TO THE CUSTOMER'S OWN APP.
 *
 * A shop merging two duplicate records moves one person's whole history onto
 * the other record. My ChairBack links point at records, so unless the merge
 * settles them in the same breath, the customer opens an app pointing at an
 * archived profile whose visits are now somewhere else - or, worse, the wrong
 * account keeps the combined history.
 *
 * This suite is the case matrix the merge has to answer, driven through the
 * real dashboard route with a real customer session reading the result.
 */

const app = createApp();
let ownerId: string;
let shopId: string;
let cookie: string;
const accountIds = new Set<string>();

const password = "supersecret123";

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  return `+1630${exch}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
}
const randomEmail = (tag: string) => `${tag}-${randomToken(6)}@merge.test`.toLowerCase();

async function account(opts: { phone?: string; email?: string }) {
  const now = new Date();
  const acct = await prisma.customerAccount.create({
    data: {
      phoneE164: opts.phone ?? null,
      phoneVerifiedAt: opts.phone ? now : null,
      emailNormalized: opts.email ?? null,
      emailVerifiedAt: opts.email ? now : null,
    },
  });
  accountIds.add(acct.id);
  return { id: acct.id, token: mintCustomerSession(acct.id, 0) };
}

async function client(over: { phone?: string | null; email?: string | null; firstName?: string }) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `mg:${randomToken(8)}`,
      firstName: over.firstName ?? "Jordan",
      phone: over.phone ?? null,
      email: over.email ?? null,
      magicToken: randomToken(),
    },
    select: { id: true, magicToken: true },
  });
}

async function visitFor(clientId: string) {
  return prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `manual:${randomToken(6)}`,
      status: "COMPLETED",
      scheduledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      serviceName: "Fade",
    },
    select: { id: true },
  });
}

const merge = (winnerId: string, loserId: string, body: object = {}) =>
  request(app)
    .post(`/api/dashboard/clients/${winnerId}/merge`)
    .set("Cookie", cookie)
    .send({ loserId, ...body });

const homeOf = async (token: string) =>
  (await request(app).get("/api/me/home").set("Authorization", `Bearer ${token}`)).body;

const linksOf = (accountId: string) =>
  prisma.customerClientLink.findMany({ where: { accountId }, orderBy: { linkedAt: "asc" } });

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  const email = `mgowner-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Merge Owner", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Merge Links", bookingUrl: "https://ml.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  ownerId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
});

afterEach(() => {
  __setMergeFaultForTests(null);
});

afterAll(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  if (accountIds.size > 0) {
    await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  }
  if (ownerId) {
    await prisma.shop.deleteMany({ where: { ownerId } });
    await prisma.user.delete({ where: { id: ownerId } });
  }
  await prisma.$disconnect();
});

describe("the account that held one half", () => {
  it("🔴 follows the history onto the surviving record, immediately", async () => {
    // The customer's app is linked to the record that is about to be merged
    // AWAY (their email one); the shop keeps the phone one.
    const email = randomEmail("carry");
    const keep = await client({ phone: randomPhone(), firstName: "Keeper" });
    const dupe = await client({ email, firstName: "Dupe" });
    await visitFor(dupe.id);
    const me = await account({ email });

    const before = await homeOf(me.token);
    expect(before.shops).toHaveLength(1);

    expect((await merge(keep.id, dupe.id)).status).toBe(200);

    // The link now points at the survivor - settled by the merge itself, not
    // repaired by this read.
    const links = await linksOf(me.id);
    expect(links.find((l) => l.clientId === dupe.id)!.status).toBe("detached");
    const onKeeper = links.find((l) => l.clientId === keep.id)!;
    expect(onKeeper.status).toBe("active");

    // ...and the moved visit is right there.
    const after = await homeOf(me.token);
    expect(after.shops).toHaveLength(1);
    const past = (
      await request(app).get("/api/me/appointments").set("Authorization", `Bearer ${me.token}`)
    ).body.past;
    expect(past.some((p: { serviceName: string }) => p.serviceName === "Fade")).toBe(true);
  });

  it("keeps one link when the same account held both halves", async () => {
    const phone = randomPhone();
    const email = randomEmail("both");
    const keep = await client({ phone });
    const dupe = await client({ email });
    const me = await account({ phone, email });
    expect((await homeOf(me.token)).shops).toHaveLength(1);
    expect((await linksOf(me.id)).filter((l) => l.status === "active")).toHaveLength(2);

    expect((await merge(keep.id, dupe.id)).status).toBe(200);
    const links = await linksOf(me.id);
    expect(links.filter((l) => l.status === "active").map((l) => l.clientId)).toEqual([keep.id]);
    expect((await homeOf(me.token)).shops).toHaveLength(1);
  });

  it("carries a CLAIMED half as a claim, re-bound to the survivor's own link", async () => {
    // Three records on one phone - a household - so nothing links on the
    // contact alone, before or after the merge. The customer has connected the
    // record the shop is about to merge away.
    const phone = randomPhone();
    const keep = await client({ phone, firstName: "Keeper" });
    const dupe = await client({ phone, firstName: "Dupe" });
    await client({ phone, firstName: "Housemate" });
    const me = await account({ phone });
    await request(app)
      .post("/api/me/profiles/claim")
      .set("Authorization", `Bearer ${me.token}`)
      .send({ link: dupe.magicToken })
      .expect(200);

    expect((await merge(keep.id, dupe.id)).status).toBe(200);
    const onKeeper = (await linksOf(me.id)).find((l) => l.clientId === keep.id)!;
    expect(onKeeper.status).toBe("active");
    expect(onKeeper.matchedBy).toBe("claim");
    expect((await homeOf(me.token)).shops).toHaveLength(1);

    // 🔴 Bound to the SURVIVOR's own credential, not the one it was claimed
    // with: rotating the shop's link revokes it, and the shared phone cannot
    // put it back.
    await prisma.client.update({ where: { id: keep.id }, data: { magicToken: randomToken() } });
    expect((await homeOf(me.token)).shops).toEqual([]);
    const revoked = (await linksOf(me.id)).find((l) => l.clientId === keep.id)!;
    expect(revoked.status).toBe("detached");
    expect(revoked.statusReason).toBe("credential_rotated");
  });
});

describe("two accounts, one merged record", () => {
  it("🔴 when the survivor ends up carrying both people's contacts, NEITHER keeps it", async () => {
    // Each account holds one half by its own proven contact. The survivor has
    // no email of its own, so the merge fills it from the record being folded
    // in - and the combined record now carries two different people's proven
    // contacts, which is the definition of contested.
    const phoneA = randomPhone();
    const emailB = randomEmail("second");
    const keep = await client({ phone: phoneA, firstName: "Keeper" });
    const dupe = await client({ email: emailB, firstName: "Dupe" });
    const first = await account({ phone: phoneA });
    const second = await account({ email: emailB });
    expect((await homeOf(first.token)).shops).toHaveLength(1);
    expect((await homeOf(second.token)).shops).toHaveLength(1);

    expect((await merge(keep.id, dupe.id)).status).toBe(200);

    expect(await prisma.customerClientLink.count({ where: { clientId: keep.id, status: "active" } })).toBe(0);
    const firstHome = await homeOf(first.token);
    const secondHome = await homeOf(second.token);
    expect(firstHome.shops).toEqual([]);
    expect(secondHome.shops).toEqual([]);
    // Both are told there is something to connect, with the shop's link.
    expect(firstHome.ambiguous).toHaveLength(1);
    expect(secondHome.ambiguous).toHaveLength(1);
  });

  it("🔴 at most ONE account ever holds the combined record", async () => {
    // Here the survivor already has both contact fields of its own, so the
    // merge copies nothing: afterwards the combined record carries only the
    // first account's number. The shop has said these are one person, so the
    // ordinary rule applies to the one record that remains - and the account
    // whose record was folded away keeps nothing.
    const phoneA = randomPhone();
    const emailB = randomEmail("folded");
    const keep = await client({ phone: phoneA, email: randomEmail("keeper"), firstName: "Keeper" });
    const dupe = await client({ email: emailB, firstName: "Dupe" });
    const visit = await visitFor(dupe.id);
    const first = await account({ phone: phoneA });
    const second = await account({ email: emailB });
    expect((await homeOf(first.token)).shops).toHaveLength(1);
    expect((await homeOf(second.token)).shops).toHaveLength(1);

    expect((await merge(keep.id, dupe.id)).status).toBe(200);

    // One active link on the survivor. Never two - the database cannot hold
    // two, and the merge must not leave the wrong one.
    const active = await prisma.customerClientLink.findMany({
      where: { clientId: keep.id, status: "active" },
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.accountId).toBe(first.id);

    // The second account is left with nothing at all - not the record it used
    // to hold, and not the history that moved off it.
    const secondHome = await homeOf(second.token);
    expect(secondHome.shops).toEqual([]);
    const secondPast = (
      await request(app).get("/api/me/appointments").set("Authorization", `Bearer ${second.token}`)
    ).body.past;
    expect(secondPast).toEqual([]);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).clientId).toBe(keep.id);
  });

  it("an account that disowned one half does not inherit the whole", async () => {
    const phone = randomPhone();
    const keep = await client({ phone, firstName: "Keeper" });
    const dupe = await client({ phone, firstName: "Dupe" });
    const me = await account({ phone });
    // Connect the duplicate, then say it is not them.
    await request(app)
      .post("/api/me/profiles/claim")
      .set("Authorization", `Bearer ${me.token}`)
      .send({ link: dupe.magicToken })
      .expect(200);
    const link = await prisma.customerClientLink.findFirstOrThrow({
      where: { accountId: me.id, clientId: dupe.id, status: "active" },
    });
    await request(app)
      .post(`/api/me/shops/${link.id}/not-me`)
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);

    expect((await merge(keep.id, dupe.id)).status).toBe(200);
    const after = await linksOf(me.id);
    expect(after.find((l) => l.clientId === dupe.id)!.status).toBe("rejected");
    // The survivor now CONTAINS what they disowned, so it is disowned too.
    expect(after.find((l) => l.clientId === keep.id)?.status ?? "rejected").toBe("rejected");
    expect((await homeOf(me.token)).shops).toEqual([]);
  });
});

describe("all of it, or none of it", () => {
  it("🔴 a merge that fails after settling the links rolls the links back too", async () => {
    const email = randomEmail("rollback");
    const keep = await client({ phone: randomPhone(), firstName: "Keeper" });
    const dupe = await client({ email, firstName: "Dupe" });
    const visit = await visitFor(dupe.id);
    const me = await account({ email });
    expect((await homeOf(me.token)).shops).toHaveLength(1);
    const before = await linksOf(me.id);

    __setMergeFaultForTests("after_links");
    const res = await merge(keep.id, dupe.id);
    expect(res.status).toBeGreaterThanOrEqual(500);

    // Nothing moved...
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } })).clientId).toBe(dupe.id);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: dupe.id } })).archivedAt).toBeNull();
    expect(await prisma.clientMergeEvent.count({ where: { mergedClientId: dupe.id } })).toBe(0);
    // ...and the customer's link is exactly as it was.
    const after = await linksOf(me.id);
    expect(after.map((l) => ({ c: l.clientId, s: l.status }))).toEqual(
      before.map((l) => ({ c: l.clientId, s: l.status })),
    );
    expect((await homeOf(me.token)).shops).toHaveLength(1);
  });
});

describe("'not the same person' is permanent", () => {
  it("🔴 refuses the merge, and keeps the records apart in the app", async () => {
    const phone = randomPhone();
    const dad = await client({ phone, firstName: "Dad" });
    const kid = await client({ phone, firstName: "Kid" });
    const me = await account({ phone });
    // Before the shop says anything, the pair is merely ambiguous.
    expect((await homeOf(me.token)).ambiguous).toHaveLength(1);

    const dismissed = await request(app)
      .post("/api/dashboard/clients/duplicates/dismiss")
      .set("Cookie", cookie)
      .send({ clientIds: [dad.id, kid.id] });
    expect(dismissed.status).toBe(200);

    const res = await merge(dad.id, kid.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("marked_different_people");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: kid.id } })).archivedAt).toBeNull();

    // And the customer side keeps them apart for good: even once one of them
    // is archived - which would otherwise make the contact look unambiguous -
    // the survivor is never linked on that contact alone.
    await prisma.client.update({ where: { id: kid.id }, data: { archivedAt: new Date() } });
    const home = await homeOf(me.token);
    expect(home.shops).toEqual([]);
    expect(await prisma.customerClientLink.count({ where: { accountId: me.id, status: "active" } })).toBe(0);
  });

  it("a link that existed before the shop said so is dropped when it does", async () => {
    const phone = randomPhone();
    const mine = await client({ phone, firstName: "Mine" });
    const me = await account({ phone });
    expect((await homeOf(me.token)).shops).toHaveLength(1);

    // A second record appears on that number and the shop reviews the pair.
    const other = await client({ phone, firstName: "Other" });
    await request(app)
      .post("/api/dashboard/clients/duplicates/dismiss")
      .set("Cookie", cookie)
      .send({ clientIds: [mine.id, other.id] })
      .expect(200);

    const link = await prisma.customerClientLink.findFirstOrThrow({
      where: { accountId: me.id, clientId: mine.id },
    });
    expect(link.status).toBe("detached");
    expect((await homeOf(me.token)).shops).toEqual([]);
  });
});
