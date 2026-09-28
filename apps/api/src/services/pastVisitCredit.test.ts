import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { creditPastVisits } from "./pastVisitCredit.js";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * #516: CREDITING PAST VISITS IS THE OWNER'S CHOICE, PREVIEWED FIRST.
 *
 * Visits that ended before rewards started earn nothing by themselves. The
 * owner picks 3, 6 or 12 months before the start, sees "N visits: P punches to
 * C customers", and only a confirm writes it - by the same earn rules as any
 * visit (its card, the punches per visit, a promotion running the day it
 * ended), never twice, and never twice when two confirms race. That it sends
 * nobody anything is pinned in importedHistoryMessages.test.ts, where the
 * customers have consent and a push subscription to be reached by.
 */
const app = createApp();
const email = `pvc-${randomToken(6)}@test.local`.toLowerCase();
const DAY = 86_400_000;
/** Rewards started a day ago - fixed for the whole file. */
const START = new Date(Date.now() - DAY);
const before = (days: number) => new Date(START.getTime() - days * DAY);

let cookie = "";
let userId = "";
let shopId = "";
let colorCardId = "";
const c: Record<"one" | "two", string> = { one: "", two: "" };
const v: Record<string, string> = {};

async function visit(
  key: string,
  clientId: string,
  end: Date,
  over: { serviceName?: string | null; status?: "COMPLETED" | "CANCELED" | "SCHEDULED"; noEndAt?: boolean } = {},
) {
  const row = await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `manual:${randomToken(8)}`,
      status: over.status ?? "COMPLETED",
      scheduledAt: over.noEndAt ? end : new Date(end.getTime() - 30 * 60_000),
      endAt: over.noEndAt ? null : end,
      completedAt: (over.status ?? "COMPLETED") === "COMPLETED" ? end : null,
      canceledAt: over.status === "CANCELED" ? end : null,
      serviceName: over.serviceName === undefined ? "Standard" : over.serviceName,
    },
  });
  v[key] = row.id;
}

/** Every ledger row a visit has - an earn is at most one. */
const rowsFor = (visitId: string) => prisma.punchLedger.findMany({ where: { visitId } });

