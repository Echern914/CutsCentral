import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { MAX_SHARED_CONTACT } from "../services/clientDuplicates.js";

/**
 * The duplicates review and the audited merge (services/clientDuplicates.ts,
 * mergeClients in services/client.ts):
 *  - groups form on a shared phone or email (trimmed, any case), never a name;
 *  - archived clients and shared placeholder contacts are never suggested;
 *  - "not the same person" sticks, but a NEW client on that contact re-opens it;
 *  - nothing crosses shops, in the review, the dismissal or the audit trail;
 *  - a merge moves the customer's bookings too, and records who/why/what moved
 *    in a row nobody can edit afterwards.
 */
const app = createApp();
const emailA = `dup-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `dup-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let shopIdA: string;
let shopIdB: string;
let userIdA: string;

async function signupAndShop(email: string, shopName: string) {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Dupe Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://dupes.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie, shopId: shop.body.id as string };
}

/** A random, valid-looking E.164 number, unique per call. */
function phone(): string {
  return `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
}

async function client(
  shopId: string,
  data: { firstName: string | null; phone?: string | null; email?: string | null; archivedAt?: Date },
): Promise<string> {
  const row = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `dup-${randomToken(10)}`,
      magicToken: randomToken(),
      source: "manual",
      ...data,
    },
    select: { id: true },
  });
  return row.id;
}

interface Group {
  key: string;
  matchedOn: string[];
  clients: { id: string; name: string; completedVisits: number }[];
}

async function groups(cookie: string): Promise<Group[]> {
  const res = await request(app).get("/api/dashboard/clients/duplicates").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.groups as Group[];
}

function groupWith(all: Group[], id: string): Group | undefined {
  return all.find((g) => g.clients.some((c) => c.id === id));
}

beforeAll(async () => {
  const a = await signupAndShop(emailA, "Dupes Cuts A");
  cookieA = a.cookie;
  shopIdA = a.shopId;
  const b = await signupAndShop(emailB, "Dupes Cuts B");
  cookieB = b.cookie;
  shopIdB = b.shopId;
  userIdA = (await prisma.user.findUniqueOrThrow({ where: { email: emailA } })).id;
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

describe("duplicates review", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/dashboard/clients/duplicates");
    expect(res.status).toBe(401);
  });

  it("groups clients on a shared phone, suggesting the busier record first", async () => {
    const p = phone();
    const quiet = await client(shopIdA, { firstName: "Marcus", phone: p });
    const busy = await client(shopIdA, { firstName: "Marc", phone: p });
    await prisma.visit.create({
      data: {
        shopId: shopIdA,
        clientId: busy,
        acuityAppointmentId: `dup-${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: new Date("2026-03-01T15:00:00Z"),
        completedAt: new Date("2026-03-01T15:30:00Z"),
      },
    });

    const g = groupWith(await groups(cookieA), quiet);
    expect(g).toBeDefined();
    expect(g!.matchedOn).toEqual(["phone"]);
    expect(g!.clients.map((c) => c.id)).toEqual([busy, quiet]);
    expect(g!.clients[0]!.completedVisits).toBe(1);
  });

  it("matches email trimmed and in any case", async () => {
    const local = `Jo.${randomToken(6)}`;
    const a = await client(shopIdA, { firstName: "Jo", email: `${local}@Example.com` });
    const b = await client(shopIdA, { firstName: "Joanna", email: `  ${local.toLowerCase()}@example.COM ` });
    const g = groupWith(await groups(cookieA), a);
    expect(g?.matchedOn).toEqual(["email"]);
    expect(g?.clients.map((c) => c.id).sort()).toEqual([a, b].sort());
  });

  it("never matches on a name alone", async () => {
    const a = await client(shopIdA, { firstName: "Namesake", phone: phone() });
    await client(shopIdA, { firstName: "Namesake", phone: phone() });
    expect(groupWith(await groups(cookieA), a)).toBeUndefined();
  });

  it("joins a phone match and an email match into one group", async () => {
    const p = phone();
    const e = `chain-${randomToken(6)}@test.local`;
    const a = await client(shopIdA, { firstName: "Chain A", phone: p });
    const b = await client(shopIdA, { firstName: "Chain B", phone: p, email: e });
    const c = await client(shopIdA, { firstName: "Chain C", email: e });
    const g = groupWith(await groups(cookieA), a);
    expect(g?.matchedOn).toEqual(["phone", "email"]);
    expect(g?.clients.map((x) => x.id).sort()).toEqual([a, b, c].sort());
  });

  it("leaves out archived clients", async () => {
    const p = phone();
    const live = await client(shopIdA, { firstName: "Live", phone: p });
    await client(shopIdA, { firstName: "Gone", phone: p, archivedAt: new Date() });
    expect(groupWith(await groups(cookieA), live)).toBeUndefined();
  });

  it("does not suggest a contact shared by a crowd (a shop's own number)", async () => {
    const p = phone();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_SHARED_CONTACT; i++) {
      ids.push(await client(shopIdA, { firstName: `Walk-in ${i}`, phone: p }));
    }
    expect(groupWith(await groups(cookieA), ids[0]!)).toBeUndefined();
  });

  it("never shows another shop's clients, even on the same phone", async () => {
    const p = phone();
    const mineA = await client(shopIdA, { firstName: "Mine", phone: p });
    const mineB = await client(shopIdA, { firstName: "Also mine", phone: p });
    const theirs = await client(shopIdB, { firstName: "Theirs", phone: p });

    const inA = groupWith(await groups(cookieA), mineA);
    expect(inA?.clients.map((c) => c.id).sort()).toEqual([mineA, mineB].sort());
    // Shop B has one client on that number: nothing to review, and no leak.
    const inB = await groups(cookieB);
    expect(groupWith(inB, theirs)).toBeUndefined();
    expect(groupWith(inB, mineA)).toBeUndefined();
  });

  it("'not the same person' sticks, until a new client shares the contact", async () => {
    const p = phone();
    const dad = await client(shopIdA, { firstName: "Dad", phone: p });
    const son = await client(shopIdA, { firstName: "Son", phone: p });
    expect(groupWith(await groups(cookieA), dad)).toBeDefined();

    const res = await request(app)
      .post("/api/dashboard/clients/duplicates/dismiss")
      .set("Cookie", cookieA)
      .send({ clientIds: [son, dad] });
    expect(res.status).toBe(200);
    expect(groupWith(await groups(cookieA), dad)).toBeUndefined();

    // Dismissing again is harmless.
    const again = await request(app)
      .post("/api/dashboard/clients/duplicates/dismiss")
      .set("Cookie", cookieA)
      .send({ clientIds: [dad, son] });
    expect(again.status).toBe(200);

    const row = await prisma.clientDuplicateDismissal.findFirstOrThrow({
      where: { shopId: shopIdA, OR: [{ clientAId: dad }, { clientBId: dad }] },
    });
    expect(row.actorUserId).toBe(userIdA);

    // A third record on the number could be either of them - review again.
    const third = await client(shopIdA, { firstName: "Dad again", phone: p });
    const g = groupWith(await groups(cookieA), third);
    expect(g?.clients.map((c) => c.id).sort()).toEqual([dad, son, third].sort());
  });

  it("refuses to dismiss with another shop's client, writing nothing", async () => {
    const mine = await client(shopIdA, { firstName: "Mine", phone: phone() });
    const theirs = await client(shopIdB, { firstName: "Theirs", phone: phone() });
    const res = await request(app)
      .post("/api/dashboard/clients/duplicates/dismiss")
      .set("Cookie", cookieA)
      .send({ clientIds: [mine, theirs] });
    expect(res.status).toBe(404);
    const rows = await prisma.clientDuplicateDismissal.count({
      where: { OR: [{ clientAId: theirs }, { clientBId: theirs }] },
    });
    expect(rows).toBe(0);
  });

  it("rejects a dismissal of fewer than two clients", async () => {
    const one = await client(shopIdA, { firstName: "Solo", phone: phone() });
    const res = await request(app)
      .post("/api/dashboard/clients/duplicates/dismiss")
      .set("Cookie", cookieA)
      .send({ clientIds: [one] });
    expect(res.status).toBe(400);
  });
});

