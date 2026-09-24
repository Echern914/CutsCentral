import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner, type Prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { rentSummary, setRent } from "../services/boothRent.js";

/**
 * Booth rent: a manual tracker between a team's owner and one independent
 * member. What must hold, because it's money:
 *  - rent starts on a date the owner chose, and nothing is owed before it;
 *  - payments pay the OLDEST unpaid period first, so a missed week can't hide
 *    behind this week's payment; over-paying shows as a credit;
 *  - a change takes effect next period - the past keeps its rate;
 *  - a mistake is voided, never deleted; a form sent twice records once;
 *  - only the team's owner writes, and the member sees the very same numbers;
 *  - leaving stops the rent, and keeps what's owed.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
const tag = randomToken(6).toLowerCase();

async function signup(email: string, name: string): Promise<string> {
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}

async function createShop(cookie: string, name: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, slug: res.body.slug as string };
}

let snowCookie: string;
let snowUserId: string;
let team: { id: string; slug: string };
let joeCookie: string;
let managerCookie: string;
let strangerCookie: string;
let strangerShopId: string;
let linkId: string;

const DAY = 86_400_000;
/** The team shop's calendar day `n` days from today (the shop runs on UTC here). */
const dayOffset = (n: number) =>
  new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const putRent = (cookie: string, body: object) =>
  request(app).put(`/api/team/links/${linkId}/rent`).set("Cookie", cookie).send(body);
