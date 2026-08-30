import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import {
  FEATURE_INDEX,
  availableToBarberSeat,
  featureById,
} from "@chairback/config/features";
import { MILESTONE_IDS } from "../engines/readiness.js";

/**
 * GET /api/readiness and /summary.
 *
 * The engine's rules are exercised exhaustively and without a database in
 * engines/readiness.test.ts. What is tested HERE is everything that only exists
 * once a real request, a real session and a real schema are involved:
 *   - the fact collector reads what it claims to (a shop configured through the
 *     ordinary API endpoints comes back complete),
 *   - role scoping - a BARBER sees their chair and nothing else,
 *   - tenant isolation,
 *   - the deliberate absence of the billing wall,
 *   - that both routes are genuinely READ-ONLY, and
 *   - that neither response carries customer or contact data.
 */
const app = createApp();

const password = "correct horse battery staple";
const emails: string[] = [];
let lastInviteToken: string | null = null;

let ownerCookie: string;
let ownerEmail: string;
let shopId: string;
let staffId: string;
let serviceId: string;

/** A second, unrelated shop - the isolation control. */
let otherCookie: string;
let otherShopId: string;

const ORIGINAL_STRIPE = process.env.STRIPE_SECRET_KEY;

async function signup(email: string, name = "Person"): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function readiness(cookie: string) {
  const res = await request(app).get("/api/readiness").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body;
}

/** The wire shape of one item - the subset these tests assert on. */
interface WireItem {
  id: string;
  klass: string;
  applicable: boolean;
  done: boolean;
  blocksLaunch: boolean;
  role: string;
}

