import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * Independent barbers on a shop's team (TeamLink) - Snow's booth-rent model.
 *
 * What has to be true for a barber to trust it:
 *  - asking to join grants the shop NOTHING; the owner approves;
 *  - the owner sees only the numbers the barber switches on, and an unshared
 *    number is never even computed;
 *  - those numbers are the barber's own Insights numbers, not a second opinion;
 *  - only the barber changes what's shared; only the team's owner approves;
 *  - leaving (or being removed) ends the view at once and moves nothing.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
const sent: { to: string; subject: string }[] = [];

async function signup(email: string, name: string): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}

async function createShop(cookie: string, name: string): Promise<{ id: string; slug: string }> {
  const res = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, slug: res.body.slug as string };
}

const tag = randomToken(6).toLowerCase();
let snowCookie: string; // owns the team's shop
let team: { id: string; slug: string };
let joeCookie: string; // owns an independent business
let joe: { id: string; slug: string };
let strangerCookie: string;
let linkId: string;

/** Noon UTC, `daysAgo` back (Joe's shop is pinned to UTC). */
function daysAgo(n: number): Date {
  const d = new Date(Date.now() - n * 86_400_000);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

const teamView = () => request(app).get("/api/team/links").set("Cookie", snowCookie);
const joeView = () => request(app).get("/api/teams").set("Cookie", joeCookie);
const share = (cookie: string, patch: Record<string, boolean>) =>
  request(app).patch(`/api/teams/${linkId}/sharing`).set("Cookie", cookie).send(patch);

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    sent.push({ to: input.to, subject: input.subject });
    return { id: "TEST", status: "sent" as const };
  });

  snowCookie = await signup(`snow-${tag}@test.chairback`, "Snow");
  team = await createShop(snowCookie, `United Barbershop ${tag}`);
  joeCookie = await signup(`joe-${tag}@test.chairback`, "Joe");
  joe = await createShop(joeCookie, `Joe's Cuts ${tag}`);
  strangerCookie = await signup(`stranger-${tag}@test.chairback`, "Stranger");
  await createShop(strangerCookie, `Somewhere Else ${tag}`);

  // Joe's own book: two paid cuts for one client, a walk-in, a no-show.
  await prisma.shop.update({ where: { id: joe.id }, data: { timezone: "UTC" } });
  const staff = await prisma.staff.create({ data: { shopId: joe.id, name: "Joe" } });
  const service = await prisma.service.create({
    data: { shopId: joe.id, name: "Fade", durationMin: 45, price: 40 },
  });
  const client = await prisma.client.create({
    data: { shopId: joe.id, firstName: "Reg", acuityClientKey: `tl-reg-${tag}`, magicToken: randomToken() },
  });
  const other = await prisma.client.create({
    data: { shopId: joe.id, firstName: "Tay", acuityClientKey: `tl-tay-${tag}`, magicToken: randomToken() },
  });
  const appt = (clientId: string | null, when: Date, status: string, price: number) =>
    prisma.appointment.create({
      data: {
        shopId: joe.id,
        staffId: staff.id,
        serviceId: service.id,
        clientId,
        firstName: clientId ? "Reg" : "Walk-in",
        status: status as "COMPLETED",
        startsAt: when,
        endsAt: new Date(when.getTime() + 45 * 60_000),
        priceAtBooking: price,
        manageToken: randomToken(),
      },
    });
  await appt(client.id, daysAgo(3), "COMPLETED", 40);
  await appt(client.id, daysAgo(10), "COMPLETED", 45);
  await appt(null, daysAgo(5), "COMPLETED", 30);
  await appt(other.id, daysAgo(7), "NO_SHOW", 40);
  // Outside the window: must not count.
  await appt(client.id, daysAgo(60), "COMPLETED", 99);
  for (const rating of [5, 4]) {
    await prisma.review.create({
      data: { shopId: joe.id, rating, body: "Clean fade", authorName: "R", status: "APPROVED" },
    });
  }
  await prisma.review.create({
    data: { shopId: joe.id, rating: 1, body: "pending", authorName: "X", status: "PENDING" },
  });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("asking to join", () => {
  it("🔴 grants nothing: the request waits, and the owner sees a name - no numbers", async () => {
    const res = await request(app)
      .post("/api/teams/join")
      .set("Cookie", joeCookie)
      .send({ team: team.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, status: "PENDING" });
    linkId = res.body.id as string;

    const view = await teamView();
    expect(view.status).toBe(200);
    expect(view.body.joinUrl).toMatch(new RegExp(`/team/link/${team.id}$`));
    expect(view.body.active).toEqual([]);
    expect(view.body.pending).toEqual([
      expect.objectContaining({ id: linkId, ownerName: "Joe" }),
    ]);
    expect(view.body.pending[0]).not.toHaveProperty("numbers");
    // The owner is told, by email.
    expect(sent.some((m) => m.to === `snow-${tag}@test.chairback`)).toBe(true);
  });

  it("asking twice makes no second request", async () => {
    const res = await request(app)
      .post("/api/teams/join")
      .set("Cookie", joeCookie)
      .send({ team: team.id });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already_linked", status: "PENDING" });
    const rows = await runAsOwner((tx) =>
      tx.teamLink.count({ where: { teamShopId: team.id, memberShopId: joe.id } }),
    );
    expect(rows).toBe(1);
  });

  it("can't join your own team, a team that doesn't exist, by web address, or without a business", async () => {
    const own = await request(app)
      .post("/api/teams/join")
      .set("Cookie", snowCookie)
      .send({ team: team.id });
    expect(own.status).toBe(409);
    expect(own.body.error).toBe("own_team");

    const nowhere = await request(app)
      .post("/api/teams/join")
      .set("Cookie", joeCookie)
      .send({ team: `no-such-shop-${tag}` });
    expect(nowhere.status).toBe(404);

    // 🔴 The shop's web address finds nothing: it can be changed and then
    // taken by another shop, and an old link would ask to join THAT one.
    const byAddress = await request(app)
      .post("/api/teams/join")
      .set("Cookie", joeCookie)
      .send({ team: team.slug });
    expect(byAddress.status).toBe(404);
    const previewByAddress = await request(app)
      .get("/api/teams/preview")
      .query({ team: team.slug })
      .set("Cookie", joeCookie);
    expect(previewByAddress.status).toBe(404);

    const noBusinessCookie = await signup(`nobiz-${tag}@test.chairback`, "New");
    const noBusiness = await request(app)
      .post("/api/teams/join")
      .set("Cookie", noBusinessCookie)
      .send({ team: team.id });
    expect(noBusiness.status).toBe(409);
    expect(noBusiness.body.error).toBe("no_business");
  });
});

