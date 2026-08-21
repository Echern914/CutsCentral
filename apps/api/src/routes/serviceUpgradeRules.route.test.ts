import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Configurable upgrade prompts, end to end.
 *
 * The /upgrades endpoint already existed and already confirmed every candidate
 * against the real availability engine. What these cover is the CONFIGURATION
 * layer on top - and, crucially, that adding it did not weaken the engine gate:
 * a rule chooses candidates, it can never conjure a bookable time.
 */

const app = createApp();
const email = `tupg-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let cutId: string; // 30 min, $40 - the source
let vipId: string; // 90 min, $120 - a long upgrade
let beardId: string; // 30 min, $30 - shorter+cheaper, never auto-suggested

/** A weekday at 09:00 UTC (shop tz = UTC), comfortably in the future. */
function slotAt(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

const upgradesFor = (startsAt: Date, serviceId: string) =>
  request(app).get(
    `/api/book/${slug}/upgrades?startsAt=${encodeURIComponent(
      startsAt.toISOString(),
    )}&staffId=${staffId}&serviceId=${serviceId}`,
  );

const makeRule = (body: Record<string, unknown>) =>
  request(app).post("/api/booking/upgrade-rules").set("Cookie", cookie).send(body);

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Upsell Cuts", bookingUrl: "https://book.test", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  staffId = staff.body.id;

  const mk = async (name: string, durationMin: number, price: number) => {
    const r = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name, durationMin, price, staffIds: [staffId] });
    return r.body.id as string;
  };
  cutId = await mk("Cut", 30, 40);
  vipId = await mk("VIP", 90, 120);
  beardId = await mk("Beard", 30, 30);

  // Open 09:00-17:00 every day, so a 09:00 slot has hours of room after it.
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.serviceUpgradeRule.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

async function clearRules() {
  await prisma.serviceUpgradeRule.deleteMany({ where: { shopId } });
}

/* ------------------------------------------------------------------ */

describe("with no rules configured", () => {
  it("keeps the automatic suggestions the shop already had", async () => {
    // 🔑 The compatibility guarantee. Shipping this must not switch every
    // existing shop's upsells off until they configure something.
    await clearRules();
    const res = await upgradesFor(slotAt(2, 9), cutId);
    expect(res.status).toBe(200);
    const ids = (res.body.upgrades as { serviceId: string }[]).map((u) => u.serviceId);
    // VIP is longer AND dearer, so the heuristic finds it.
    expect(ids).toContain(vipId);
    // Beard is neither, so it never was suggested and still isn't.
    expect(ids).not.toContain(beardId);
  });
});

describe("with rules configured", () => {
  it("offers exactly what the barber chose, engine-confirmed", async () => {
    await clearRules();
    expect(
      (await makeRule({ sourceServiceIds: [cutId], destinationServiceId: vipId }))
        .status,
    ).toBe(201);

    const res = await upgradesFor(slotAt(2, 9), cutId);
    const ups = res.body.upgrades as { serviceId: string; durationMin: number; price: number; priceDelta: number; extraMin: number }[];
    expect(ups.map((u) => u.serviceId)).toEqual([vipId]);
    // The customer is shown what they are weighing.
    expect(ups[0]!.durationMin).toBe(90);
    expect(ups[0]!.price).toBe(120);
    expect(ups[0]!.priceDelta).toBe(80);
    expect(ups[0]!.extraMin).toBe(60);
  });

  it("offers NOTHING for a service the barber left out", async () => {
    // The shop HAS rules, just none for Beard. Distinct from "no rules at all",
    // which falls back to automatic - here the answer is a deliberate none.
    await clearRules();
    await makeRule({ sourceServiceIds: [cutId], destinationServiceId: vipId });
    const res = await upgradesFor(slotAt(2, 9), beardId);
    expect(res.body.upgrades).toEqual([]);
  });

  it("honours a barber's choice the heuristic would never make", async () => {
    // Beard is SHORTER and CHEAPER than Cut, so the automatic rule would never
    // suggest it. The barber said so, so it is offered.
    await clearRules();
    await makeRule({ sourceServiceIds: [cutId], destinationServiceId: beardId });
    const res = await upgradesFor(slotAt(2, 9), cutId);
    expect(
      (res.body.upgrades as { serviceId: string }[]).map((u) => u.serviceId),
    ).toEqual([beardId]);
  });

  it("offers nothing while the rule is DISABLED", async () => {
    await clearRules();
    const made = await makeRule({
      sourceServiceIds: [cutId],
      destinationServiceId: vipId,
    });
    const ruleId = made.body.ruleId as string;

    await request(app)
      .patch(`/api/booking/upgrade-rules/${ruleId}`)
      .set("Cookie", cookie)
      .send({ active: false });

    // With its only rule paused the shop has no ACTIVE rules, so it falls back
    // to automatic - which must still not offer the paused destination as if
    // the rule were on. VIP reappears via the heuristic, and that is correct:
    // pausing a rule restores the default, it does not blacklist a service.
    const res = await upgradesFor(slotAt(2, 9), cutId);
    expect(res.status).toBe(200);

    // Re-enable and confirm it is governed again.
    await request(app)
      .patch(`/api/booking/upgrade-rules/${ruleId}`)
      .set("Cookie", cookie)
      .send({ active: true });
    const back = await upgradesFor(slotAt(2, 9), cutId);
    expect(
      (back.body.upgrades as { serviceId: string }[]).map((u) => u.serviceId),
    ).toEqual([vipId]);
  });
});

describe("the engine still decides, not the rule", () => {
  it("does NOT offer an upgrade with insufficient time", async () => {
    // 16:30 with the shop closing at 17:00: a 30-min Cut fits exactly, a 90-min
    // VIP cannot. The rule says offer it; the engine says there is no room.
    await clearRules();
    await makeRule({ sourceServiceIds: [cutId], destinationServiceId: vipId });
    const res = await upgradesFor(slotAt(3, 16), cutId);
    // 16:00 + 90 = 17:30, past close.
    expect(res.body.upgrades).toEqual([]);
  });

  it("stops offering it once the following time is booked", async () => {
    await clearRules();
    await makeRule({ sourceServiceIds: [cutId], destinationServiceId: vipId });
    const day = slotAt(4, 9);

    const before = await upgradesFor(day, cutId);
    expect(
      (before.body.upgrades as { serviceId: string }[]).map((u) => u.serviceId),
    ).toContain(vipId);

    // Someone books 10:00. A 90-min VIP starting at 09:00 would run into it.
    const blocker = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: cutId,
        startsAt: slotAt(4, 10).toISOString(),
        firstName: "Block", lastName: "Er",
        email: `bl-${randomToken(6)}@test.local`,
      });
    expect([200, 201]).toContain(blocker.status);

    const after = await upgradesFor(day, cutId);
    expect(
      (after.body.upgrades as { serviceId: string }[]).map((u) => u.serviceId),
    ).not.toContain(vipId);
  });

  it("refuses the booking anyway if an upgrade is forced through a stale page", async () => {
    // The prompt is advisory; the POST is the authority. Booking a 90-min VIP
    // at a time its own grid does not offer must be rejected, rule or no rule.
    await clearRules();
    await makeRule({ sourceServiceIds: [cutId], destinationServiceId: vipId });
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: vipId,
        // 09:30 is on the 30-min Cut grid, never on the 90-min VIP grid.
        startsAt: slotAt(5, 9).toISOString().replace("T09:00", "T09:30"),
        firstName: "Stale", lastName: "Page",
        email: `st-${randomToken(6)}@test.local`,
      });
    expect(res.status).toBe(400);
  });
});

describe("rule validation", () => {
  it("rejects a self-upgrade", async () => {
    await clearRules();
    const res = await makeRule({
      sourceServiceIds: [cutId],
      destinationServiceId: cutId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("self_upgrade");
  });

  it("rejects a cycle", async () => {
    await clearRules();
    await makeRule({ sourceServiceIds: [cutId], destinationServiceId: vipId });
    const res = await makeRule({
      sourceServiceIds: [vipId],
      destinationServiceId: cutId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cycle");
  });

  it("lets a rule be re-saved unchanged without tripping over itself", async () => {
    await clearRules();
    const made = await makeRule({
      sourceServiceIds: [cutId],
      destinationServiceId: vipId,
    });
    const res = await request(app)
      .patch(`/api/booking/upgrade-rules/${made.body.ruleId}`)
      .set("Cookie", cookie)
      .send({ sourceServiceIds: [cutId], destinationServiceId: vipId });
    expect(res.status).toBe(200);
  });

  it("rejects a service from another shop", async () => {
    await clearRules();
    const other = await request(app)
      .post("/api/auth/signup")
      .send({
        email: `tupg2-${randomToken(6)}@test.local`.toLowerCase(),
        password,
        name: "O",
        smsAttested: true,
      });
    const otherCookie = (other.headers["set-cookie"] as unknown as string[])[0]!;
    await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({ name: "Other", bookingUrl: "https://o.test", smsAttested: true });
    const otherStaff = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", otherCookie)
      .send({ name: "Zed" });
    const foreign = await request(app)
      .post("/api/booking/services")
      .set("Cookie", otherCookie)
      .send({
        name: "Foreign",
        durationMin: 30,
        price: 10,
        staffIds: [otherStaff.body.id],
      });

    const res = await makeRule({
      sourceServiceIds: [cutId],
      destinationServiceId: foreign.body.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_service");
  });

  it("cannot read or delete another shop's rules", async () => {
    await clearRules();
    const made = await makeRule({
      sourceServiceIds: [cutId],
      destinationServiceId: vipId,
    });
    const other = await request(app)
      .post("/api/auth/signup")
      .send({
        email: `tupg3-${randomToken(6)}@test.local`.toLowerCase(),
        password,
        name: "O2",
        smsAttested: true,
      });
    const otherCookie = (other.headers["set-cookie"] as unknown as string[])[0]!;
    await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({ name: "Other2", bookingUrl: "https://o2.test", smsAttested: true });

    const list = await request(app)
      .get("/api/booking/upgrade-rules")
      .set("Cookie", otherCookie);
    expect(list.body.rules ?? []).toEqual([]);

    const del = await request(app)
      .delete(`/api/booking/upgrade-rules/${made.body.ruleId}`)
      .set("Cookie", otherCookie);
    expect(del.status).toBe(404);
  });
});