const itemById = (body: { items: WireItem[] }, id: string): WireItem | undefined =>
  body.items.find((i) => i.id === id);

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    const m = /token=([^\s&]+)/.exec(input.text ?? "");
    if (m) lastInviteToken = decodeURIComponent(m[1]!);
    return { id: "TEST", status: "sent" as const };
  });

  ownerEmail = `rdy-o-${randomToken(6).toLowerCase()}@test.chairback`;
  ownerCookie = await signup(ownerEmail, "Owner");
  expect(
    (
      await request(app)
        .post("/api/shops")
        .set("Cookie", ownerCookie)
        .send({ name: "Readiness Cuts", smsAttested: true })
    ).status,
  ).toBe(201);

  // Configure the shop the way a barber actually would - through the real
  // endpoints - so the collector is proven against rows the product writes.
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({
      bookingMode: "native",
      timezone: "UTC",
      bookingLeadHours: 2,
      bookingMaxDays: 60,
      notifyPhone: "+13025550123",
    });

  const me = await request(app).get("/api/shops/me").set("Cookie", ownerCookie);
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name: "Dre" });
  staffId = staff.body.id;

  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", ownerCookie)
    .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = svc.body.id;

  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", ownerCookie)
    .send({
      rules: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });

  // A second shop that must never appear in the first one's report.
  const otherEmail = `rdy-x-${randomToken(6).toLowerCase()}@test.chairback`;
  otherCookie = await signup(otherEmail, "Other");
  await request(app)
    .post("/api/shops")
    .set("Cookie", otherCookie)
    .send({ name: "Someone Else Cuts", smsAttested: true });
  const otherMe = await request(app).get("/api/shops/me").set("Cookie", otherCookie);
  otherShopId = otherMe.body.id;
  await prisma.staff.create({ data: { shopId: otherShopId, name: "Not Yours" } });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  if (ORIGINAL_STRIPE === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE;
  __resetEnvCacheForTests();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("the owner report", () => {
  it("reads a really-configured shop as nearly ready", async () => {
    const body = await readiness(ownerCookie);
    expect(body.scope).toBe("shop");
    expect(body.shopId).toBe(shopId);
    // Every rule that reads a row the product wrote must be satisfied.
    for (const id of [
      "shop.name",
      "shop.timezone",
      "shop.slug",
      "shop.booking_source",
      "shop.staff.active",
      "shop.service.active",
      "shop.service.duration",
      "shop.offering.pair",
      "shop.availability.rule",
      "shop.booking.window",
    ]) {
      expect(itemById(body, id), `missing item ${id}`).toBeDefined();
      expect(itemById(body, id)!.done, `${id} should be done`).toBe(true);
    }
  });

  it("always returns exactly four milestones in a stable order", async () => {
    const body = await readiness(ownerCookie);
    expect(body.milestones).toHaveLength(4);
    expect(body.milestones.map((m: { id: string }) => m.id)).toEqual([...MILESTONE_IDS]);
    expect(body.milestonesComplete + body.milestonesBlocking).toBe(4);
    expect(body.milestonesComplete).toBeGreaterThanOrEqual(0);
    expect(body.milestonesComplete).toBeLessThanOrEqual(4);
  });

  it("carries the detailed counts the Settings view needs", async () => {
    const body = await readiness(ownerCookie);
    expect(body.applicableRequiredCount).toBeGreaterThan(0);
    expect(body.completeRequiredCount).toBeLessThanOrEqual(body.applicableRequiredCount);
    // Only required + APPLICABLE conditional are counted.
    const counted = body.items.filter(
      (i: { applicable: boolean; klass: string }) =>
        i.applicable && (i.klass === "required" || i.klass === "conditional"),
    );
    expect(body.applicableRequiredCount).toBe(counted.length);
  });

  it("reports per-chair readiness", async () => {
    const body = await readiness(ownerCookie);
    expect(body.staff).toHaveLength(1);
    expect(body.staff[0].staffId).toBe(staffId);
    expect(body.staff[0].name).toBe("Dre");
  });

  it("summary is the cheap four-milestone shape", async () => {
    const res = await request(app)
      .get("/api/readiness/summary")
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("shop");
    expect(res.body.milestonesTotal).toBe(4);
    expect(typeof res.body.milestonesComplete).toBe("number");
    expect(typeof res.body.canGoLive).toBe("boolean");
    // Never an item-level count - the badge must not be able to say "6 of 11".
    expect(res.body).not.toHaveProperty("items");
    expect(res.body).not.toHaveProperty("applicableRequiredCount");
  });

  it("reacts to real data changing, with no readiness write of its own", async () => {
    const before = await readiness(ownerCookie);
    expect(itemById(before, "shop.availability.rule")!.done).toBe(true);

    // Clear the week through the ordinary endpoint (replace-all with []).
    await request(app)
      .put(`/api/booking/staff/${staffId}/availability`)
      .set("Cookie", ownerCookie)
      .send({ rules: [] });

    const after = await readiness(ownerCookie);
    expect(itemById(after, "shop.availability.rule")!.done).toBe(false);
    expect(after.canGoLive).toBe(false);
    // Assert the SPECIFIC consequence rather than the aggregate: this
    // deployment may already block a milestone for its own reasons (DRY_RUN
    // makes every alert undeliverable, for one), so "milestonesComplete went
    // down" is not a stable signal - "more things now block" is.
    expect(after.blocking.length).toBeGreaterThan(before.blocking.length);
    // The chair is no longer bookable either, since hours are part of it.
    expect(itemById(after, "shop.bookable_chair")!.done).toBe(false);
    expect(after.milestonesComplete).toBeLessThanOrEqual(before.milestonesComplete);

    // Put it back.
    await request(app)
      .put(`/api/booking/staff/${staffId}/availability`)
      .set("Cookie", ownerCookie)
      .send({
        rules: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          startMin: 9 * 60,
          endMin: 17 * 60,
        })),
      });
    expect(itemById(await readiness(ownerCookie), "shop.availability.rule")!.done).toBe(
      true,
    );
  });

  it("turns a conditional on and off with the feature", async () => {
    const off = await readiness(ownerCookie);
    expect(itemById(off, "waitlist.alert_phone")!.applicable).toBe(false);

    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ waitlistEnabled: true });
    const on = await readiness(ownerCookie);
    expect(itemById(on, "waitlist.alert_phone")!.applicable).toBe(true);
    // A conditional never blocks launch.
    expect(itemById(on, "waitlist.alert_phone")!.blocksLaunch).toBe(false);
    expect(on.applicableRequiredCount).toBe(off.applicableRequiredCount + 1);

    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ waitlistEnabled: false });
  });
});