describe("approving", () => {
  it("🔴 only the team's owner can: not the barber who asked, not another shop", async () => {
    for (const cookie of [joeCookie, strangerCookie]) {
      const res = await request(app)
        .post(`/api/team/links/${linkId}/approve`)
        .set("Cookie", cookie);
      expect(res.status).toBe(404);
    }
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id: linkId } }));
    expect(row.status).toBe("PENDING");
  });

  it("puts them on the team - still sharing nothing until they choose", async () => {
    const res = await request(app)
      .post(`/api/team/links/${linkId}/approve`)
      .set("Cookie", snowCookie);
    expect(res.status).toBe(200);
    // A second tap finds nothing left to approve.
    const again = await request(app)
      .post(`/api/team/links/${linkId}/approve`)
      .set("Cookie", snowCookie);
    expect(again.status).toBe(404);

    const view = await teamView();
    expect(view.body.pending).toEqual([]);
    expect(view.body.active).toHaveLength(1);
    expect(view.body.active[0].numbers).toEqual({
      cuts: null,
      revenueCents: null,
      clients: null,
      rating: null,
    });
    expect(sent.some((m) => m.to === `joe-${tag}@test.chairback`)).toBe(true);
  });
});

describe("what the owner sees", () => {
  it("🔴 only the numbers the barber switched on - the rest are never computed", async () => {
    const res = await share(joeCookie, { shareCuts: true });
    expect(res.status).toBe(200);
    const view = await teamView();
    expect(view.body.active[0].numbers).toEqual({
      cuts: 4,
      revenueCents: null,
      clients: null,
      rating: null,
    });
  });

  it("🔴 the same numbers as the barber's own Insights and public page", async () => {
    await share(joeCookie, { shareRevenue: true, shareClients: true, shareRating: true });
    const numbers = (await teamView()).body.active[0].numbers;

    const insights = await request(app)
      .get("/api/insights")
      .query({ period: "30d" })
      .set("Cookie", joeCookie);
    expect(insights.status).toBe(200);
    expect(numbers.cuts).toBe(insights.body.totals.visits);
    expect(numbers.revenueCents).toBe(insights.body.totals.revenue * 100);
    expect(numbers.clients).toBe(insights.body.totals.uniqueClients);

    const page = await request(app).get(`/api/page/${joe.slug}`);
    expect(numbers.rating).toEqual({
      average: page.body.reviewSummary.avgRating,
      count: page.body.reviewSummary.count,
    });
    // And the actual values: 4 visits in the window (the no-show counts as a
    // visit, as in Insights); $40 + $45 + $30 earned; 2 clients; 4.5 from 2.
    expect(numbers).toEqual({
      cuts: 4,
      revenueCents: 11500,
      clients: 2,
      rating: { average: 4.5, count: 2 },
    });
  });

  it("the barber's preview is exactly what the owner sees", async () => {
    const mine = await joeView();
    expect(mine.status).toBe(200);
    expect(mine.body.links).toHaveLength(1);
    expect(mine.body.links[0].status).toBe("ACTIVE");
    expect(mine.body.links[0].theySee).toEqual((await teamView()).body.active[0].numbers);
  });

  it("🔴 only the barber changes what's shared - not the owner, not a stranger", async () => {
    for (const cookie of [snowCookie, strangerCookie]) {
      const res = await share(cookie, { shareRevenue: false });
      expect(res.status).toBe(404);
    }
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id: linkId } }));
    expect(row.shareRevenue).toBe(true);
  });

  it("turning a number off hides it on the next look", async () => {
    const res = await share(joeCookie, { shareRevenue: false, shareClients: false });
    expect(res.body.sharing).toEqual({
      shareCuts: true,
      shareRevenue: false,
      shareClients: false,
      shareRating: true,
    });
    expect(res.body.theySee.revenueCents).toBeNull();
    expect((await teamView()).body.active[0].numbers.revenueCents).toBeNull();
  });

  it("rejects an empty or unknown change", async () => {
    expect((await share(joeCookie, {})).status).toBe(400);
    expect((await share(joeCookie, { shareEverything: true })).status).toBe(400);
  });

  it("a manager of the team's shop sees nothing - members share with the owner", async () => {
    const managerEmail = `mgr-${tag}@test.chairback`;
    const managerCookie = await signup(managerEmail, "Manager");
    const manager = await prisma.user.findUniqueOrThrow({ where: { email: managerEmail } });
    await prisma.shopMember.create({
      data: { shopId: team.id, userId: manager.id, role: "MANAGER" },
    });
    const res = await request(app).get("/api/team/links").set("Cookie", managerCookie);
    expect(res.status).toBe(403);
  });
});

