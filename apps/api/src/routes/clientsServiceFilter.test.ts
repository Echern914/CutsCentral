import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE CLIENTS LIST, FILTERED TO "BOOKED RETWISTS IN THE LAST 90 DAYS".
 *
 * A barber asked to see everyone who booked braids or retwists in a stretch
 * of time. Who counts is the rule a message "By service" already uses
 * (broadcastServices.test.ts holds that rule down in depth); these hold down
 * what the LIST adds:
 *  - the window: 30 / 90 / a year / any time, 90 when missing or unknown;
 *  - a GROUP pick stands for every service in it, and nothing outside it;
 *  - the filter ANDs with search, status and tier;
 *  - a pick that matches nobody shows NOBODY - another shop's service or
 *    group, or a malformed key, never falls back to the whole book;
 *  - the options list: groups, then services, then old-system names, this
 *    shop's only.
 */
const app = createApp();
const DAY = 86_400_000;
const emails: string[] = [];
const shopIds: string[] = [];

let cookie: string;
let shopId: string;
let otherShopId: string;
let staffId: string;
let retwistId: string;
let cornrowsId: string;
let haircutId: string;
let groupId: string;
let emptyGroupId: string;
let otherServiceId: string;
let otherGroupId: string;

const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1629${exch}${line}`;
}

async function makeClient(firstName: string, over: { tier?: "GOLD" | null; optedOut?: boolean } = {}) {
  return (
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `test:${randomToken(8)}`,
        magicToken: randomToken(),
        firstName,
        phone: randomPhone(),
        loyaltyTier: over.tier ?? null,
        optedOut: over.optedOut ?? false,
      },
      select: { id: true },
    })
  ).id;
}

/** Each appointment its own minute, so no two ever collide on one staff. */
let slot = 0;
async function appt(
  clientId: string,
  serviceId: string,
  status: "BOOKED" | "COMPLETED" | "NO_SHOW" | "CANCELED",
  startsAt: Date,
) {
  const start = new Date(startsAt.getTime() + (slot++ % 1000) * 60_000);
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Client",
      status,
      startsAt: start,
      endsAt: new Date(start.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
  });
}

async function syncedVisit(clientId: string, serviceName: string, scheduledAt: Date) {
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acu-${randomToken(8)}`,
      status: "COMPLETED",
      scheduledAt,
      serviceName,
      noShow: false,
    },
  });
}

/** The names on the list for this query, sorted. */
async function listed(query: string): Promise<string[]> {
  const res = await request(app).get(`/api/dashboard/clients?${query}`).set("Cookie", cookie);
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(res.body.clients.length);
  return (res.body.clients as { name: string }[]).map((c) => c.name).sort();
}