describe("both routes are read-only", () => {
  it("changes no row and no timestamp", async () => {
    const snapshot = async () => ({
      shop: await prisma.shop.findUnique({
        where: { id: shopId },
        select: { updatedAt: true, publicPageEnabled: true, bookingMode: true },
      }),
      staff: await prisma.staff.findMany({
        where: { shopId },
        select: { id: true, updatedAt: true, active: true },
        orderBy: { id: "asc" },
      }),
      services: await prisma.service.findMany({
        where: { shopId },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
      counts: {
        staff: await prisma.staff.count({ where: { shopId } }),
        service: await prisma.service.count({ where: { shopId } }),
        rules: await prisma.availabilityRule.count({ where: { shopId } }),
        members: await prisma.shopMember.count({ where: { shopId } }),
        prefs: await prisma.barberNotifyPref.count({ where: { shopId } }),
        appts: await prisma.appointment.count({ where: { shopId } }),
      },
    });

    const before = await snapshot();
    await readiness(ownerCookie);
    await request(app).get("/api/readiness/summary").set("Cookie", ownerCookie);
    await readiness(ownerCookie);
    const after = await snapshot();

    expect(after).toEqual(before);
    // Belt and braces on the one field that would actually hurt.
    expect(after.shop!.publicPageEnabled).toBe(before.shop!.publicPageEnabled);
  });

  it("never disables a live shop that fails a check", async () => {
    // Break something required, then confirm the page is untouched.
    await request(app)
      .patch(`/api/booking/staff/${staffId}`)
      .set("Cookie", ownerCookie)
      .send({ active: false });

    const body = await readiness(ownerCookie);
    expect(body.canGoLive).toBe(false);
    expect(itemById(body, "shop.staff.active")!.done).toBe(false);
    // B1 ships no gate at all, and the public page is exactly as it was.
    expect(body.goLiveGateApplies).toBe(false);
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { publicPageEnabled: true },
    });
    expect(shop!.publicPageEnabled).toBe(true);

    await request(app)
      .patch(`/api/booking/staff/${staffId}`)
      .set("Cookie", ownerCookie)
      .send({ active: true });
  });
});

describe("the billing wall", () => {
  it("does NOT apply, while it still applies to the walled routers", async () => {
    // Turn real billing on and lapse the shop.
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_PRICE_ID = "price_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
    __resetEnvCacheForTests();
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        trialEndsAt: new Date(Date.now() - 86_400_000),
        subscriptionStatus: "canceled",
        compAccess: false,
      },
    });
    try {
      // The control: a walled router refuses.
      const walled = await request(app)
        .get("/api/booking/staff")
        .set("Cookie", ownerCookie);
      expect(walled.status).toBe(402);

      // Readiness still answers - this is the whole point.
      const res = await request(app).get("/api/readiness").set("Cookie", ownerCookie);
      expect(res.status).toBe(200);
      // ...and explains the lapse rather than hiding it.
      const info = itemById(res.body, "info.billing_access")!;
      expect(info.applicable).toBe(true);
      expect(info.klass).toBe("info");
      expect(res.body.liveNow).toBe(false);

      const sum = await request(app)
        .get("/api/readiness/summary")
        .set("Cookie", ownerCookie);
      expect(sum.status).toBe(200);
    } finally {
      await prisma.shop.update({
        where: { id: shopId },
        data: {
          trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
          subscriptionStatus: "none",
        },
      });
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_PRICE_ID;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      __resetEnvCacheForTests();
    }
  });
});