describe("leaving and being removed", () => {
  it("🔴 leaving ends the owner's view at once, resets sharing, and moves nothing", async () => {
    const clientsBefore = await prisma.client.count({ where: { shopId: joe.id } });
    const res = await request(app)
      .post(`/api/teams/${linkId}/leave`)
      .set("Cookie", joeCookie);
    expect(res.status).toBe(200);

    expect((await teamView()).body.active).toEqual([]);
    expect((await joeView()).body.links).toEqual([]);
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id: linkId } }));
    expect(row).toMatchObject({
      status: "ENDED",
      shareCuts: false,
      shareRevenue: false,
      shareClients: false,
      shareRating: false,
    });
    expect(await prisma.client.count({ where: { shopId: joe.id } })).toBe(clientsBefore);
  });

  it("asking again starts over: pending, sharing nothing", async () => {
    const res = await request(app)
      .post("/api/teams/join")
      .set("Cookie", joeCookie)
      .send({ team: team.id });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(linkId);
    const view = await teamView();
    expect(view.body.pending.map((p: { id: string }) => p.id)).toEqual([linkId]);
  });

  it("the owner can decline, and later take someone off - their business untouched", async () => {
    const declined = await request(app)
      .post(`/api/team/links/${linkId}/end`)
      .set("Cookie", snowCookie);
    expect(declined.status).toBe(200);

    await request(app).post("/api/teams/join").set("Cookie", joeCookie).send({ team: team.id });
    await request(app).post(`/api/team/links/${linkId}/approve`).set("Cookie", snowCookie);
    await share(joeCookie, { shareCuts: true });
    const appointmentsBefore = await prisma.appointment.count({ where: { shopId: joe.id } });

    const removed = await request(app)
      .post(`/api/team/links/${linkId}/end`)
      .set("Cookie", snowCookie);
    expect(removed.status).toBe(200);
    expect((await teamView()).body.active).toEqual([]);
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id: linkId } }));
    expect(row.shareCuts).toBe(false);
    expect(await prisma.appointment.count({ where: { shopId: joe.id } })).toBe(appointmentsBefore);

    // Ended is ended: nothing left to end, approve, or share.
    expect(
      (await request(app).post(`/api/team/links/${linkId}/end`).set("Cookie", snowCookie)).status,
    ).toBe(404);
    expect((await share(joeCookie, { shareCuts: true })).status).toBe(404);
  });

  it("the barber can only leave their own link", async () => {
    await request(app).post("/api/teams/join").set("Cookie", joeCookie).send({ team: team.id });
    const res = await request(app)
      .post(`/api/teams/${linkId}/leave`)
      .set("Cookie", strangerCookie);
    expect(res.status).toBe(404);
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id: linkId } }));
    expect(row.status).toBe("PENDING");
  });
});

