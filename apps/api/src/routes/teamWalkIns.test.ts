import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import type { SendMessageInput } from "../messaging/provider.js";

/**
 * Team walk-ins - Snow's ask (2026-10-15): an online walk-in line at the shop,
 * routed to the barbers who are free, every barber being their own business.
 *
 * What has to hold:
 *  - the front desk offers only members who switched it on AND can take a
 *    walk-in now (their own line on, not paused, a service and a chair);
 *  - a customer who picks a member joins THAT member's own line, on their
 *    books, with that member's menu - nothing lands in the team's shop;
 *  - a pick that stopped being valid (switched off, left, another team's
 *    member) is refused before the verified phone is spent;
 *  - one live spot per phone per desk, whichever barber they pick;
 *  - the owner sees the desk's line - first names, who for, the wait - and
 *    nothing else of anyone's line;
 *  - leaving the team switches it off; Walk-In Mode off hides all of it.
 */
const app = createApp();
const tag = randomToken(6).toLowerCase();
const emails: string[] = [];
let sent: SendMessageInput[] = [];
let phoneSeq = 0;
const freshPhone = () => `+1212555${String(7000 + ++phoneSeq).padStart(4, "0")}`;
const lastSmsTo = (phone: string) => [...sent].reverse().find((s) => s.to === phone);

async function signup(label: string) {
  const email = `${label}-${tag}@test.chairback`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "correct horse battery staple", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}
async function shopFor(cookie: string, name: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", walkInEnabled: true });
  expect(patch.status).toBe(200);
  return res.body.id as string;
}
/** A chair working round the clock and one service, so a wait always exists. */
async function chairAndService(cookie: string, shopId: string, service: string) {
  const staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Chair" })).body.id;
  const serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: service, durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({ data: { shopId, staffId, weekday, startMin: 0, endMin: 1440 } });
  }
  return { staffId: staffId as string, serviceId: serviceId as string };
}

let snow: string;
let teamId: string;
let kioskToken: string;
const m: Record<string, { cookie: string; shopId: string; linkId: string; serviceId: string; staffId: string }> = {};

async function member(label: string, service: string) {
  const cookie = await signup(label);
  const shopId = await shopFor(cookie, `${label} Cuts ${tag}`);
  const { staffId, serviceId } = await chairAndService(cookie, shopId, service);
  const joined = await request(app).post("/api/teams/join").set("Cookie", cookie).send({ team: teamId });
  expect(joined.status).toBe(201);
  expect((await request(app).post(`/api/team/links/${joined.body.id}/approve`).set("Cookie", snow)).status).toBe(200);
  m[label] = { cookie, shopId, linkId: joined.body.id as string, serviceId, staffId };
}

const take = (label: string, on: boolean, cookie = m[label]!.cookie) =>
  request(app).patch(`/api/teams/${m[label]!.linkId}/walk-ins`).set("Cookie", cookie).send({ take: on });
const post = (path: string, body: object) => request(app).post(path).send(body);
const resolve = async () => (await post("/api/walk-in/kiosk/resolve", { token: kioskToken })).body;
const deskView = async () => (await request(app).get("/api/team/walk-ins").set("Cookie", snow)).body;

/** Verify a phone at the TEAM's kiosk; returns the proof. */
async function verified(phone: string) {
  // A phone verified a minute ago is in the resend cooldown; this is a new visit.
  await prisma.walkInPhoneCode.updateMany({ where: { phone }, data: { lastSentAt: new Date(0) } });
  expect((await post("/api/walk-in/kiosk/challenge", { token: kioskToken, phone })).status).toBe(200);
  const code = /(\d{6})/.exec(lastSmsTo(phone)?.body ?? "")![1]!;
  const v = await post("/api/walk-in/kiosk/verify", { token: kioskToken, phone, code });
  expect(v.body.verified).toBe(true);
  return v.body.proof as string;
}
const checkIn = (phone: string, proof: string, businessId: string | null, serviceIds: string[]) =>
  post("/api/walk-in/kiosk/check-in", {
    token: kioskToken,
    proof,
    phone,
    firstName: "Dee",
    lastName: "Secretlast",
    serviceIds,
    preferredStaffId: null,
    smsConsent: true,
    businessId,
  });