beforeAll(async () => {
  const email = `csf-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "B", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Service Filter", bookingUrl: "https://s.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  shopIds.push(shopId);

  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  groupId = (
    await prisma.serviceGroup.create({ data: { shopId, name: "Retwist/Braids" }, select: { id: true } })
  ).id;
  // A group with nothing in it is not worth offering.
  emptyGroupId = (
    await prisma.serviceGroup.create({ data: { shopId, name: "Empty Group" }, select: { id: true } })
  ).id;
  const svc = (name: string, serviceGroupId?: string) =>
    prisma.service
      .create({ data: { shopId, name, durationMin: 30, serviceGroupId }, select: { id: true } })
      .then((s) => s.id);
  retwistId = await svc("Retwist + cut", groupId);
  cornrowsId = await svc("Cornrows + cut", groupId);
  haircutId = await svc("Haircut");

  // ANOTHER shop, with a group and a service of its own.
  const owner = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
  otherShopId = (
    await prisma.shop.create({
      data: {
        ownerId: owner.id,
        name: "Other Shop",
        slug: `csf-${randomToken(6)}`.toLowerCase(),
        bookingMode: "native",
        webhookSecret: randomToken(),
        timezone: "America/New_York",
      },
      select: { id: true },
    })
  ).id;
  shopIds.push(otherShopId);
  otherGroupId = (
    await prisma.serviceGroup.create({ data: { shopId: otherShopId, name: "Theirs" }, select: { id: true } })
  ).id;
  otherServiceId = (
    await prisma.service.create({
      data: { shopId: otherShopId, name: "Theirs", durationMin: 30, serviceGroupId: otherGroupId },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  const ids = shopIds.filter(Boolean);
  if (ids.length) {
    await prisma.appointment.deleteMany({ where: { shopId: { in: ids } } });
    await prisma.shop.deleteMany({ where: { id: { in: ids } } });
  }
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

beforeEach(async () => {
  if (!shopId) throw new Error("setup failed");
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
});

describe("the window", () => {
  beforeEach(async () => {
    await appt(await makeClient("Ten"), retwistId, "COMPLETED", ago(10));
    await appt(await makeClient("Forty"), retwistId, "COMPLETED", ago(40));
    await appt(await makeClient("TwoHundred"), retwistId, "COMPLETED", ago(200));
    await appt(await makeClient("Ancient"), retwistId, "COMPLETED", ago(800));
    // Booked in for one next week: one of its clients whatever the window.
    await appt(await makeClient("Upcoming"), retwistId, "BOOKED", ahead(7));
    // Never counts: a no-show and a cancellation.
    await appt(await makeClient("NoShow"), retwistId, "NO_SHOW", ago(5));
    await appt(await makeClient("Canceled"), retwistId, "CANCELED", ago(5));
    // Someone who had a haircut only.
    await appt(await makeClient("Haircut"), haircutId, "COMPLETED", ago(5));
  });

  const pick = () => `service=${encodeURIComponent(`id:${retwistId}`)}`;

  it("30 days", async () => {
    expect(await listed(`${pick()}&within=30`)).toEqual(["Ten", "Upcoming"]);
  });

  it("90 days", async () => {
    expect(await listed(`${pick()}&within=90`)).toEqual(["Forty", "Ten", "Upcoming"]);
  });

  it("a year", async () => {
    expect(await listed(`${pick()}&within=365`)).toEqual(["Forty", "Ten", "TwoHundred", "Upcoming"]);
  });

  it("any time", async () => {
    expect(await listed(`${pick()}&within=any`)).toEqual(["Ancient", "Forty", "Ten", "TwoHundred", "Upcoming"]);
  });

  it("🔴 no window, or one the list does not offer, is 90 days (what the page shows)", async () => {
    const ninety = ["Forty", "Ten", "Upcoming"];
    expect(await listed(pick())).toEqual(ninety);
    expect(await listed(`${pick()}&within=7`)).toEqual(ninety);
  });

  it("no service picked: the whole book, the window ignored", async () => {
    expect(await listed("within=30")).toHaveLength(8);
  });
});

describe("what a pick stands for", () => {
  it("🔴 a group is every service in it, and nothing outside it", async () => {
    await appt(await makeClient("Retwist"), retwistId, "COMPLETED", ago(5));
    await appt(await makeClient("Cornrows"), cornrowsId, "COMPLETED", ago(5));
    await appt(await makeClient("Haircut"), haircutId, "COMPLETED", ago(5));
    expect(await listed(`service=${encodeURIComponent(`group:${groupId}`)}`)).toEqual(["Cornrows", "Retwist"]);
    // One service of the group is just that service.
    expect(await listed(`service=${encodeURIComponent(`id:${cornrowsId}`)}`)).toEqual(["Cornrows"]);
  });

  it("an old system's name matches its synced visits", async () => {
    await syncedVisit(await makeClient("Synced"), " Braids ", ago(5));
    await syncedVisit(await makeClient("Other"), "Line up", ago(5));
    expect(await listed(`service=${encodeURIComponent("name:braids")}`)).toEqual(["Synced"]);
  });

  it("🔴 another shop's group or service, a group with no services, or a junk key shows NOBODY", async () => {
    await appt(await makeClient("Retwist"), retwistId, "COMPLETED", ago(5));
    for (const key of [
      `group:${otherGroupId}`,
      `id:${otherServiceId}`,
      `group:${emptyGroupId}`,
      "group:",
      "id:",
      "nonsense",
    ]) {
      expect(await listed(`service=${encodeURIComponent(key)}`), key).toEqual([]);
    }
  });
});

describe("with the other filters", () => {
  it("🔴 ANDs with a search (the ranked path)", async () => {
    const hadIt = await makeClient("Jordan");
    await appt(hadIt, retwistId, "COMPLETED", ago(5));
    await makeClient("Jordan"); // same name, never had it
    await appt(await makeClient("Taylor"), retwistId, "COMPLETED", ago(5));
    const res = await request(app)
      .get(`/api/dashboard/clients?q=Jordan&service=${encodeURIComponent(`id:${retwistId}`)}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect((res.body.clients as { id: string }[]).map((c) => c.id)).toEqual([hadIt]);
    expect(res.body.total).toBe(1);
  });

  it("a search with a pick that matches nobody finds nobody", async () => {
    await makeClient("Jordan");
    expect(await listed(`q=Jordan&service=${encodeURIComponent(`id:${retwistId}`)}`)).toEqual([]);
  });

  it("ANDs with a tier and a status", async () => {
    await appt(await makeClient("GoldHad", { tier: "GOLD" }), retwistId, "COMPLETED", ago(5));
    await appt(await makeClient("PlainHad"), retwistId, "COMPLETED", ago(5));
    await appt(await makeClient("OptedOutHad", { optedOut: true }), retwistId, "COMPLETED", ago(5));
    await makeClient("GoldNever", { tier: "GOLD" });
    const pick = `service=${encodeURIComponent(`id:${retwistId}`)}`;
    expect(await listed(`${pick}&tier=GOLD`)).toEqual(["GoldHad"]);
    expect(await listed(`${pick}&filter=optedOut`)).toEqual(["OptedOutHad"]);
  });
});

describe("GET /api/dashboard/clients/service-options", () => {
  it("🔴 groups with services first, then services, then old-system names - this shop's only", async () => {
    await syncedVisit(await makeClient("Synced"), "Braids", ago(5));
    const res = await request(app).get("/api/dashboard/clients/service-options").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const options = res.body.options as { key: string; label: string; kind: string }[];
    expect(options[0]).toEqual({ key: `group:${groupId}`, label: "Retwist/Braids", kind: "group" });
    expect(options.filter((o) => o.kind === "group")).toHaveLength(1);
    expect(options.filter((o) => o.kind === "menu").map((o) => o.key).sort()).toEqual(
      [`id:${retwistId}`, `id:${cornrowsId}`, `id:${haircutId}`].sort(),
    );
    expect(options.filter((o) => o.kind === "synced")).toEqual([
      { key: "name:braids", label: "Braids", kind: "synced" },
    ]);
    expect(JSON.stringify(options)).not.toContain(otherGroupId);
    expect(JSON.stringify(options)).not.toContain(otherServiceId);
    // Kinds in order: no menu item before a group, no synced name before a menu item.
    const order = options.map((o) => ["group", "menu", "synced"].indexOf(o.kind));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