async function balance(clientId: string, cardTypeId: string | null) {
  const agg = await prisma.punchLedger.aggregate({
    where: { shopId, clientId, cardTypeId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "P", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Past Credit", bookingUrl: "https://past.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  userId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ rewardsEnabled: true });
  await prisma.shop.update({ where: { id: shopId }, data: { rewardsStartedAt: START } });

  // A second card that earns 3 a visit, and a promotion that added 1 a visit
  // for ten days - long before rewards started.
  colorCardId = (
    await prisma.cardType.create({
      data: { shopId, name: "Color", serviceMatch: ["color"], punchesPerVisit: 3 },
    })
  ).id;
  await prisma.promotion.create({
    data: {
      shopId,
      kind: "EXTRA_PUNCHES",
      title: "Bonus week",
      extraPunches: 1,
      active: true,
      startsAt: before(45),
      endsAt: before(35),
    },
  });

  for (const key of ["one", "two"] as const) {
    c[key] = (
      await prisma.client.create({
        data: { shopId, acuityClientKey: `pvc-${key}-${randomToken(6)}`, magicToken: randomToken(), firstName: key },
      })
    ).id;
  }

  // Inside 3 months before the start, never punched: these are the credit.
  await visit("recent", c.one, before(10)); // 1 punch
  await visit("color", c.one, before(40), { serviceName: "Color refresh" }); // 3 + 1 promo
  await visit("noEnd", c.two, before(80), { serviceName: null, noEndAt: true }); // 1, by its start
  // Only inside 6 months.
  await visit("older", c.two, before(120)); // 1
  // Never credited: already punched, cancelled, not completed, after the start.
  await visit("punched", c.one, before(20));
  await prisma.punchLedger.create({
    data: { shopId, clientId: c.one, visitId: v.punched!, punchesEarned: 1, runningBalance: 1, note: "visit" },
  });
  await visit("cancelled", c.two, before(15), { status: "CANCELED" });
  await visit("scheduled", c.one, before(5), { status: "SCHEDULED" });
  await visit("after", c.two, new Date(START.getTime() + 6 * 3_600_000));
});

afterAll(async () => {
  if (userId) {
    await prisma.shop.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

describe("the preview", () => {
  it("counts the visits, punches and customers a credit would give - and writes nothing", async () => {
    const ledgerBefore = await prisma.punchLedger.count({ where: { shopId } });
    const res = await request(app).get("/api/loyalty/past-visits?months=3").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ visits: 3, punches: 6, customers: 2, startedAt: START.toISOString() });
    expect(await prisma.punchLedger.count({ where: { shopId } })).toBe(ledgerBefore);
  });

  it("reaches further back for 6 months, and takes only 3, 6 or 12", async () => {
    const six = await request(app).get("/api/loyalty/past-visits?months=6").set("Cookie", cookie);
    expect(six.body).toMatchObject({ visits: 4, punches: 7, customers: 2 });
    const odd = await request(app).get("/api/loyalty/past-visits?months=4").set("Cookie", cookie);
    expect(odd.status).toBe(400);
  });
});

describe("confirming", () => {
  it("credits exactly what the preview showed, by the normal earn rules", async () => {
    const res = await request(app)
      .post("/api/loyalty/past-visits/credit")
      .set("Cookie", cookie)
      .send({ months: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ visits: 3, punches: 6, customers: 2 });

    expect((await rowsFor(v.recent!)).map((r) => [r.punchesEarned, r.cardTypeId])).toEqual([[1, null]]);
    expect((await rowsFor(v.color!)).map((r) => [r.punchesEarned, r.cardTypeId])).toEqual([[4, colorCardId]]);
    expect((await rowsFor(v.noEnd!)).map((r) => r.punchesEarned)).toEqual([1]);
    // Left alone: the one already punched keeps its single earn; the rest have none.
    expect(await rowsFor(v.punched!)).toHaveLength(1);
    for (const key of ["older", "cancelled", "scheduled", "after"]) {
      expect(await rowsFor(v[key]!)).toHaveLength(0);
    }
    expect(await balance(c.one, null)).toBe(2); // 1 already earned + 1 credited
    expect(await balance(c.one, colorCardId)).toBe(4);
    expect(await balance(c.two, null)).toBe(1);
  });

  it("a second confirm finds nothing left and changes nothing", async () => {
    const ledgerBefore = await prisma.punchLedger.count({ where: { shopId } });
    expect(await creditPastVisits(shopId, 3, "preview")).toMatchObject({ visits: 0, punches: 0, customers: 0 });
    expect(await creditPastVisits(shopId, 3, "credit")).toMatchObject({ visits: 0, punches: 0, customers: 0 });
    expect(await prisma.punchLedger.count({ where: { shopId } })).toBe(ledgerBefore);
  });

  it("with rewards off there is nothing to credit", async () => {
    await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ rewardsEnabled: false });
    const res = await request(app).get("/api/loyalty/past-visits?months=6").set("Cookie", cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rewards_off");
    const post = await request(app).post("/api/loyalty/past-visits/credit").set("Cookie", cookie).send({ months: 6 });
    expect(post.status).toBe(409);
    expect(await rowsFor(v.older!)).toHaveLength(0);
  });
});

describe("two confirms at the same moment", () => {
  it("two confirms racing each other credit each visit once", async () => {
    const shop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Race Credit",
        slug: `pvc-race-${randomToken(5)}`,
        webhookSecret: randomToken(),
        rewardsEnabled: true,
        rewardsStartedAt: START,
      },
    });
    const client = await prisma.client.create({
      data: { shopId: shop.id, acuityClientKey: `pvc-race-${randomToken(6)}`, magicToken: randomToken() },
    });
    const ids: string[] = [];
    for (const days of [10, 30]) {
      const row = await prisma.visit.create({
        data: {
          shopId: shop.id,
          clientId: client.id,
          acuityAppointmentId: `manual:${randomToken(8)}`,
          status: "COMPLETED",
          scheduledAt: before(days),
          endAt: before(days),
        },
      });
      ids.push(row.id);
    }

    // Hold the customer's row: both confirms must queue behind it.
    const { results, settledEarly } = await raceBehindRowLock("Client", client.id, [
      () => creditPastVisits(shop.id, 3, "credit"),
      () => creditPastVisits(shop.id, 3, "credit"),
    ]);
    expect(settledEarly).toBe(0);
    const done = winners(results);
    expect(done).toHaveLength(2); // neither confirm fails
    const credited = done.map((r) => (r.ok ? r.visits : -1)).sort();
    expect(credited).toEqual([0, 2]); // one credits both visits, the other finds them done
    expect(await prisma.punchLedger.count({ where: { visitId: { in: ids } } })).toBe(2);

    // And the ledger itself refuses a second earn for a visit.
    await expect(
      prisma.punchLedger.create({
        data: { shopId: shop.id, clientId: client.id, visitId: ids[0]!, punchesEarned: 1, runningBalance: 3, note: "visit" },
      }),
    ).rejects.toThrow();
  });
});
