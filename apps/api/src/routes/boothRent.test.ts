import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, runAsOwner, type Prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { rentSummary, setRent, voidRate as voidRateEntry } from "../services/boothRent.js";

/**
 * Booth rent: a manual tracker between a team's owner and one independent
 * member. What must hold, because it's money:
 *  - rent starts on a date the owner chose, and nothing is owed before it;
 *  - payments pay the OLDEST unpaid period first, so a missed week can't hide
 *    behind this week's payment; over-paying shows as a credit;
 *  - a change takes effect next period - the past keeps its rate;
 *  - a mistake is voided, never deleted; a form sent twice records once;
 *  - only the team's owner writes, and the member sees the very same numbers;
 *  - leaving stops the rent, keeps what's owed, and both sides can still read
 *    it; rejoining bills nothing for the time away;
 *  - a void never removes a stop or an earlier obligation.
 *
 * THE CLOCK IS PINNED: Thursday 2026-09-24, 15:00 UTC (the team shop runs on
 * UTC). Rent starts Thursday Sep 10, and periods run from the start date, not
 * the calendar week: Sep 10-16, Sep 17-23, Sep 24-30 (today's), then Oct 1-7.
 * A period is owed in full from its first day. So "three weeks due" below is
 * the same on whatever day the suite runs.
 */