beforeAll(async () => {
  process.env.WALK_IN_MODE_ENABLED = "true";
  process.env.DRY_RUN = "true";
  __resetEnvCacheForTests();
  __setSendEmailForTests(async () => ({ id: "TEST", status: "sent" as const }));
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `TEST${sent.length}`, status: "sent" };
    },
  });
  snow = await signup("snow");
  teamId = await shopFor(snow, `United Barbershop ${tag}`);
  await member("chris", "Chris Fade");
  await member("jay", "Jay Taper");
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setSendEmailForTests(undefined);
  delete process.env.WALK_IN_MODE_ENABLED;
  __resetEnvCacheForTests();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) continue;
    const shops = await prisma.shop.findMany({ where: { ownerId: user.id }, select: { id: true } });
    await prisma.walkInEvent.deleteMany({ where: { shopId: { in: shops.map((s) => s.id) } } });
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("setting up the front desk", () => {
  it("a team shop with no chairs of its own can't open a kiosk until a member takes its walk-ins", async () => {
    const before = await request(app).post("/api/shops/me/walk-in-kiosk-token").set("Cookie", snow);
    expect(before.status).toBe(409);
    expect(before.body.error).toBe("shop_not_ready");

    const on = await take("chris", true);
    expect(on.status).toBe(200);
    expect(on.body.walkIns).toEqual({ take: true, lineOn: true });

    const mint = await request(app).post("/api/shops/me/walk-in-kiosk-token").set("Cookie", snow);
    expect(mint.status).toBe(200);
    kioskToken = /#k=([A-Za-z0-9_-]+)/.exec(mint.body.url)![1]!;
  });

  it("only the member switches it, and the owner's feed says so", async () => {
    expect((await take("chris", true, m.jay!.cookie)).status).toBe(404);
    expect((await take("chris", true, snow)).status).toBe(404);
    const feed = (await request(app).get("/api/team/activity").set("Cookie", snow)).body.items;
    expect(feed).toContainEqual(expect.objectContaining({ business: `chris Cuts ${tag}`, kind: "walk_ins_on" }));
  });

  it("🔴 the desk offers only members who take its walk-ins - each with their own menu", async () => {
    const desk = (await resolve()).desk;
    expect(desk.businesses.map((b: { id: string }) => b.id)).toEqual([m.chris!.linkId]);
    const chris = desk.businesses[0];
    expect(chris.name).toBe(`chris Cuts ${tag}`);
    expect(chris.services.map((s: { name: string }) => s.name)).toEqual(["Chris Fade"]);
    expect(chris.staff).toHaveLength(1);
    expect(JSON.stringify(desk)).not.toContain("Jay Taper");
  });

  it("🔴 a member whose own line is off isn't offered, and the owner sees why", async () => {
    expect((await take("jay", true)).status).toBe(200);
    await prisma.shop.update({ where: { id: m.jay!.shopId }, data: { walkInEnabled: false } });
    expect((await resolve()).desk.businesses.map((b: { id: string }) => b.id)).toEqual([m.chris!.linkId]);
    const jay = (await deskView()).members.find((x: { linkId: string }) => x.linkId === m.jay!.linkId);
    expect(jay).toEqual(expect.objectContaining({ taking: true, reason: "line_off" }));

    await prisma.shop.update({ where: { id: m.jay!.shopId }, data: { walkInEnabled: true, walkInAcceptingNow: false } });
    expect((await deskView()).members.find((x: { linkId: string }) => x.linkId === m.jay!.linkId).reason).toBe("paused");

    await prisma.shop.update({ where: { id: m.jay!.shopId }, data: { walkInAcceptingNow: true } });
    expect((await resolve()).desk.businesses.map((b: { id: string }) => b.id)).toEqual([m.chris!.linkId, m.jay!.linkId]);
  });

  it("each business comes with about how long a walk-in waits", async () => {
    const res = await post("/api/walk-in/kiosk/desk/waits", { token: kioskToken });
    expect(res.status).toBe(200);
    expect(res.body.businesses).toEqual([
      { id: m.chris!.linkId, waitMin: 0, ahead: 0 },
      { id: m.jay!.linkId, waitMin: 0, ahead: 0 },
    ]);
  });
});

