import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { suppressionAddressHash } from "../engines/broadcastAudience.js";
import { labelServiceKeys, serviceAudienceMembers } from "../engines/broadcastServices.js";

/**
 * A BROADCAST TO "EVERYONE WHO HAD A FADE".
 *
 * What these hold down:
 *  - who "had it" is decided from the database, per shop, and asked again
 *    inside the freeze - never taken from the preview;
 *  - a native booking matches by its service id, a synced visit by its exact
 *    (trimmed, any-case) name; a nameless visit matches nothing, and a visit
 *    promoted from a native booking is not counted twice or under its old name;
 *  - another shop's service, or its visits of the same name, never count;
 *  - the group only narrows who is considered: consent, unsubscribes and
 *    bounces still apply inside it, and one client is one row.
 */
const app = createApp();
const DAY = 86_400_000;
const emails: string[] = [];
const shopIds: string[] = [];
const accountIds: string[] = [];

let cookie: string;
let shopId: string;
let otherShopId: string;
let staffId: string;
let fadeId: string;
let beardId: string;
let otherFadeId: string;
let otherClientId: string;

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1629${exch}${line}`;
}

async function makeClient(
  over: {
    tier?: "BRONZE" | "SILVER" | "GOLD" | null;
    permitted?: boolean;
    emailOptedOut?: boolean;
    bounced?: boolean;
    phone?: string;
    shop?: string;
  } = {},
) {
  const shop = over.shop ?? shopId;
  const email = `s${randomToken(6)}@example.com`.toLowerCase();
  if (over.bounced) {
    await prisma.emailAddressSuppression.create({
      data: { shopId: shop, addressHash: suppressionAddressHash(shop, email)!, kind: "bounce", source: "provider_webhook" },
    });
  }
  return prisma.client.create({
    data: {
      shopId: shop,
      acuityClientKey: `test:${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Client",
      phone: over.phone ?? randomPhone(),
      email,
      emailOptedOut: over.emailOptedOut ?? false,
      emailMarketingConsentAt: over.permitted === false ? null : new Date("2026-01-01T00:00:00Z"),
      loyaltyTier: over.tier ?? null,
    },
    select: { id: true },
  });
}