const pay = (cookie: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/team/links/${linkId}/rent/payments`)
    .set("Cookie", cookie)
    .send({ date: dayOffset(0), method: "cash", clientRef: randomToken(8), ...body });
const voidPayment = (cookie: string, id: string) =>
  request(app).post(`/api/team/links/${linkId}/rent/payments/${id}/void`).set("Cookie", cookie);
const voidRate = (cookie: string, id: string) =>
  request(app).post(`/api/team/links/${linkId}/rent/rates/${id}/void`).set("Cookie", cookie);
const ownerView = () => request(app).get(`/api/team/links/${linkId}/rent`).set("Cookie", snowCookie);
const paymentRows = () => runAsOwner((tx) => tx.boothRentPayment.count({ where: { linkId } }));
const starts = (unpaid: { start: string }[]) => unpaid.map((u) => u.start);

beforeAll(async () => {
  snowCookie = await signup(`rent-snow-${tag}@test.chairback`, "Snow");
  snowUserId = (await prisma.user.findUniqueOrThrow({ where: { email: `rent-snow-${tag}@test.chairback` } })).id;
  team = await createShop(snowCookie, `Rent Team ${tag}`);
  await prisma.shop.update({ where: { id: team.id }, data: { timezone: "UTC" } });
  joeCookie = await signup(`rent-joe-${tag}@test.chairback`, "Joe");
  await createShop(joeCookie, `Rent Joe ${tag}`);
  strangerCookie = await signup(`rent-x-${tag}@test.chairback`, "Stranger");
  strangerShopId = (await createShop(strangerCookie, `Rent Stranger ${tag}`)).id;
  managerCookie = await signup(`rent-mgr-${tag}@test.chairback`, "Manager");
  const manager = await prisma.user.findUniqueOrThrow({ where: { email: `rent-mgr-${tag}@test.chairback` } });
  await prisma.shopMember.create({ data: { shopId: team.id, userId: manager.id, role: "MANAGER" } });
  const join = await request(app).post("/api/teams/join").set("Cookie", joeCookie).send({ team: team.id });
  linkId = join.body.id as string;
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("starting rent", () => {
  it("only once they're on the team", async () => {
    expect((await putRent(snowCookie, { amountCents: 15000, period: "WEEKLY", startsOn: dayOffset(0) })).status).toBe(404);
    await request(app).post(`/api/team/links/${linkId}/approve`).set("Cookie", snowCookie);
  });

  it("🔴 only the team's owner: not the member, a manager, or a stranger", async () => {
    const body = { amountCents: 100, period: "WEEKLY", startsOn: dayOffset(0) };
    expect((await putRent(joeCookie, body)).status).toBe(404);
    expect((await putRent(strangerCookie, body)).status).toBe(404);
    expect((await putRent(managerCookie, body)).status).toBe(403);
  });

  it("🔴 needs a start date the owner chose: no rent is invented", async () => {
    const res = await putRent(snowCookie, { amountCents: 15000, period: "WEEKLY" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("start_required");
  });

  it("rejects amounts, periods and dates that make no sense", async () => {
    for (const body of [
      { amountCents: 0, period: "WEEKLY", startsOn: dayOffset(0) },
      { amountCents: 15000, startsOn: dayOffset(0) },
      { amountCents: 15.5, period: "WEEKLY", startsOn: dayOffset(0) },
      { amountCents: 15000, period: "DAILY", startsOn: dayOffset(0) },
      { amountCents: 15000, period: "WEEKLY", startsOn: "2026-02-30" },
      { amountCents: 15000, period: "WEEKLY", startsOn: "soon" },
    ]) {
      expect((await putRent(snowCookie, body)).status).toBe(400);
    }
    // A mistyped year would otherwise bill for decades.
    const typo = await putRent(snowCookie, { amountCents: 15000, period: "WEEKLY", startsOn: dayOffset(-400) });
    expect(typo.body.error).toBe("start_out_of_range");
    expect(await runAsOwner((tx) => tx.boothRentRate.count({ where: { linkId } }))).toBe(0);
  });

  it("🔴 starts on the chosen day: every week since is due, none before it", async () => {
    const res = await putRent(snowCookie, { amountCents: 15000, period: "WEEKLY", startsOn: dayOffset(-14) });
    expect(res.status).toBe(200);
    expect(res.body.rent).toMatchObject({
      rate: { amountCents: 15000, period: "WEEKLY", since: dayOffset(-14) },
      current: { start: dayOffset(0), end: dayOffset(6), amountCents: 15000, paidCents: 0, dueCents: 15000 },
      balanceCents: 45000,
      creditCents: 0,
      scheduled: null,
      nextChangeOn: dayOffset(7),
    });
    expect(starts(res.body.rent.unpaid)).toEqual([dayOffset(-14), dayOffset(-7), dayOffset(0)]);
  });
});

describe("payments pay the oldest week first", () => {
  it("🔴 a payment clears the oldest week, so this week still shows what's due", async () => {
    const res = await pay(snowCookie, { amountCents: 15000 });
    expect(res.status).toBe(201);
    expect(res.body.rent.balanceCents).toBe(30000);
    expect(starts(res.body.rent.unpaid)).toEqual([dayOffset(-7), dayOffset(0)]);
    expect(res.body.rent.current).toMatchObject({ paidCents: 0, dueCents: 15000 });
  });

  it("a partial payment goes to the oldest week and shows what's left of it", async () => {
    const res = await pay(snowCookie, { amountCents: 5000, method: "zelle" });
    expect(res.body.rent.unpaid[0]).toMatchObject({ start: dayOffset(-7), dueCents: 10000 });
    expect(res.body.rent.balanceCents).toBe(25000);
    expect(res.body.rent.lastPayment).toMatchObject({ amountCents: 5000, method: "zelle" });
  });

  it("🔴 the same form submitted twice records one payment", async () => {
    const clientRef = randomToken(8);
    const first = await pay(snowCookie, { amountCents: 3000, clientRef });
    const again = await pay(snowCookie, { amountCents: 3000, clientRef });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(await paymentRows()).toBe(3);
    expect(again.body.rent.balanceCents).toBe(22000);
  });

  it("🔴 no future dates, impossible dates, zero, or unknown methods", async () => {
    expect((await pay(snowCookie, { amountCents: 100, date: dayOffset(1) })).status).toBe(400);
    expect((await pay(snowCookie, { amountCents: 100, date: "2026-02-30" })).status).toBe(400);
    expect((await pay(snowCookie, { amountCents: 0 })).status).toBe(400);
    expect((await pay(snowCookie, { amountCents: 100, method: "bitcoin" })).status).toBe(400);
    expect(await paymentRows()).toBe(3);
  });
});

describe("correcting a payment", () => {
  it("🔴 a voided payment stops counting and stays in the history, marked", async () => {
    const mistake = (await ownerView()).body.payments.find((p: { amountCents: number }) => p.amountCents === 3000);
    const res = await voidPayment(snowCookie, mistake.id);
    expect(res.status).toBe(200);
    expect(res.body.rent.balanceCents).toBe(25000);
    const after = (await ownerView()).body.payments.find((p: { id: string }) => p.id === mistake.id);
    expect(after).toMatchObject({ amountCents: 3000, voided: true });
    expect(await paymentRows()).toBe(3);
  });

  it("voiding it again changes nothing", async () => {
    const mistake = (await ownerView()).body.payments.find((p: { voided: boolean }) => p.voided);
    const res = await voidPayment(snowCookie, mistake.id);
    expect(res.status).toBe(200);
    expect(res.body.rent.balanceCents).toBe(25000);
  });

  it("🔴 only the team's owner records or voids", async () => {
    const payment = (await ownerView()).body.payments.find((p: { voided: boolean }) => !p.voided);
    for (const cookie of [joeCookie, strangerCookie]) {
      expect((await pay(cookie, { amountCents: 100 })).status).toBe(404);
      expect((await voidPayment(cookie, payment.id)).status).toBe(404);
    }
    expect((await voidPayment(managerCookie, payment.id)).status).toBe(403);
    expect((await ownerView()).body.summary.balanceCents).toBe(25000);
    expect(await paymentRows()).toBe(3);
  });
});

describe("credit", () => {
  it("paying more than everything owed shows a credit, never a negative balance", async () => {
    const res = await pay(snowCookie, { amountCents: 35000 });
    expect(res.body.rent).toMatchObject({ balanceCents: 0, creditCents: 10000, unpaid: [] });
    expect(res.body.rent.current).toMatchObject({ paidCents: 15000, dueCents: 0 });
  });
});

describe("changing the rent", () => {
  it("🔴 a change waits for next week: this week and the past keep their rate", async () => {
    const res = await putRent(snowCookie, { amountCents: 20000, period: "WEEKLY" });
    expect(res.status).toBe(200);
    expect(res.body.rent).toMatchObject({
      rate: { amountCents: 15000 },
      scheduled: { amountCents: 20000, period: "WEEKLY", startsOn: dayOffset(7) },
      balanceCents: 0,
      creditCents: 10000,
    });
  });

  it("changing it again before it starts replaces the pending change", async () => {
    const res = await putRent(snowCookie, { amountCents: 18000, period: "WEEKLY" });
    expect(res.body.rent.scheduled).toMatchObject({ amountCents: 18000, startsOn: dayOffset(7) });
    const rates = (await ownerView()).body.rates;
    expect(rates.map((r: { amountCents: number; startsOn: string }) => [r.amountCents, r.startsOn])).toEqual([
      [15000, dayOffset(-14)],
      [18000, dayOffset(7)],
    ]);
  });

  it("🔴 a mistyped rent is voided - the latest entry only - and stays in the history", async () => {
    const [start, change] = (await ownerView()).body.rates as { id: string }[];
    expect((await voidRate(joeCookie, change!.id)).status).toBe(404);
    // Undo one step at a time: the older entry can't go while a newer one stands.
    const early = await voidRate(snowCookie, start!.id);
    expect([early.status, early.body.error]).toEqual([409, "not_latest"]);

    expect((await voidRate(snowCookie, change!.id)).body.rent.scheduled).toBeNull();
    // The start itself was the mistake: void it, and enter it again.
    const none = await voidRate(snowCookie, start!.id);
    expect(none.body.rent).toMatchObject({ rate: null, balanceCents: 0, creditCents: 55000 });
    const fixed = await putRent(snowCookie, { amountCents: 15000, period: "WEEKLY", startsOn: dayOffset(-14) });
    expect(fixed.body.rent).toMatchObject({ rate: { amountCents: 15000 }, balanceCents: 0, creditCents: 10000 });

    const rates = (await ownerView()).body.rates as { amountCents: number; voided: boolean }[];
    expect(rates.map((r) => [r.amountCents, r.voided])).toEqual([
      [15000, true],
      [15000, false],
      [18000, true],
    ]);
  });
});

describe("both sides", () => {
  it("🔴 the member sees exactly what the owner sees", async () => {
    const owner = await request(app).get("/api/team/links").set("Cookie", snowCookie);
    const mine = await request(app).get("/api/teams").set("Cookie", joeCookie);
    const ownerCard = owner.body.active.find((l: { id: string }) => l.id === linkId);
    const myCard = mine.body.links.find((l: { id: string }) => l.id === linkId);
    expect(myCard.rent).toEqual(ownerCard.rent);
    expect(myCard.rent.creditCents).toBe(10000);

    const memberHistory = await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", joeCookie);
    expect(memberHistory.status).toBe(200);
    expect(memberHistory.body).toEqual((await ownerView()).body);
    expect((await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", strangerCookie)).status).toBe(404);
  });
});

describe("leaving", () => {
  it("🔴 rent stops at next week; what's owed and every payment stay", async () => {
    expect((await request(app).post(`/api/teams/${linkId}/leave`).set("Cookie", joeCookie)).status).toBe(200);
    const mine = await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", joeCookie);
    const live = (mine.body.rates as { amountCents: number | null; startsOn: string; voided: boolean }[]).filter(
      (r) => !r.voided,
    );
    expect(live.at(-1)).toMatchObject({ amountCents: null, startsOn: dayOffset(7) });
    expect(mine.body.payments).toHaveLength(4);
    expect(mine.body.summary).toMatchObject({ rate: { amountCents: 15000 }, creditCents: 10000 });
    expect((await ownerView()).body.summary).toEqual(mine.body.summary);
  });
});

describe("over time (the service, on a set clock)", () => {
  let link2: string;
  const at = (s: string) => new Date(`${s}T15:00:00Z`);
  const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => runAsOwner(fn);
  const set = (now: string, amountCents: number | null, startsOn?: string) =>
    run((tx) =>
      setRent(
        tx,
        {
          linkId: link2,
          amountCents,
          period: amountCents === null ? null : "WEEKLY",
          startsOn: startsOn ? new Date(`${startsOn}T00:00:00Z`) : null,
          userId: snowUserId,
        },
        "UTC",
        at(now),
      ),
    );
  const summary = (now: string) => run((tx) => rentSummary(tx, link2, "UTC", at(now)));
  const pendingRows = (now: string) =>
    run((tx) =>
      tx.boothRentRate.count({ where: { linkId: link2, voidedAt: null, startsOn: { gt: new Date(`${now}T00:00:00Z`) } } }),
    );

  beforeAll(async () => {
    link2 = (
      await run((tx) =>
        tx.teamLink.create({
          data: { teamShopId: team.id, memberShopId: strangerShopId, status: "ACTIVE", approvedAt: new Date() },
        }),
      )
    ).id;
  });

  it("🔴 a change takes effect next week; the weeks before keep their rate", async () => {
    expect(await set("2026-09-01", 10000, "2026-09-01")).toEqual({ ok: true, startsOn: "2026-09-01" });
    expect(await set("2026-09-10", 12000)).toEqual({ ok: true, startsOn: "2026-09-15" });
    expect(await summary("2026-09-10")).toMatchObject({
      rate: { amountCents: 10000 },
      scheduled: { amountCents: 12000, startsOn: "2026-09-15" },
      balanceCents: 20000,
    });
    const later = await summary("2026-09-16");
    expect(later.unpaid.map((u) => u.amountCents)).toEqual([10000, 10000, 12000]);
    expect(later.balanceCents).toBe(32000);
  });

  it("a stop ends it at the next week; nothing more comes due", async () => {
    expect(await set("2026-09-16", null)).toEqual({ ok: true, startsOn: "2026-09-22" });
    expect(await summary("2026-10-30")).toMatchObject({ current: null, rate: null, balanceCents: 32000 });
  });

  it("🔴 restarting needs a date, and can't reach back over what has happened", async () => {
    expect(await set("2026-10-30", 10000)).toEqual({ ok: false, error: "start_required" });
    expect(await set("2026-10-30", 10000, "2026-09-20")).toEqual({ ok: false, error: "start_before_history" });
    expect(await set("2026-10-30", 10000, "2025-09-01")).toEqual({ ok: false, error: "start_out_of_range" });
    expect((await set("2026-10-30", 10000, "2026-11-02")).ok).toBe(true);
    expect((await set("2026-10-30", 11000, "2026-11-09")).ok).toBe(true);
    // The second start replaced the first: it hadn't begun, so nothing was owed under it.
    expect((await summary("2026-10-30")).scheduled).toMatchObject({ amountCents: 11000, startsOn: "2026-11-09" });
    expect(await pendingRows("2026-10-30")).toBe(1);
    expect((await summary("2026-10-30")).balanceCents).toBe(32000);
    // Stopping before it starts cancels it.
    await set("2026-10-30", null);
    expect((await summary("2026-10-30")).scheduled).toBeNull();
  });

  it("🔴 two rent changes can't interleave: the second waits for the first", async () => {
    // Someone else holds this member's row. FOR SHARE: a lock that saving a
    // rent row alone wouldn't wait for, so only setRent's own lock - taken
    // BEFORE it reads - can make it wait. Without that lock, two changes both
    // read "nothing scheduled" and both write.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const first = run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "TeamLink" WHERE id = ${link2} FOR SHARE`;
      locked();
      await held;
    });
    await lockTaken;
    let done = false;
    const second = set("2026-11-02", 12000, "2026-11-23").then((r) => ((done = true), r));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    release();
    await first;
    expect((await second).ok).toBe(true);
    expect(await pendingRows("2026-11-02")).toBe(1);
  });
});