describe("role scoping", () => {
  let barberCookie: string;
  let barberChairId: string;

  beforeAll(async () => {
    // A second chair, seated by a real invite -> accept (which, since #269,
    // also sets Staff.userId, so this barber is the chair's own recipient).
    const chair = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", ownerCookie)
      .send({ name: "Marcus" });
    barberChairId = chair.body.id;

    const email = `rdy-b-${randomToken(6).toLowerCase()}@test.chairback`;
    const invited = await request(app)
      .post("/api/team/invites")
      .set("Cookie", ownerCookie)
      .send({ email, role: "BARBER", staffId: barberChairId });
    expect(invited.status).toBe(201);
    barberCookie = await signup(email, "Marcus");
    expect(
      (
        await request(app)
          .post("/api/team/join")
          .set("Cookie", barberCookie)
          .send({ token: lastInviteToken })
      ).status,
    ).toBe(201);
  });

  it("gives a BARBER their own chair and nothing shop-wide", async () => {
    const res = await request(app).get("/api/readiness").set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("barber");
    expect(res.body.chair.staffId).toBe(barberChairId);
    // No shop progress, no other chairs, no money.
    expect(res.body).not.toHaveProperty("milestones");
    expect(res.body).not.toHaveProperty("milestonesComplete");
    expect(res.body).not.toHaveProperty("staff");
    expect(res.body).not.toHaveProperty("canGoLive");
    expect(JSON.stringify(res.body)).not.toContain(staffId);
    expect(JSON.stringify(res.body)).not.toContain("Dre");
  });

  it("separates what a barber can do from what their manager owns", async () => {
    const res = await request(app).get("/api/readiness").set("Cookie", barberCookie);
    expect(res.body.personal.length).toBeGreaterThan(0);
    for (const i of res.body.personal) expect(i.role).toBe("barber");
    for (const i of res.body.managerOwned) expect(i.role).not.toBe("barber");
    // Hours stay manager-owned until B2 opens an own-chair route.
    expect(res.body.managerOwned.map((i: { id: string }) => i.id)).toContain(
      "staff.hours",
    );
  });

  it("ignores a client-supplied staffId entirely", async () => {
    // The chair is resolved from the authenticated seat; a query param must not
    // be able to point a barber at a colleague's chair.
    const res = await request(app)
      .get(`/api/readiness?staffId=${staffId}`)
      .set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    expect(res.body.chair.staffId).toBe(barberChairId);
    expect(JSON.stringify(res.body)).not.toContain(staffId);
  });

  it("🔴 a BARBER is never handed a manager-only destination", async () => {
    const res = await request(app).get("/api/readiness").set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    const items = [...res.body.personal, ...res.body.managerOwned];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      if (!i.cta) continue;
      const entry = featureById(i.cta.featureId);
      expect(entry, `${i.id} -> ${i.cta.featureId}`).toBeDefined();
      // An employee seat may only ever be given a BARBER-reachable feature.
      // Anything else 403s the moment they tap it.
      expect(
        availableToBarberSeat(entry!),
        `${i.id} offered a barber "${i.cta.featureId}" (${entry!.href})`,
      ).toBe(true);
    }
  });

  it("a manager-owned item keeps its explanation after losing its button", async () => {
    const res = await request(app).get("/api/readiness").set("Cookie", barberCookie);
    const owned = res.body.managerOwned as { why: string; title: string; cta?: unknown }[];
    // The point of dropping the CTA rather than the item: the barber still
    // learns what is wrong and who fixes it.
    for (const i of owned) {
      expect(i.title.trim().length).toBeGreaterThan(0);
      expect(i.why.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives a BARBER a personal-only summary", async () => {
    const res = await request(app)
      .get("/api/readiness/summary")
      .set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("barber");
    expect(res.body.chairLinked).toBe(true);
    expect(typeof res.body.incompletePersonal).toBe("number");
    expect(res.body).not.toHaveProperty("milestonesComplete");
  });

  it("gives a MANAGER the full shop report", async () => {
    const email = `rdy-m-${randomToken(6).toLowerCase()}@test.chairback`;
    await request(app)
      .post("/api/team/invites")
      .set("Cookie", ownerCookie)
      .send({ email, role: "MANAGER" });
    const cookie = await signup(email, "Manager");
    await request(app)
      .post("/api/team/join")
      .set("Cookie", cookie)
      .send({ token: lastInviteToken });

    const body = await readiness(cookie);
    expect(body.scope).toBe("shop");
    expect(body.milestones).toHaveLength(4);
    expect(body.staff.length).toBeGreaterThan(1);
  });
});

/**
 * The CTAs stopped being hand-written routes and became registry feature ids
 * that the router resolves against the caller's seat. Two things must hold: the
 * link a client renders is still a real route, and an employee never receives a
 * manager-only one.
 */
describe("CTA destinations come from the registry", () => {
  it("every CTA on the owner report resolves to a real registry route", async () => {
    const body = await readiness(ownerCookie);
    const known = new Set(FEATURE_INDEX.map((f) => f.href));
    const items = [...body.items, ...body.blocking, ...body.improve];
    expect(items.length).toBeGreaterThan(0);

    let withCta = 0;
    for (const i of items) {
      if (!i.cta) continue;
      withCta++;
      // Both halves on the wire: the id (so a client can re-resolve with
      // context the API lacks, chiefly the native shell) and the resolved href
      // (so every existing consumer keeps working unchanged).
      expect(typeof i.cta.featureId, i.id).toBe("string");
      expect(featureById(i.cta.featureId), `${i.id} -> ${i.cta.featureId}`).toBeDefined();
      expect(known.has(i.cta.href), `${i.id} -> ${i.cta.href}`).toBe(true);
      expect(i.cta.label.trim().length).toBeGreaterThan(0);
    }
    expect(withCta).toBeGreaterThan(0);
  });

});

/**
 * The Acuity health items, through a REAL collector against a REAL schema.
 *
 * The engine's rules are exercised exhaustively without a database in
 * engines/readiness.test.ts. What is proven HERE is the part only a real row can
 * prove: that the collector reads the columns it claims to, and that the
 * staleness comparison is made against the CONNECTION's timestamp rather than
 * against a clock.
 */
describe("Acuity health, end to end", () => {
  let acuityShopCookie: string;
  let acuityShopId: string;
  let acuityStaffId: string;

  beforeAll(async () => {
    const email = `rdy-acu-${randomToken(6).toLowerCase()}@test.chairback`;
    acuityShopCookie = await signup(email, "Acuity Owner");
    expect(
      (
        await request(app)
          .post("/api/shops")
          .set("Cookie", acuityShopCookie)
          .send({ name: "Acuity Cuts", smsAttested: true })
      ).status,
    ).toBe(201);
    const me = await request(app).get("/api/shops/me").set("Cookie", acuityShopCookie);
    acuityShopId = me.body.id;

    const staff = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", acuityShopCookie)
      .send({ name: "Dre" });
    acuityStaffId = staff.body.id;
    const service = await request(app)
      .post("/api/booking/services")
      .set("Cookie", acuityShopCookie)
      .send({ name: "Cut", durationMin: 30, price: 30, staffIds: [acuityStaffId] });
    expect(service.status).toBe(201);
    await request(app)
      .put(`/api/booking/staff/${acuityStaffId}/availability`)
      .set("Cookie", acuityShopCookie)
      .send({ rules: [{ weekday: 1, startMin: 540, endMin: 1020 }] });
  });

  async function itemsFor(cookie: string) {
    const res = await request(app).get("/api/readiness").set("Cookie", cookie);
    expect(res.status).toBe(200);
    // `title` is on the wire too (ReadinessItem carries it); declared here so the
    // vocabulary assertions below can read it without a second cast.
    return res.body.items as {
      id: string;
      applicable: boolean;
      done: boolean;
      evidence: string;
      title: string;
    }[];
  }
  const pick = (items: Awaited<ReturnType<typeof itemsFor>>, id: string) =>
    items.find((i) => i.id === id)!;

  it("both items are silent for a shop with no Acuity", async () => {
    const items = await itemsFor(acuityShopCookie);
    expect(pick(items, "integration.live_sync").applicable).toBe(false);
    expect(pick(items, "integration.chair_mapping").applicable).toBe(false);
  });

  it("🔴 a connected Acuity shop with no webhooks is reported as broken", async () => {
    await prisma.acuityConnection.create({
      data: {
        shopId: acuityShopId,
        acuityAccountId: "acct_rdy",
        accessToken: "enc",
        tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
      },
    });
    await prisma.shop.update({
      where: { id: acuityShopId },
      data: { bookingMode: "acuity", bookingUrl: "https://x.as.me", acuityWebhookIds: [] },
    });

    const broken = pick(await itemsFor(acuityShopCookie), "integration.live_sync");
    expect(broken.applicable).toBe(true);
    expect(broken.done).toBe(false);
    expect(broken.evidence).toContain("not arriving");

    await prisma.shop.update({
      where: { id: acuityShopId },
      data: { acuityWebhookIds: ["hook_1", "hook_2"] },
    });
    const fixed = pick(await itemsFor(acuityShopCookie), "integration.live_sync");
    expect(fixed.done).toBe(true);
    expect(fixed.evidence).toContain("2 live updates");
  });

  it("🔴 an unmatched chair is reported once the shop mirrors outbound", async () => {
    await prisma.shop.update({
      where: { id: acuityShopId },
      data: { bookingMode: "native", acuityOutboundMode: "ENFORCE" },
    });
    const unmapped = pick(await itemsFor(acuityShopCookie), "integration.chair_mapping");
    expect(unmapped.applicable).toBe(true);
    expect(unmapped.done).toBe(false);
    expect(unmapped.evidence).toContain("not matched yet");
  });

  it("🔴 a mapping made BEFORE the current connection reads as stale", async () => {
    // 🔴 Derived from `connectedAt`, never from a fresh `new Date()`. The two
    // timestamps come from different clocks - Postgres microseconds versus a
    // coarser JS tick - so a mapping written after the connection can still read
    // as a millisecond before it. (That exact race is what made the acuity
    // backfill suite fail a different test on every run.)
    const conn = await prisma.acuityConnection.findUniqueOrThrow({
      where: { shopId: acuityShopId },
      select: { connectedAt: true },
    });

    await prisma.staff.update({
      where: { id: acuityStaffId },
      data: {
        acuityCalendarId: "cal_1",
        acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() - 1_000),
      },
    });
    const stale = pick(await itemsFor(acuityShopCookie), "integration.chair_mapping");
    expect(stale.done).toBe(false);
    expect(stale.evidence).toContain("before the latest reconnect");

    await prisma.staff.update({
      where: { id: acuityStaffId },
      data: { acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1_000) },
    });
    const ok = pick(await itemsFor(acuityShopCookie), "integration.chair_mapping");
    expect(ok.done).toBe(true);
    // "workspace", not "chair": this fixture shop never answered the
    // business-type question, so it renders the NEUTRAL vocabulary rather than
    // barbershop words it never chose. The item ID stays
    // `integration.chair_mapping` - wording moves, wire values never do.
    expect(ok.evidence).toContain("1 workspace matched");
  });

  it("speaks the shop's own words once it has chosen a business type", async () => {
    // The same item, for a shop that HAS answered. Proves the neutral copy
    // above is the legacy fallback doing its job, not the vocabulary failing to
    // resolve at all.
    const before = await prisma.shop.findFirstOrThrow({
      where: { staff: { some: { id: acuityStaffId } } },
      select: { id: true, industry: true, businessTypeSelectedAt: true },
    });
    await prisma.shop.update({
      where: { id: before.id },
      data: { industry: "barber", businessTypeSelectedAt: new Date() },
    });
    try {
      const item = pick(await itemsFor(acuityShopCookie), "integration.chair_mapping");
      expect(item.evidence).toContain("1 chair matched");
    } finally {
      await prisma.shop.update({
        where: { id: before.id },
        data: {
          industry: before.industry,
          businessTypeSelectedAt: before.businessTypeSelectedAt,
        },
      });
    }
  });

  it("neither item can block a launch", async () => {
    const items = await itemsFor(acuityShopCookie);
    for (const id of ["integration.live_sync", "integration.chair_mapping"]) {
      const i = items.find((x) => x.id === id) as unknown as { blocksLaunch: boolean };
      expect(i.blocksLaunch, id).toBe(false);
    }
  });

  it("🔴 no Square mapping item was invented", async () => {
    // Staff has no squareTeamMemberId - there is no per-chair Square mapping in
    // the schema at all, so there is nothing that could be stale. This lands
    // when #288/#289 define what a Square chair mapping IS.
    const ids = (await itemsFor(acuityShopCookie)).map((i) => i.id);
    expect(ids.filter((id) => /square/i.test(id))).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("never reports another shop's data", async () => {
    const mine = await readiness(ownerCookie);
    const blob = JSON.stringify(mine);
    expect(blob).not.toContain(otherShopId);
    expect(blob).not.toContain("Not Yours");
    expect(mine.staff.every((s: { staffId: string }) => s.staffId !== otherShopId)).toBe(
      true,
    );

    // ...and the other owner sees only theirs.
    const theirs = await readiness(otherCookie);
    expect(theirs.shopId).toBe(otherShopId);
    expect(JSON.stringify(theirs)).not.toContain(shopId);
    expect(JSON.stringify(theirs)).not.toContain("Dre");
  });

  it("requires a session", async () => {
    expect((await request(app).get("/api/readiness")).status).toBe(401);
    expect((await request(app).get("/api/readiness/summary")).status).toBe(401);
  });
});

describe("what the response does NOT contain", () => {
  it("carries no customer records and no contact details", async () => {
    // Give the shop a real client + appointment, so there IS customer data to
    // leak if the collector ever over-selects.
    const client = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `k-${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "Nadia",
        lastName: "Okonkwo",
        phone: "+13025559999",
        email: "nadia.okonkwo@example.com",
        source: "manual",
      },
      select: { id: true },
    });
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: client.id,
        firstName: "Nadia",
        lastName: "Okonkwo",
        phone: "+13025559999",
        email: "nadia.okonkwo@example.com",
        status: "BOOKED",
        startsAt: new Date(Date.now() + 86_400_000),
        endsAt: new Date(Date.now() + 86_400_000 + 1_800_000),
        manageToken: randomToken(),
      },
    });

    const blob = JSON.stringify(await readiness(ownerCookie));
    expect(blob).not.toContain("Nadia");
    expect(blob).not.toContain("Okonkwo");
    expect(blob).not.toContain("nadia.okonkwo@example.com");
    // No phone number in any form - not the customer's, not the shop's alert
    // line, not a barber's own. The report says "a number is saved", never which.
    expect(blob).not.toMatch(/\+1\d{10}/);
    expect(blob).not.toContain("3025550123");
    // No email addresses at all.
    expect(blob).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
    // The appointment IS counted, without being exposed.
    expect(itemById(JSON.parse(blob), "shop.test_booking")!.done).toBe(true);
  });
});