describe("audited merge", () => {
  let staffId: string;
  let serviceId: string;

  beforeAll(async () => {
    staffId = (await prisma.staff.create({ data: { shopId: shopIdA, name: "Drick" } })).id;
    serviceId = (
      await prisma.service.create({
        data: { shopId: shopIdA, name: "Mens Haircut", durationMin: 30, price: "40" },
      })
    ).id;
  });

  it("moves the customer's bookings and devices, and records who, why and what", async () => {
    const p = phone();
    const keep = await client(shopIdA, { firstName: "Keep", phone: p });
    const dupe = await client(shopIdA, { firstName: "Dupe", phone: p });

    const startsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const appt = await prisma.appointment.create({
      data: {
        shopId: shopIdA,
        staffId,
        serviceId,
        clientId: dupe,
        firstName: "Dupe",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
        manageToken: randomToken(16),
      },
    });
    const series = await prisma.recurringSeries.create({
      data: {
        shopId: shopIdA,
        staffId,
        serviceId,
        clientId: dupe,
        firstName: "Dupe",
        weekday: 2,
        startMin: 600,
        count: 4,
        manageToken: randomToken(16),
      },
    });
    const wait = await prisma.waitlistEntry.create({
      data: { shopId: shopIdA, clientId: dupe, firstName: "Dupe", phone: p, status: "WAITING" },
    });
    const device = await prisma.pushSubscription.create({
      data: { shopId: shopIdA, clientId: dupe, kind: "expo", expoPushToken: `ExponentPushToken[${randomToken(10)}]` },
    });

    const res = await request(app)
      .post(`/api/dashboard/clients/${keep}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: dupe, reason: "Booked under a new number" });
    expect(res.status).toBe(200);
    expect(res.body.moved).toMatchObject({
      appointments: 1,
      standingAppointments: 1,
      waitlistEntries: 1,
      pushDevices: 1,
    });

    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).clientId).toBe(keep);
    expect((await prisma.recurringSeries.findUniqueOrThrow({ where: { id: series.id } })).clientId).toBe(keep);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: wait.id } })).clientId).toBe(keep);
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { id: device.id } })).clientId).toBe(keep);

    const events = await prisma.clientMergeEvent.findMany({ where: { mergedClientId: dupe } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      shopId: shopIdA,
      survivorClientId: keep,
      actorUserId: userIdA,
      reason: "Booked under a new number",
    });
    expect(events[0]!.moved).toMatchObject({ appointments: 1, visits: 0 });
  });

  it("records a merge with no reason given", async () => {
    const keep = await client(shopIdA, { firstName: "K2", phone: phone() });
    const dupe = await client(shopIdA, { firstName: "D2", phone: phone() });
    const res = await request(app)
      .post(`/api/dashboard/clients/${keep}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: dupe });
    expect(res.status).toBe(200);
    const ev = await prisma.clientMergeEvent.findFirstOrThrow({ where: { mergedClientId: dupe } });
    expect(ev.reason).toBeNull();
    expect(ev.actorUserId).toBe(userIdA);
  });

  it("the merge record cannot be edited, by anyone", async () => {
    const keep = await client(shopIdA, { firstName: "K3", phone: phone() });
    const dupe = await client(shopIdA, { firstName: "D3", phone: phone() });
    await request(app)
      .post(`/api/dashboard/clients/${keep}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: dupe })
      .expect(200);
    const ev = await prisma.clientMergeEvent.findFirstOrThrow({ where: { mergedClientId: dupe } });
    // The connection owner, not just the app role: the trigger is what holds.
    await expect(
      prisma.clientMergeEvent.update({ where: { id: ev.id }, data: { reason: "rewritten" } }),
    ).rejects.toThrow(/append-only/);
    expect((await prisma.clientMergeEvent.findUniqueOrThrow({ where: { id: ev.id } })).reason).toBeNull();
  });

  it("another shop cannot read this shop's merge records", async () => {
    const keep = await client(shopIdA, { firstName: "K4", phone: phone() });
    const dupe = await client(shopIdA, { firstName: "D4", phone: phone() });
    await request(app)
      .post(`/api/dashboard/clients/${keep}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: dupe })
      .expect(200);
    // Row-level security, not just a WHERE: ask for it by id from shop B.
    const fromB = await runWithShop(shopIdB, (tx) =>
      tx.clientMergeEvent.findMany({ where: { mergedClientId: dupe } }),
    );
    expect(fromB).toHaveLength(0);
    const fromA = await runWithShop(shopIdA, (tx) =>
      tx.clientMergeEvent.findMany({ where: { mergedClientId: dupe } }),
    );
    expect(fromA).toHaveLength(1);
  });

  it("retires the duplicate's sync key: its next booking is a visible client, not a hidden one", async () => {
    const keep = await client(shopIdA, { firstName: "Keep", phone: phone() });
    const email = `retire-${randomToken(6)}@test.local`;
    // The duplicate was added by email - the same upsert-by-key every booking
    // path uses.
    const added = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookieA)
      .send({ firstName: "Dupe", email });
    expect(added.status).toBe(201);
    const dupe = added.body.id as string;
    await request(app)
      .post(`/api/dashboard/clients/${keep}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: dupe })
      .expect(200);

    // The same identity arrives again.
    const again = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookieA)
      .send({ firstName: "Dupe", email });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(dupe);
    const fresh = await prisma.client.findUniqueOrThrow({ where: { id: again.body.id } });
    expect(fresh.archivedAt).toBeNull();
    const retired = await prisma.client.findUniqueOrThrow({ where: { id: dupe } });
    expect(retired.acuityClientKey).toBe(`merged:${dupe}`);
    expect(retired.archivedAt).not.toBeNull();

    // The survivor took the duplicate's email, so the review pairs them.
    const g = groupWith(await groups(cookieA), keep);
    expect(g?.clients.map((c) => c.id).sort()).toEqual([keep, fresh.id].sort());
  });

  it("never folds a customer-deleted record into another", async () => {
    const keep = await client(shopIdA, { firstName: "K5", phone: phone() });
    const deleted = await client(shopIdA, { firstName: null, phone: null });
    await prisma.client.update({
      where: { id: deleted },
      data: { optedOut: true, optOutSource: "deleted", archivedAt: new Date() },
    });
    const res = await request(app)
      .post(`/api/dashboard/clients/${keep}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: deleted });
    expect(res.status).toBe(404);
    expect(await prisma.clientMergeEvent.count({ where: { mergedClientId: deleted } })).toBe(0);
  });

  it("rejects an over-long reason", async () => {
    const keep = await client(shopIdA, { firstName: "K6", phone: phone() });
    const dupe = await client(shopIdA, { firstName: "D6", phone: phone() });
    const res = await request(app)
      .post(`/api/dashboard/clients/${keep}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: dupe, reason: "x".repeat(201) });
    expect(res.status).toBe(400);
  });
});