describe("review evidence: fresh businesses, the whole lifecycle", () => {
  /** A new barber with their own business and a little real data in it. */
  async function freshMember(label: string) {
    const email = `${label}-${randomToken(6)}@test.chairback`.toLowerCase();
    const cookie = await signup(email, label);
    const shop = await createShop(cookie, `${label} ${randomToken(4)}`);
    const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
    const staff = await prisma.staff.create({ data: { shopId: shop.id, name: label } });
    const service = await prisma.service.create({
      data: { shopId: shop.id, name: "Cut", durationMin: 30, price: 35 },
    });
    const client = await prisma.client.create({
      data: { shopId: shop.id, firstName: "Kim", acuityClientKey: `ev-${randomToken(6)}`, magicToken: randomToken() },
    });
    const when = daysAgo(2);
    const appt = await prisma.appointment.create({
      data: {
        shopId: shop.id,
        staffId: staff.id,
        serviceId: service.id,
        clientId: client.id,
        firstName: "Kim",
        status: "COMPLETED",
        startsAt: when,
        endsAt: new Date(when.getTime() + 30 * 60_000),
        priceAtBooking: 35,
        manageToken: randomToken(),
      },
    });
    await prisma.payment.create({
      data: {
        shopId: shop.id,
        appointmentId: appt.id,
        stripePaymentIntentId: `pi_ev_${randomToken(8)}`,
        stripeConnectAccountId: "acct_evidence",
        mode: "ahead",
        amount: 3500,
        status: "succeeded",
      },
    });
    return { cookie, shop, ownerId: owner.id };
  }

  /** Every row the business owns that a team could conceivably touch, as it stands. */
  async function snapshot(shopId: string) {
    const [shop, clients, appointments, payments, reviews] = await Promise.all([
      prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { ownerId: true, name: true, updatedAt: true } }),
      prisma.client.findMany({ where: { shopId }, orderBy: { id: "asc" } }),
      prisma.appointment.findMany({ where: { shopId }, orderBy: { id: "asc" } }),
      prisma.payment.findMany({ where: { shopId }, orderBy: { id: "asc" } }),
      prisma.review.findMany({ where: { shopId }, orderBy: { id: "asc" } }),
    ]);
    return JSON.stringify({ shop, clients, appointments, payments, reviews });
  }

  it("🔴 ask, approve, share, stop sharing, leave, ask again and be removed: the business is byte-for-byte unchanged", async () => {
    const m = await freshMember("Ev");
    const before = await snapshot(m.shop.id);
    const teamBefore = await snapshot(team.id);

    const asked = await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    const id = asked.body.id as string;
    await request(app).post(`/api/team/links/${id}/approve`).set("Cookie", snowCookie);
    await request(app)
      .patch(`/api/teams/${id}/sharing`)
      .set("Cookie", m.cookie)
      .send({ shareCuts: true, shareRevenue: true, shareClients: true, shareRating: true });
    await teamView();
    await request(app).patch(`/api/teams/${id}/sharing`).set("Cookie", m.cookie).send({ shareRevenue: false });
    await request(app).post(`/api/teams/${id}/leave`).set("Cookie", m.cookie);
    await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    await request(app).post(`/api/team/links/${id}/approve`).set("Cookie", snowCookie);
    await request(app).post(`/api/team/links/${id}/end`).set("Cookie", snowCookie);

    expect(await snapshot(m.shop.id)).toBe(before);
    // Nothing of theirs landed in the team's shop either.
    expect(await snapshot(team.id)).toBe(teamBefore);
    // Ownership never moved: still the barber's, not the team owner's.
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: m.shop.id } });
    expect(shop.ownerId).toBe(m.ownerId);
    // And no login seat in either direction was created by any of it.
    expect(await prisma.shopMember.count({ where: { shopId: team.id, userId: m.ownerId } })).toBe(0);
  });

  it("🔴 five asks at once make one request; five approvals at once approve it once", async () => {
    const m = await freshMember("Race");
    const asks = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id }),
      ),
    );
    expect(asks.filter((r) => r.status === 201)).toHaveLength(1);
    expect(asks.filter((r) => r.status === 409)).toHaveLength(4);
    const rows = await runAsOwner((tx) =>
      tx.teamLink.findMany({ where: { teamShopId: team.id, memberShopId: m.shop.id } }),
    );
    expect(rows).toHaveLength(1);

    const approvals = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post(`/api/team/links/${rows[0]!.id}/approve`).set("Cookie", snowCookie),
      ),
    );
    expect(approvals.filter((r) => r.status === 200)).toHaveLength(1);
    expect(approvals.filter((r) => r.status === 404)).toHaveLength(4);
    const after = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id: rows[0]!.id } }));
    expect(after.status).toBe("ACTIVE");
    // Asking again while already on the team changes nothing.
    const again = await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "already_linked", status: "ACTIVE" });
  });

  it("🔴 an unrelated shop sees nothing of the relationship or its numbers anywhere it can look", async () => {
    const m = await freshMember("Priv");
    const asked = await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    const id = asked.body.id as string;
    await request(app).post(`/api/team/links/${id}/approve`).set("Cookie", snowCookie);
    await request(app)
      .patch(`/api/teams/${id}/sharing`)
      .set("Cookie", m.cookie)
      .send({ shareCuts: true, shareRevenue: true, shareClients: true, shareRating: true });

    const looks = await Promise.all([
      request(app).get("/api/team/links").set("Cookie", strangerCookie),
      request(app).get("/api/teams").set("Cookie", strangerCookie),
      request(app).get("/api/teams/preview").query({ team: team.id }).set("Cookie", strangerCookie),
    ]);
    for (const r of looks) {
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(m.shop.id);
      expect(JSON.stringify(r.body)).not.toContain(id);
    }
    // The preview says only what the team's public page already says.
    expect(looks[2]!.body).toEqual({
      team: { name: expect.any(String) },
      ownTeam: false,
      business: expect.any(Object),
      status: null,
    });
    for (const r of [
      await request(app).patch(`/api/teams/${id}/sharing`).set("Cookie", strangerCookie).send({ shareRevenue: false }),
      await request(app).post(`/api/teams/${id}/leave`).set("Cookie", strangerCookie),
      await request(app).post(`/api/team/links/${id}/end`).set("Cookie", strangerCookie),
      await request(app).post(`/api/team/links/${id}/approve`).set("Cookie", strangerCookie),
    ]) {
      expect(r.status).toBe(404);
    }
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id } }));
    expect(row).toMatchObject({ status: "ACTIVE", shareRevenue: true });

    // 🔴 A forged active-shop cookie naming the barber's business buys the
    // stranger nothing: the member-side routes re-check ownership.
    const forged = `${strangerCookie}; cb_active_shop=${m.shop.id}`;
    const theirs = await request(app).get("/api/teams").set("Cookie", forged);
    expect(JSON.stringify(theirs.body)).not.toContain(id);
    expect(theirs.body.business?.id).not.toBe(m.shop.id);
    // Nor does it get the team's owner into the barber's business.
    const snowForged = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `${snowCookie}; cb_active_shop=${m.shop.id}`);
    expect(snowForged.body.activeShopId).toBe(team.id);
  });

  it("🔴 only the business OWNER decides - not a manager of the barber's own shop", async () => {
    const m = await freshMember("Mgr");
    const asked = await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    const id = asked.body.id as string;
    await request(app).post(`/api/team/links/${id}/approve`).set("Cookie", snowCookie);
    const email = `mgr-of-${randomToken(6).toLowerCase()}@test.chairback`;
    const mgrCookie = await signup(email, "Their manager");
    const mgr = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.shopMember.create({ data: { shopId: m.shop.id, userId: mgr.id, role: "MANAGER" } });
    const asManager = `${mgrCookie}; cb_active_shop=${m.shop.id}`;
    expect(
      (await request(app).patch(`/api/teams/${id}/sharing`).set("Cookie", asManager).send({ shareRevenue: true })).status,
    ).toBe(404);
    expect((await request(app).post(`/api/teams/${id}/leave`).set("Cookie", asManager)).status).toBe(404);
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id } }));
    expect(row).toMatchObject({ status: "ACTIVE", shareRevenue: false });
  });

  it("🔴 asking again after it ended always starts with nothing shared", async () => {
    const m = await freshMember("Reset");
    const asked = await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    const id = asked.body.id as string;
    // An ended link left holding a switch ON (older data, a manual fix).
    await runAsOwner((tx) =>
      tx.teamLink.update({ where: { id }, data: { status: "ENDED", endedAt: new Date(), shareRevenue: true, shareCuts: true } }),
    );
    const again = await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    expect(again.status).toBe(201);
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id } }));
    expect(row).toMatchObject({ status: "PENDING", shareCuts: false, shareRevenue: false, shareClients: false, shareRating: false });
  });

  it("🔴 sharing one number withholds each of the others (revenue on, cuts off)", async () => {
    const m = await freshMember("One");
    const asked = await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    const id = asked.body.id as string;
    await request(app).post(`/api/team/links/${id}/approve`).set("Cookie", snowCookie);
    await request(app).patch(`/api/teams/${id}/sharing`).set("Cookie", m.cookie).send({ shareRevenue: true });
    const view = await teamView();
    const entry = view.body.active.find((a: { id: string }) => a.id === id);
    expect(entry.numbers).toEqual({ cuts: null, revenueCents: 3500, clients: null, rating: null });
  });

  it("🔴 asking again emails the owner at most once a day - leave-and-ask can't be used to spam them", async () => {
    const m = await freshMember("Reask");
    const toOwner = () => sent.filter((x) => x.to === `snow-${tag}@test.chairback`).length;
    const before = toOwner();
    const ask = () => request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: team.id });
    const leave = (id: string) => request(app).post(`/api/teams/${id}/leave`).set("Cookie", m.cookie);

    const first = await ask();
    expect(first.status).toBe(201);
    const id = first.body.id as string;
    for (let i = 0; i < 3; i++) {
      expect((await leave(id)).status).toBe(200);
      expect((await ask()).status).toBe(201);
    }
    expect(toOwner()).toBe(before + 1);
    // Each request still shows on the owner's Team page.
    expect((await teamView()).body.pending.map((p: { id: string }) => p.id)).toContain(id);

    // A day after the last request, asking again tells the owner again.
    await runAsOwner((tx) =>
      tx.teamLink.update({ where: { id }, data: { requestedAt: new Date(Date.now() - 25 * 3_600_000) } }),
    );
    expect((await leave(id)).status).toBe(200);
    expect((await ask()).status).toBe(201);
    expect(toOwner()).toBe(before + 2);
  });
});