describe("checking in at the desk", () => {
  let phone: string;

  it("🔴 picking a member puts the customer in THAT member's line, on their books", async () => {
    phone = freshPhone();
    const proof = await verified(phone);
    const res = await checkIn(phone, proof, m.chris!.linkId, [m.chris!.serviceId]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const entry = await prisma.walkInEntry.findFirstOrThrow({ where: { phone } });
    expect(entry).toEqual(
      expect.objectContaining({ shopId: m.chris!.shopId, viaTeamShopId: teamId, status: "WAITING", source: "KIOSK" }),
    );
    // Nothing in the team's own line.
    expect(await prisma.walkInEntry.count({ where: { shopId: teamId } })).toBe(0);
    // The text names the desk and who they're waiting for.
    expect(lastSmsTo(phone)!.body).toContain(`United Barbershop ${tag} (with chris Cuts ${tag})`);
    // Chris runs it from his own board.
    const board = await request(app).get("/api/walk-ins/queue").set("Cookie", m.chris!.cookie);
    expect(board.status).toBe(200);
    expect(board.body.entries.map((e: { id: string }) => e.id)).toContain(entry.id);
  });

  it("🔴 the owner sees the desk's line - first name, who for, the wait - and nothing more", async () => {
    const view = await deskView();
    expect(view.desk).toEqual({ on: true, acceptingNow: true, hasKiosk: true });
    expect(view.line).toEqual([
      expect.objectContaining({ business: { name: `chris Cuts ${tag}` }, firstName: "Dee", status: "WAITING", waitMin: 0 }),
    ]);
    const raw = JSON.stringify(view);
    for (const secret of ["Secretlast", phone, "Chris Fade", m.chris!.serviceId]) expect(raw).not.toContain(secret);
  });

  it("🔴 one spot per phone per desk: checking in again - even for someone else - keeps the first", async () => {
    const proof = await verified(phone);
    const again = await checkIn(phone, proof, m.jay!.linkId, [m.jay!.serviceId]);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });
    expect(await prisma.walkInEntry.count({ where: { phone, status: "WAITING" } })).toBe(1);
    expect(await prisma.walkInEntry.count({ where: { shopId: m.jay!.shopId } })).toBe(0);
    // The kept spot's link is re-sent - naming the line it's actually in.
    expect(lastSmsTo(phone)!.body).toContain(`(with chris Cuts ${tag})`);
  });

  it("the database holds the line too: a second live spot at one desk is refused", async () => {
    const first = await prisma.walkInEntry.findFirstOrThrow({ where: { phone, status: "WAITING" } });
    await expect(
      prisma.walkInEntry.create({
        data: {
          shopId: m.jay!.shopId,
          firstName: "Dup",
          phone,
          source: "KIOSK",
          status: "WAITING",
          position: 1024,
          viaTeamShopId: first.viaTeamShopId,
          joinedAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("🔴 another business's service can't be booked through a member's line", async () => {
    const p = freshPhone();
    const res = await checkIn(p, await verified(p), m.chris!.linkId, [m.jay!.serviceId]);
    expect(res.status).toBe(400);
    expect(await prisma.walkInEntry.count({ where: { phone: p } })).toBe(0);
  });

  it("🔴 a pick that stopped being one is refused - and the verified phone isn't spent", async () => {
    const p = freshPhone();
    const proof = await verified(p);
    expect((await take("jay", false)).status).toBe(200);
    const res = await checkIn(p, proof, m.jay!.linkId, [m.jay!.serviceId]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_selection");
    // Same proof, a valid pick: still good.
    const ok = await checkIn(p, proof, m.chris!.linkId, [m.chris!.serviceId]);
    expect(ok.status).toBe(200);
    expect(await prisma.walkInEntry.count({ where: { phone: p, shopId: m.chris!.shopId } })).toBe(1);
  });

  it("🔴 another team's member is never a pick at this desk", async () => {
    const other = await signup("otherowner");
    const otherTeam = await shopFor(other, `Other Team ${tag}`);
    const outsiderCookie = await signup("outsider");
    const outsiderShop = await shopFor(outsiderCookie, `Outsider ${tag}`);
    const svc = await chairAndService(outsiderCookie, outsiderShop, "Outsider Cut");
    const joined = await request(app).post("/api/teams/join").set("Cookie", outsiderCookie).send({ team: otherTeam });
    await request(app).post(`/api/team/links/${joined.body.id}/approve`).set("Cookie", other);
    await request(app).patch(`/api/teams/${joined.body.id}/walk-ins`).set("Cookie", outsiderCookie).send({ take: true });

    const p = freshPhone();
    const res = await checkIn(p, await verified(p), joined.body.id, [svc.serviceId]);
    expect(res.status).toBe(400);
    expect(await prisma.walkInEntry.count({ where: { phone: p } })).toBe(0);
  });
});

describe("leaving, and the platform switch", () => {
  it("🔴 leaving the team switches it off: the desk stops offering them", async () => {
    expect((await request(app).post(`/api/teams/${m.chris!.linkId}/leave`).set("Cookie", m.chris!.cookie)).status).toBe(200);
    const link = await prisma.teamLink.findUniqueOrThrow({ where: { id: m.chris!.linkId } });
    expect(link.takeTeamWalkIns).toBe(false);
    // No one takes its walk-ins now (Jay switched off above): it's no longer
    // a front desk, and with no chairs of its own the kiosk says not set up.
    const resolved = await resolve();
    expect(resolved.desk).toBeNull();
    expect(resolved.setupComplete).toBe(false);
    // Someone already waiting stays in Chris's own line - it's his business.
    expect(await prisma.walkInEntry.count({ where: { shopId: m.chris!.shopId, status: "WAITING" } })).toBeGreaterThan(0);
  });

  it("Walk-In Mode off: the owner's page gets nothing, the switch 404s, members see no switch", async () => {
    process.env.WALK_IN_MODE_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      expect(await deskView()).toEqual({ available: false });
      expect((await take("jay", true)).status).toBe(404);
      const mine = (await request(app).get("/api/teams").set("Cookie", m.jay!.cookie)).body.links[0];
      expect(mine.walkIns).toBeNull();
    } finally {
      process.env.WALK_IN_MODE_ENABLED = "true";
      __resetEnvCacheForTests();
    }
  });
});

describe("the team shop's own chairs", () => {
  it("🔴 are a choice at the desk too - first - and land in the shop's own line", async () => {
    const own = await chairAndService(snow, teamId, "House Cut");
    expect((await take("jay", true)).status).toBe(200);
    const desk = (await resolve()).desk;
    expect(desk.businesses.map((b: { id: string }) => b.id)).toEqual(["own", m.jay!.linkId]);
    expect(desk.businesses[0].services.map((s: { name: string }) => s.name)).toEqual(["House Cut"]);

    const p = freshPhone();
    const res = await checkIn(p, await verified(p), "own", [own.serviceId]);
    expect(res.status).toBe(200);
    const entry = await prisma.walkInEntry.findFirstOrThrow({ where: { phone: p } });
    expect(entry).toEqual(expect.objectContaining({ shopId: teamId, viaTeamShopId: teamId }));
    // The text names just the shop: they're waiting for its own chairs.
    expect(lastSmsTo(p)!.body).toContain(`You're in line at United Barbershop ${tag}.`);
    expect((await deskView()).line.map((e: { business: { name: string } }) => e.business.name)).toContain(
      `United Barbershop ${tag}`,
    );
  });
});