const TODAY = "2026-09-24";
vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T15:00:00Z`) });

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
/** The team shop's calendar day `n` days from the pinned today (Sep 24). */
const dayOffset = (n: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

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
  vi.useRealTimers();
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

  it("changing it again before it starts replaces the pending change - and the history shows both", async () => {
    const res = await putRent(snowCookie, { amountCents: 18000, period: "WEEKLY" });
    expect(res.body.rent.scheduled).toMatchObject({ amountCents: 18000, startsOn: dayOffset(7) });
    const rates = (await ownerView()).body.rates as { amountCents: number; startsOn: string; status: string }[];
    expect(rates.map((r) => [r.amountCents, r.startsOn, r.status])).toEqual([
      [15000, dayOffset(-14), "active"],
      [20000, dayOffset(7), "replaced"],
      [18000, dayOffset(7), "active"],
    ]);
  });

  it("🔴 a mistyped rent is voided - the latest entry only - and stays in the history, dated", async () => {
    type Rate = { id: string; amountCents: number; status: string; voidedOn: string | null };
    const [start, , change] = (await ownerView()).body.rates as Rate[];
    expect((await voidRate(joeCookie, change!.id)).status).toBe(404);
    // Undo one step at a time: the older entry can't go while a newer one stands.
    const early = await voidRate(snowCookie, start!.id);
    expect([early.status, early.body.error]).toEqual([409, "not_latest"]);

    // Voiding the $180 change brings back the $200 it replaced: an undo.
    expect((await voidRate(snowCookie, change!.id)).body.rent.scheduled).toMatchObject({ amountCents: 20000 });
    const raise = ((await ownerView()).body.rates as Rate[]).find((r) => r.amountCents === 20000)!;
    expect((await voidRate(snowCookie, raise.id)).body.rent.scheduled).toBeNull();
    // The start itself was the mistake: void it, and enter it again.
    const none = await voidRate(snowCookie, start!.id);
    expect(none.body.rent).toMatchObject({ rate: null, balanceCents: 0, creditCents: 55000 });
    const fixed = await putRent(snowCookie, { amountCents: 15000, period: "WEEKLY", startsOn: dayOffset(-14) });
    expect(fixed.body.rent).toMatchObject({ rate: { amountCents: 15000 }, balanceCents: 0, creditCents: 10000 });

    const rates = (await ownerView()).body.rates as Rate[];
    expect(rates.map((r) => [r.amountCents, r.status, r.voidedOn])).toEqual([
      [15000, "voided", TODAY],
      [15000, "active", null],
      [20000, "voided", TODAY],
      [18000, "voided", TODAY],
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

describe("the live checklist, exactly: $1 a week from Thu Sep 17, checked Thu Sep 24", () => {
  // Two periods have begun (Sep 17-23, Sep 24-30), so $2 is owed. Pay $1, pay
  // $3 (a $2 credit), void the $3: $2 - $1 = $1 is owed again - on BOTH sides.
  let seqLink: string;
  let seqCookie: string;
  const url = (path: string) => `/api/team/links/${seqLink}${path}`;
  const bothSides = async () => {
    const [ownerList, ownerHistory, memberList, memberHistory] = await Promise.all([
      request(app).get("/api/team/links").set("Cookie", snowCookie),
      request(app).get(url("/rent")).set("Cookie", snowCookie),
      request(app).get("/api/teams").set("Cookie", seqCookie),
      request(app).get(`/api/teams/${seqLink}/rent`).set("Cookie", seqCookie),
    ]);
    const ownerCard = ownerList.body.active.find((a: { id: string }) => a.id === seqLink).rent;
    const memberCard = memberList.body.links.find((l: { id: string }) => l.id === seqLink).rent;
    // Four views, one set of numbers.
    expect(ownerHistory.body.summary).toEqual(ownerCard);
    expect(memberCard).toEqual(ownerCard);
    expect(memberHistory.body.summary).toEqual(ownerCard);
    return ownerCard as { balanceCents: number; creditCents: number; unpaid: { start: string; dueCents: number }[] };
  };
  const payDollars = (dollars: number) =>
    request(app)
      .post(url("/rent/payments"))
      .set("Cookie", snowCookie)
      .send({ amountCents: dollars * 100, date: TODAY, method: "cash", clientRef: randomToken(8) });

  beforeAll(async () => {
    seqCookie = await signup(`rent-seq-${tag}@test.chairback`, "Seq");
    await createShop(seqCookie, `Rent Seq ${tag}`);
    seqLink = (await request(app).post("/api/teams/join").set("Cookie", seqCookie).send({ team: team.id })).body.id;
    await request(app).post(url("/approve")).set("Cookie", snowCookie);
  });

  it("🔴 $2 owed, pay $1, pay $3, void the $3: $1 is still owed on the owner's and the barber's views", async () => {
    const start = await request(app)
      .put(url("/rent"))
      .set("Cookie", snowCookie)
      .send({ amountCents: 100, period: "WEEKLY", startsOn: "2026-09-17" });
    expect(start.status).toBe(200);
    expect(await bothSides()).toMatchObject({ balanceCents: 200, creditCents: 0 });

    expect((await payDollars(1)).status).toBe(201);
    const afterOne = await bothSides();
    expect(afterOne).toMatchObject({ balanceCents: 100, creditCents: 0 });
    // The $1 cleared the OLDER week; this week is the one still due.
    expect(afterOne.unpaid).toEqual([expect.objectContaining({ start: "2026-09-24", dueCents: 100 })]);

    const three = await payDollars(3);
    expect(three.status).toBe(201);
    expect(await bothSides()).toMatchObject({ balanceCents: 0, creditCents: 200 });

    const history = await request(app).get(url("/rent")).set("Cookie", snowCookie);
    const threeId = history.body.payments.find((p: { amountCents: number }) => p.amountCents === 300).id;
    expect((await request(app).post(url(`/rent/payments/${threeId}/void`)).set("Cookie", snowCookie)).status).toBe(200);
    const afterVoid = await bothSides();
    expect(afterVoid).toMatchObject({ balanceCents: 100, creditCents: 0 });
    expect(afterVoid.unpaid).toEqual([expect.objectContaining({ start: "2026-09-24", dueCents: 100 })]);
  });
});

describe("leaving", () => {
  it("🔴 rent stops at the end of this week; what's owed and every payment stay", async () => {
    expect((await request(app).post(`/api/teams/${linkId}/leave`).set("Cookie", joeCookie)).status).toBe(200);
    const mine = await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", joeCookie);
    const active = (mine.body.rates as { amountCents: number | null; startsOn: string; status: string }[]).filter(
      (r) => r.status === "active",
    );
    // This week (Sep 24-30) is still owed; nothing from Oct 1.
    expect(active.at(-1)).toMatchObject({ amountCents: null, startsOn: "2026-10-01" });
    expect(mine.body.payments).toHaveLength(4);
    expect(mine.body.summary).toMatchObject({ rate: { amountCents: 15000 }, creditCents: 10000 });
    expect((await ownerView()).body.summary).toEqual(mine.body.summary);
  });

  it("🔴 both sides still see the record - the rent, and nothing else of the other business", async () => {
    const owner = await request(app).get("/api/team/links").set("Cookie", snowCookie);
    const mine = await request(app).get("/api/teams").set("Cookie", joeCookie);
    const ownerPast = owner.body.past.find((p: { id: string }) => p.id === linkId);
    const myPast = mine.body.past.find((p: { id: string }) => p.id === linkId);
    expect(Object.keys(ownerPast).sort()).toEqual(["business", "endedAt", "id", "rent", "status"]);
    expect(ownerPast.business).toEqual({ name: `Rent Joe ${tag}` });
    expect(Object.keys(myPast).sort()).toEqual(["endedAt", "id", "rent", "team"]);
    expect(myPast.team).toEqual({ name: `Rent Team ${tag}` });
    expect(myPast.rent).toEqual(ownerPast.rent);
    expect(myPast.rent.creditCents).toBe(10000);
    // Not on the team any more: no numbers, no sharing, no card.
    expect(owner.body.active.find((a: { id: string }) => a.id === linkId)).toBeUndefined();
    expect(mine.body.links.find((l: { id: string }) => l.id === linkId)).toBeUndefined();
  });

  it("🔴 the owner can still settle it: a late payment, and a correction - audited, and both sides agree", async () => {
    const late = await pay(snowCookie, { amountCents: 5000, note: "paid after leaving" });
    expect(late.status).toBe(201);
    expect(late.body.rent).toMatchObject({ creditCents: 15000, rate: { amountCents: 15000 } });
    const mine = await request(app).get("/api/teams").set("Cookie", joeCookie);
    expect(mine.body.past.find((p: { id: string }) => p.id === linkId).rent).toEqual(late.body.rent);

    // Entered by mistake: void it. It stays in both histories, dated.
    const lateId = (await ownerView()).body.payments.find((p: { note: string | null }) => p.note === "paid after leaving").id;
    expect((await voidPayment(snowCookie, lateId)).body.rent.creditCents).toBe(10000);
    const theirs = await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", joeCookie);
    expect(theirs.body.payments.find((p: { id: string }) => p.id === lateId)).toMatchObject({ voided: true, voidedOn: TODAY });
    expect(theirs.body).toEqual((await ownerView()).body);
    expect(await paymentRows()).toBe(5);
  });

  it("🔴 settling never restarts rent, restores the team, or opens anything else", async () => {
    // Rent can't be started or changed on it...
    expect((await putRent(snowCookie, { amountCents: 100, period: "WEEKLY" })).status).toBe(404);
    // ...the stop that ended it can't be voided...
    const rates = (await ownerView()).body.rates as { id: string; amountCents: number | null; status: string }[];
    const stop = rates.find((r) => r.amountCents === null && r.status === "active")!;
    expect((await voidRate(snowCookie, stop.id)).body.error).toBe("stop_not_voidable");
    // ...still ENDED, still no card, no numbers, no sharing - only the rent.
    const row = await runAsOwner((tx) => tx.teamLink.findUniqueOrThrow({ where: { id: linkId } }));
    expect(row.status).toBe("ENDED");
    const owner = await request(app).get("/api/team/links").set("Cookie", snowCookie);
    expect(owner.body.active.find((a: { id: string }) => a.id === linkId)).toBeUndefined();
    expect(Object.keys(owner.body.past.find((p: { id: string }) => p.id === linkId)).sort()).toEqual([
      "business",
      "endedAt",
      "id",
      "rent",
      "status",
    ]);
    // Nothing is owed after Sep 30: the rent still stops Oct 1.
    expect((await ownerView()).body.summary.unpaid).toEqual([]);
  });

  it("🔴 the former member only reads; strangers get nothing", async () => {
    for (const cookie of [joeCookie, strangerCookie]) {
      expect((await pay(cookie, { amountCents: 100 })).status).toBe(404);
    }
    expect((await pay(managerCookie, { amountCents: 100 })).status).toBe(403);
    expect((await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", strangerCookie)).status).toBe(404);
  });

  it("a link that ended with no rent ever recorded has nothing to settle", async () => {
    const cookie = await signup(`rent-norent-${tag}@test.chairback`, "NoRent");
    await createShop(cookie, `Rent NoRent ${tag}`);
    const id = (await request(app).post("/api/teams/join").set("Cookie", cookie).send({ team: team.id })).body.id;
    await request(app).post(`/api/team/links/${id}/end`).set("Cookie", snowCookie);
    const res = await request(app)
      .post(`/api/team/links/${id}/rent/payments`)
      .set("Cookie", snowCookie)
      .send({ amountCents: 100, date: TODAY, method: "cash", clientRef: randomToken(8) });
    expect(res.status).toBe(404);
  });
});

describe("rejoining", () => {
  afterAll(() => vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`)));

  it("🔴 bills nothing for the time away, and the record carries on in one piece", async () => {
    // Oct 10: the stop took effect Oct 1; Joe asks to come back.
    vi.setSystemTime(new Date("2026-10-10T15:00:00Z"));
    expect((await request(app).post("/api/teams/join").set("Cookie", joeCookie).send({ team: team.id })).status).toBe(201);
    // Asking again: the owner still sees the rent record while deciding.
    const asking = await request(app).get("/api/team/links").set("Cookie", snowCookie);
    expect(asking.body.past.find((p: { id: string }) => p.id === linkId)).toMatchObject({ status: "PENDING" });
    expect((await request(app).post(`/api/team/links/${linkId}/approve`).set("Cookie", snowCookie)).status).toBe(200);

    const back = (await ownerView()).body.summary;
    // Still three weeks owed (Sep 10-30) - no Oct 1-7 or Oct 8-14 appeared.
    expect(back).toMatchObject({ rate: null, current: null, balanceCents: 0, creditCents: 10000 });
    expect(back.earliestStart).toBe("2026-10-10");
  });

  it("🔴 rent restarts only from the day they were approved again", async () => {
    for (const startsOn of ["2026-10-01", "2026-10-09"]) {
      const early = await putRent(snowCookie, { amountCents: 15000, period: "WEEKLY", startsOn });
      expect([early.status, early.body.error]).toEqual([400, "start_too_early"]);
    }
    const res = await putRent(snowCookie, { amountCents: 15000, period: "WEEKLY", startsOn: "2026-10-10" });
    expect(res.body.rent).toMatchObject({
      rate: { amountCents: 15000, since: "2026-10-10" },
      current: { start: "2026-10-10", end: "2026-10-16" },
      creditCents: 0,
      balanceCents: 5000,
    });
  });

  it("🔴 a stop can't be voided - it would bill the time away", async () => {
    const rates = (await ownerView()).body.rates as { id: string; amountCents: number | null; status: string }[];
    const stop = rates.find((r) => r.amountCents === null && r.status === "active")!;
    const res = await voidRate(snowCookie, stop.id);
    expect([res.status, res.body.error]).toEqual([409, "stop_not_voidable"]);
  });

  it("🔴 voiding the restart takes back only the restart: the time away stays unbilled", async () => {
    const rates = (await ownerView()).body.rates as { id: string; startsOn: string; status: string }[];
    const restart = rates.find((r) => r.startsOn === "2026-10-10" && r.status === "active")!;
    const res = await voidRate(snowCookie, restart.id);
    expect(res.body.rent).toMatchObject({ rate: null, balanceCents: 0, creditCents: 10000 });
    // And both sides agree.
    const mine = await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", joeCookie);
    expect(mine.body).toEqual((await ownerView()).body);
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
    // Not before the stop (Sep 22), nor before this link was approved (Sep 24).
    expect(await set("2026-10-30", 10000, "2026-09-20")).toEqual({ ok: false, error: "start_too_early" });
    expect(await set("2026-10-30", 10000, "2026-09-23")).toEqual({ ok: false, error: "start_too_early" });
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

describe("corrections (the service, on a set clock)", () => {
  let link3: string;
  const at = (s: string) => new Date(`${s}T15:00:00Z`);
  const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => runAsOwner(fn);
  const set = (now: string, amountCents: number | null, startsOn?: string) =>
    run((tx) =>
      setRent(
        tx,
        {
          linkId: link3,
          amountCents,
          period: amountCents === null ? null : "WEEKLY",
          startsOn: startsOn ? new Date(`${startsOn}T00:00:00Z`) : null,
          userId: snowUserId,
        },
        "UTC",
        at(now),
      ),
    );
  const summary = (now: string) => run((tx) => rentSummary(tx, link3, "UTC", at(now)));
  const latestId = () =>
    run(async (tx) => {
      const rows = await tx.boothRentRate.findMany({
        where: { linkId: link3, voidedAt: null },
        orderBy: [{ startsOn: "desc" }, { createdAt: "desc" }],
        take: 1,
      });
      return rows[0]!.id;
    });
  const voidLatest = async () => run(async (tx) => voidRateEntry(tx, link3, await latestId(), snowUserId));

  beforeAll(async () => {
    const cookie = await signup(`rent-y-${tag}@test.chairback`, "Why");
    const member = await createShop(cookie, `Rent Why ${tag}`);
    link3 = (
      await run((tx) =>
        tx.teamLink.create({
          data: {
            teamShopId: team.id,
            memberShopId: member.id,
            status: "ACTIVE",
            approvedAt: new Date("2026-08-01T12:00:00Z"),
          },
        }),
      )
    ).id;
  });

  it("🔴 voiding a change keeps every earlier obligation; its weeks go back to the rate before", async () => {
    // $100/week from Tue Sep 1; a change to $120 from Sep 15 (made Sep 10).
    await set("2026-09-01", 10000, "2026-09-01");
    await set("2026-09-10", 12000);
    expect((await summary("2026-09-23")).unpaid.map((u) => u.amountCents)).toEqual([10000, 10000, 12000, 12000]);
    expect(await voidLatest()).toEqual({ ok: true });
    // Sep 1 and Sep 8 are untouched; Sep 15 and 22 are back at $100.
    expect((await summary("2026-09-23")).unpaid.map((u) => [u.start, u.amountCents])).toEqual([
      ["2026-09-01", 10000],
      ["2026-09-08", 10000],
      ["2026-09-15", 10000],
      ["2026-09-22", 10000],
    ]);
  });

  it("🔴 a same-day restart after a stop is an undo; voiding it brings the stop back, never a gap", async () => {
    expect(await set("2026-09-23", null)).toEqual({ ok: true, startsOn: "2026-09-29" });
    expect((await voidLatest())).toEqual({ ok: false, error: "stop_not_voidable" });
    // Oct 5: the stop took effect Sep 29. Restarting ON the stop's day undoes it...
    expect(await set("2026-10-05", 11000, "2026-09-29")).toEqual({ ok: true, startsOn: "2026-09-29" });
    expect((await summary("2026-10-05")).unpaid.map((u) => u.start)).toContain("2026-09-29");
    // ...and voiding that restart puts the stop back: Sep 29 on is unbilled again.
    expect(await voidLatest()).toEqual({ ok: true });
    const after = await summary("2026-10-05");
    expect(after.rate).toBeNull();
    expect(after.unpaid.map((u) => u.start)).not.toContain("2026-09-29");
  });
});