/** Each appointment its own minute, so no two ever collide on one staff. */
let slot = 0;
async function appt(
  clientId: string,
  serviceId: string,
  status: "BOOKED" | "COMPLETED" | "NO_SHOW" | "CANCELED",
  startsAt: Date,
  shop = shopId,
  staff = staffId,
) {
  const start = new Date(startsAt.getTime() + (slot++ % 1000) * 60_000);
  return prisma.appointment.create({
    data: {
      shopId: shop,
      staffId: staff,
      serviceId,
      clientId,
      firstName: "Client",
      status,
      startsAt: start,
      endsAt: new Date(start.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

async function visit(
  clientId: string,
  serviceName: string | null,
  status: "SCHEDULED" | "COMPLETED" | "NO_SHOW" | "CANCELED",
  scheduledAt: Date,
  shop = shopId,
) {
  return prisma.visit.create({
    data: {
      shopId: shop,
      clientId,
      acuityAppointmentId: `acu-${randomToken(8)}`,
      status,
      scheduledAt,
      serviceName,
      noShow: status === "NO_SHOW",
    },
    select: { id: true },
  });
}

const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

const preview = (body: object) => request(app).post("/api/broadcasts/preview").set("Cookie", cookie).send(body);
const draft = (body: object) => request(app).post("/api/broadcasts").set("Cookie", cookie).send(body);
const send = (id: string) => request(app).post(`/api/broadcasts/${id}/send`).set("Cookie", cookie).send({});
const options = (sinceDays?: number) =>
  request(app)
    .get(`/api/broadcasts/services${sinceDays ? `?sinceDays=${sinceDays}` : ""}`)
    .set("Cookie", cookie);

const reasonsOf = (skipped: { reason: string; count: number }[]) =>
  Object.fromEntries(skipped.map((s) => [s.reason, s.count]));

beforeAll(async () => {
  __setSendEmailForTests(async () => ({ id: `test-${randomToken(6)}`, status: "sent" as const }));
  const email = `bsvc-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "B", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Service Blast", bookingUrl: "https://s.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  shopIds.push(shopId);
  await prisma.shop.update({
    where: { id: shopId },
    data: { addressStreet: "1 Main St", addressCity: "Newark", addressRegion: "NJ", rewardsEnabled: true },
  });

  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  fadeId = (await prisma.service.create({ data: { shopId, name: "Fade", durationMin: 30 }, select: { id: true } })).id;
  beardId = (
    await prisma.service.create({ data: { shopId, name: "Beard Trim", durationMin: 30 }, select: { id: true } })
  ).id;
  // Switched off and never booked: not worth offering.
  await prisma.service.create({ data: { shopId, name: "Retired Special", durationMin: 30, active: false } });

  // ANOTHER shop with a service of the SAME name, a client who had it, and a
  // synced visit of that name too.
  const owner = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
  otherShopId = (
    await prisma.shop.create({
      data: {
        ownerId: owner.id,
        name: "Other Shop",
        slug: `bsvc-${randomToken(6)}`.toLowerCase(),
        bookingMode: "native",
        webhookSecret: randomToken(),
        timezone: "America/New_York",
      },
      select: { id: true },
    })
  ).id;
  shopIds.push(otherShopId);
  const otherStaff = (await prisma.staff.create({ data: { shopId: otherShopId, name: "Kai" }, select: { id: true } }))
    .id;
  otherFadeId = (
    await prisma.service.create({ data: { shopId: otherShopId, name: "Fade", durationMin: 30 }, select: { id: true } })
  ).id;
  otherClientId = (await makeClient({ shop: otherShopId })).id;
  await appt(otherClientId, otherFadeId, "COMPLETED", ago(3), otherShopId, otherStaff);
  await visit(otherClientId, "Fade", "COMPLETED", ago(4), otherShopId);
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  const ids = shopIds.filter(Boolean);
  if (ids.length) {
    await prisma.appointment.deleteMany({ where: { shopId: { in: ids } } });
    await prisma.shop.deleteMany({ where: { id: { in: ids } } });
  }
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

/** The book every test starts from. */
type Who =
  | "native" | "synced" | "both" | "upcoming" | "old" | "noShow"
  | "canceled" | "promoted" | "braids" | "square" | "none";
let c: Record<Who, string>;

beforeEach(async () => {
  if (!shopId) throw new Error("setup failed");
  await prisma.broadcast.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.emailAddressSuppression.deleteMany({ where: { shopId } });
  await prisma.service.update({ where: { id: fadeId }, data: { name: "Fade" } });

  c = {} as Record<Who, string>;
  // Had a fade here, natively.
  c.native = (await makeClient({ tier: "GOLD" })).id;
  await appt(c.native, fadeId, "COMPLETED", ago(10));
  // Had one through the old system, spelled a little differently.
  c.synced = (await makeClient()).id;
  await visit(c.synced, "  fade ", "COMPLETED", ago(20));
  // Both: one person, two histories.
  c.both = (await makeClient({ tier: "GOLD" })).id;
  await appt(c.both, fadeId, "COMPLETED", ago(30));
  await visit(c.both, "Fade", "COMPLETED", ago(40));
  // Booked in for one next week.
  c.upcoming = (await makeClient()).id;
  await appt(c.upcoming, fadeId, "BOOKED", ahead(5));
  // Only long ago.
  c.old = (await makeClient()).id;
  await appt(c.old, fadeId, "COMPLETED", ago(200));
  // Never sat for it: no-shows and cancellations, native and synced.
  c.noShow = (await makeClient()).id;
  await appt(c.noShow, fadeId, "NO_SHOW", ago(8));
  await visit(c.noShow, "Fade", "NO_SHOW", ago(9));
  c.canceled = (await makeClient()).id;
  await appt(c.canceled, fadeId, "CANCELED", ago(7));
  await visit(c.canceled, "Fade", "CANCELED", ago(6));
  // A beard trim booked natively, whose promoted Visit carries a stale "Fade"
  // name: the appointment speaks for it, and it was a beard trim.
  c.promoted = (await makeClient()).id;
  const v = await visit(c.promoted, "Fade", "COMPLETED", ago(12));
  const a = await appt(c.promoted, beardId, "COMPLETED", ago(12));
  await prisma.appointment.update({ where: { id: a.id }, data: { visitId: v.id } });
  // A synced name that is not on the menu.
  c.braids = (await makeClient()).id;
  await visit(c.braids, "Braids", "COMPLETED", ago(15));
  // A Square visit: no service name at all.
  c.square = (await makeClient()).id;
  await visit(c.square, null, "COMPLETED", ago(5));
  // No history.
  c.none = (await makeClient({ tier: "GOLD" })).id;
});

const FADE_ANY_TIME = ["native", "synced", "both", "upcoming", "old"];
/** Every client beforeEach writes. */
const BOOK = 11;

describe("the By service list", () => {
  it("lists the menu and the synced names that match none of it, each with its real count", async () => {
    // A synced visit whose name is only spaces is as nameless as a Square one.
    await visit((await makeClient()).id, "   ", "COMPLETED", ago(3));
    const res = await options();
    expect(res.status).toBe(200);
    const byLabel = Object.fromEntries(
      (res.body.options as { label: string; clients: number; source: string; key: string }[]).map((o) => [o.label, o]),
    );
    expect(byLabel.Fade).toMatchObject({ key: `id:${fadeId}`, source: "menu", clients: FADE_ANY_TIME.length });
    expect(byLabel["Beard Trim"]).toMatchObject({ source: "menu", clients: 1 });
    expect(byLabel.Braids).toMatchObject({ key: "name:braids", source: "synced", clients: 1 });
    // Nothing for a nameless visit, and a switched-off service nobody had is not offered.
    expect(Object.keys(byLabel).sort()).toEqual(["Beard Trim", "Braids", "Fade"]);
  });

  it("counts only the window, but an upcoming booking always", async () => {
    const res = await options(90);
    const fade = (res.body.options as { key: string; clients: number }[]).find((o) => o.key === `id:${fadeId}`);
    expect(fade?.clients).toBe(FADE_ANY_TIME.length - 1); // "old" drops out
    expect((await options(30 as never)).status).toBe(400);
  });
});

describe("the preview by service", () => {
  it("reaches exactly the clients who had it, and names the rest as not in the group", async () => {
    const res = await preview({ channel: "email", services: { keys: [`id:${fadeId}`], sinceDays: null } });
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(FADE_ANY_TIME.length);
    expect(reasonsOf(res.body.skipped)).toEqual({ not_in_audience: BOOK - FADE_ANY_TIME.length });
  });

  it("🔴 narrows BOTH channels' counts, not just the one picked", async () => {
    // Everyone in the book has the app; only the group may be counted.
    for (const id of Object.values(c)) {
      await prisma.pushSubscription.create({
        data: { shopId, clientId: id, endpoint: `https://push.test/${randomToken(8)}`, kind: "web" },
      });
    }
    const res = await preview({ channel: "email", services: { keys: [`id:${fadeId}`], sinceDays: null } });
    expect(res.status).toBe(200);
    expect(res.body.channels.email.reachable).toBe(FADE_ANY_TIME.length);
    expect(res.body.channels.push.reachable).toBe(FADE_ANY_TIME.length);
    expect(reasonsOf(res.body.channels.push.skipped)).toEqual({ not_in_audience: BOOK - FADE_ANY_TIME.length });
  });

  it("a synced name reaches only the visits of that name", async () => {
    const res = await preview({ channel: "email", services: { keys: ["name:braids"], sinceDays: null } });
    expect(res.body.reachable).toBe(1);
  });

  it("combines with a tier: both have to be true", async () => {
    const res = await preview({
      channel: "email",
      tiers: ["GOLD"],
      services: { keys: [`id:${fadeId}`], sinceDays: null },
    });
    expect(res.body.reachable).toBe(2); // native + both; "none" is gold but never had one
  });

  it("🔴 refuses an empty pick instead of reading it as everyone", async () => {
    const p = await preview({ channel: "email", services: { keys: [], sinceDays: null } });
    expect(p.status).toBe(400);
    const d = await draft({ channel: "email", subject: "Hi", body: "Hello", services: { keys: [], sinceDays: null } });
    expect(d.status).toBe(400);
    expect(await prisma.broadcast.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 refuses another shop's service, and one that does not exist", async () => {
    for (const key of [`id:${otherFadeId}`, "id:nosuchservice"]) {
      const p = await preview({ channel: "push", services: { keys: [`id:${fadeId}`, key], sinceDays: null } });
      expect(p.status).toBe(400);
      expect(p.body.error).toBe("unknown_service");
      const d = await draft({ channel: "push", subject: "Hi", body: "Hello", services: { keys: [key], sinceDays: null } });
      expect(d.status).toBe(400);
    }
    expect(await prisma.broadcast.count({ where: { shopId } })).toBe(0);
  });
});

describe("🔴 the freeze", () => {
  async function queue(body: object) {
    const d = await draft({ subject: "Fade week", body: "Book a fade.", ...body });
    expect(d.status).toBe(201);
    return { id: d.body.id as string, res: await send(d.body.id as string) };
  }
  const rowsFor = (broadcastId: string) =>
    prisma.broadcastSend.findMany({ where: { broadcastId }, select: { clientId: true, status: true, reason: true } });

  it("gives a client matched through native AND synced history exactly one row", async () => {
    const { id, res } = await queue({ channel: "email", services: { keys: [`id:${fadeId}`], sinceDays: null } });
    expect(res.status).toBe(202);
    expect(res.body.recipients).toBe(FADE_ANY_TIME.length);
    const rows = await rowsFor(id);
    expect(rows.filter((r) => r.clientId === c.both)).toEqual([{ clientId: c.both, status: "PENDING", reason: null }]);
    // Every client in the book, once.
    expect(rows).toHaveLength(BOOK);
    expect(new Set(rows.map((r) => r.clientId)).size).toBe(BOOK);
    for (const k of ["square", "promoted", "noShow", "canceled", "braids", "none"] as const) {
      expect(rows.find((r) => r.clientId === c[k])).toMatchObject({ status: "SKIPPED", reason: "not_in_audience" });
    }
  });

  it("🔴 reads who had it at SEND time, not when the draft was written", async () => {
    const d = await draft({
      channel: "email",
      subject: "Fade week",
      body: "Book a fade.",
      services: { keys: [`id:${fadeId}`], sinceDays: 90 },
    });
    expect(d.status).toBe(201);
    // After the draft: one client gets a fade, another cancels theirs.
    await appt(c.none, fadeId, "COMPLETED", ago(1));
    await prisma.appointment.updateMany({ where: { clientId: c.upcoming }, data: { status: "CANCELED" } });
    const res = await send(d.body.id as string);
    expect(res.status).toBe(202);
    const rows = await rowsFor(d.body.id as string);
    expect(rows.find((r) => r.clientId === c.none)?.status).toBe("PENDING");
    expect(rows.find((r) => r.clientId === c.upcoming)?.reason).toBe("not_in_audience");
    // And the draft's window: a fade 200 days ago is outside the last 90.
    expect(rows.find((r) => r.clientId === c.old)?.reason).toBe("not_in_audience");
    expect(rows.find((r) => r.clientId === c.native)?.status).toBe("PENDING");
  });

  it("still skips the not-permitted, the unsubscribed and the bounced inside the group", async () => {
    const askedNot = (await makeClient({ permitted: false })).id;
    const unsub = (await makeClient({ emailOptedOut: true })).id;
    const bounced = (await makeClient({ bounced: true })).id;
    for (const id of [askedNot, unsub, bounced]) await appt(id, fadeId, "COMPLETED", ago(2));
    const { id, res } = await queue({ channel: "email", services: { keys: [`id:${fadeId}`], sinceDays: 90 } });
    expect(res.status).toBe(202);
    const rows = await rowsFor(id);
    expect(rows.find((r) => r.clientId === askedNot)?.reason).toBe("not_permitted");
    expect(rows.find((r) => r.clientId === unsub)?.reason).toBe("unsubscribed");
    expect(rows.find((r) => r.clientId === bounced)?.reason).toBe("undeliverable");
  });

  it("keeps the names the barber picked, even after a rename", async () => {
    await queue({ channel: "push", services: { keys: [`id:${fadeId}`, "name:braids"], sinceDays: 365 } });
    await prisma.service.update({ where: { id: fadeId }, data: { name: "Skin Fade" } });
    const list = await request(app).get("/api/broadcasts").set("Cookie", cookie);
    expect(list.body.broadcasts[0]).toMatchObject({
      audienceServiceKeys: [`id:${fadeId}`, "name:braids"],
      audienceServiceLabels: ["Fade", "Braids"],
      audienceSinceDays: 365,
    });
  });
});

describe("who had it: the rule itself", () => {
  const NOW = new Date("2026-06-15T12:00:00Z");
  const members = (keys: string[], sinceDays: 90 | 365 | null, shop = shopId) =>
    prisma.$transaction((tx) => serviceAudienceMembers(tx, shop, keys, sinceDays, NOW));

  it("the window includes its first instant and nothing before it", async () => {
    const edge = (await makeClient()).id;
    const before = (await makeClient()).id;
    const syncedEdge = (await makeClient()).id;
    const syncedBefore = (await makeClient()).id;
    const start = new Date(NOW.getTime() - 90 * DAY);
    await prisma.appointment.create({
      data: {
        shopId, staffId, serviceId: fadeId, clientId: edge, firstName: "E", status: "COMPLETED",
        startsAt: start, endsAt: new Date(start.getTime() + 1_800_000), manageToken: randomToken(),
      },
    });
    await prisma.appointment.create({
      data: {
        shopId, staffId, serviceId: fadeId, clientId: before, firstName: "B", status: "COMPLETED",
        startsAt: new Date(start.getTime() - 1), endsAt: start, manageToken: randomToken(),
      },
    });
    await visit(syncedEdge, "Fade", "COMPLETED", start);
    await visit(syncedBefore, "Fade", "COMPLETED", new Date(start.getTime() - 1));

    const in90 = await members([`id:${fadeId}`], 90);
    expect(in90.has(edge)).toBe(true);
    expect(in90.has(syncedEdge)).toBe(true);
    expect(in90.has(before)).toBe(false);
    expect(in90.has(syncedBefore)).toBe(false);
    const any = await members([`id:${fadeId}`], null);
    expect(any.has(before)).toBe(true);
    expect(any.has(syncedBefore)).toBe(true);
  });

  it("an upcoming booking counts whatever the window; a past one never marked done does not", async () => {
    const soon = (await makeClient()).id;
    const stale = (await makeClient()).id;
    const syncedSoon = (await makeClient()).id;
    await appt(soon, fadeId, "BOOKED", new Date(NOW.getTime() + 400 * DAY));
    await appt(stale, fadeId, "BOOKED", new Date(NOW.getTime() - DAY));
    await visit(syncedSoon, "Fade", "SCHEDULED", new Date(NOW.getTime() + DAY));
    const in90 = await members([`id:${fadeId}`], 90);
    expect(in90.has(soon)).toBe(true);
    expect(in90.has(syncedSoon)).toBe(true);
    expect(in90.has(stale)).toBe(false);
  });

  it("🔴 another shop's same-named service and visits are never included, even without row security", async () => {
    // A plain transaction: no shop is set on the connection, so the explicit
    // shopId in every query is the only thing keeping the other shop out.
    const now = new Date();
    const mine = await prisma.$transaction((tx) => serviceAudienceMembers(tx, shopId, [`id:${fadeId}`, "name:fade"], null, now));
    expect(mine.has(otherClientId)).toBe(false);
    expect(mine.has(c.native)).toBe(true);
    // Its id, asked from this shop, matches nothing and cannot be labelled.
    const foreign = await prisma.$transaction((tx) => serviceAudienceMembers(tx, shopId, [`id:${otherFadeId}`], null, now));
    expect(foreign.size).toBe(0);
    const labels = await prisma.$transaction((tx) => labelServiceKeys(tx, shopId, [`id:${otherFadeId}`]));
    expect(labels.ok).toBe(false);
  });

  it("a nameless visit matches nothing, whatever is picked", async () => {
    const blank = (await makeClient()).id;
    await visit(blank, "   ", "COMPLETED", ago(3));
    const now = new Date();
    const all = await prisma.$transaction((tx) =>
      serviceAudienceMembers(tx, shopId, [`id:${fadeId}`, `id:${beardId}`, "name:braids", "name:"], null, now),
    );
    expect(all.has(c.square)).toBe(false);
    expect(all.has(blank)).toBe(false);
    expect(all.has(c.braids)).toBe(true);
  });
});

describe("🔴 the customer's bell", () => {
  it("a client outside the service group never finds it there; one inside does", async () => {
    process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
    __resetEnvCacheForTests();
    const inPhone = randomPhone();
    const outPhone = randomPhone();
    const inside = (await makeClient({ phone: inPhone })).id;
    await appt(inside, fadeId, "COMPLETED", ago(2));
    await makeClient({ phone: outPhone });
    const account = async (phone: string) => {
      const a = await prisma.customerAccount.create({ data: { phoneE164: phone, phoneVerifiedAt: new Date() } });
      accountIds.push(a.id);
      return mintCustomerSession(a.id, 0);
    };
    const inToken = await account(inPhone);
    const outToken = await account(outPhone);

    const d = await draft({
      channel: "email",
      subject: "Fade week",
      body: "Only for fade clients",
      services: { keys: [`id:${fadeId}`], sinceDays: 90 },
    });
    expect((await send(d.body.id as string)).status).toBe(202);

    const bell = (token: string) => request(app).get("/api/me/announcements").set("Authorization", `Bearer ${token}`);
    const inBell = await bell(inToken);
    expect(inBell.status).toBe(200);
    expect(inBell.body.announcements.map((a: { body: string }) => a.body)).toContain("Only for fade clients");
    const outBell = await bell(outToken);
    expect(outBell.status).toBe(200);
    expect(outBell.body.announcements.map((a: { body: string }) => a.body)).not.toContain("Only for fade clients");
  });
});
