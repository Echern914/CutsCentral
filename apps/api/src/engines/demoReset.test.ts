import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { DEMO, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { MessageProvider } from "../messaging/provider.js";
import { seedDemoShop } from "../demo/seedDemoShop.js";
import { runDemoReset } from "./demoReset.js";
import { sweepShop } from "./nudge.js";

/**
 * The demo-shop seeder + nightly reset + the public read-only demo dashboard
 * session. One file on purpose: the demo tenant is a SINGLETON (unique slug),
 * so every test that seeds/deletes it must live in the same vitest file — a
 * second file would race it under parallel test files.
 *
 * The seeder is canonical-state by construction (wipe + recreate), so
 * seed==reset; these tests pin the canonical shape, the fixed public tokens
 * the tour depends on, pollution cleanup, nudge-sweep immunity, and the demo
 * session's read-only wall.
 */

let sent: { to: string; body: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sent.push(input);
    return { sid: `SM${sent.length}`, status: "queued" };
  },
};

/** The canonical child-row counts the seeder must restore every run. */
async function demoCounts(shopId: string) {
  const w = { where: { shopId } };
  return {
    staff: await prisma.staff.count(w),
    services: await prisma.service.count(w),
    serviceStaff: await prisma.serviceStaff.count(w),
    availabilityRules: await prisma.availabilityRule.count(w),
    addOns: await prisma.serviceAddOn.count(w),
    targetedSlots: await prisma.targetedSlot.count(w),
    cardTypes: await prisma.cardType.count(w),
    rewards: await prisma.reward.count(w),
    clients: await prisma.client.count(w),
    visits: await prisma.visit.count(w),
    ledger: await prisma.punchLedger.count(w),
    reviews: await prisma.review.count(w),
    promotions: await prisma.promotion.count(w),
    appointments: await prisma.appointment.count(w),
    waitlist: await prisma.waitlistEntry.count(w),
  };
}

const CANONICAL = {
  staff: 2,
  services: 3,
  serviceStaff: 6,
  availabilityRules: 12,
  addOns: 2,
  targetedSlots: 3,
  cardTypes: 1,
  rewards: 3,
  clients: 4, // Jordan + Andre + Sofia + Will
  visits: 25, // 6 + 12 + 5 + 2
  ledger: 28, // 25 earns + 2 VIP earns + Andre's redemption
  reviews: 4,
  promotions: 1,
  appointments: 2, // Jordan (fixed token) + Will (en-route showcase)
  waitlist: 0,
};

beforeAll(() => {
  __setMessageProviderForTests(fakeProvider);
});

afterAll(async () => {
  // Leave the DB clean for other test files: drop the demo tenant entirely.
  const shop = await prisma.shop.findFirst({ where: { slug: DEMO.SHOP_SLUG } });
  if (shop) await prisma.shop.delete({ where: { id: shop.id } });
  await prisma.user.deleteMany({ where: { email: DEMO.OWNER_EMAIL } });
});

describe("seedDemoShop", () => {
  it("creates the canonical demo tenant with the fixed public tokens", async () => {
    const result = await seedDemoShop();
    expect(await demoCounts(result.shopId)).toEqual(CANONICAL);

    const client = await prisma.client.findUnique({ where: { magicToken: DEMO.MAGIC_TOKEN } });
    expect(client?.shopId).toBe(result.shopId);
    expect(client?.loyaltyTier).toBe("SILVER");

    const appt = await prisma.appointment.findUnique({ where: { manageToken: DEMO.MANAGE_TOKEN } });
    expect(appt?.shopId).toBe(result.shopId);
    expect(appt?.status).toBe("BOOKED");
    expect(appt?.startsAt.getTime()).toBeGreaterThan(Date.now());
    // Pre-stamped on every channel so no reminder/confirmation engine sends.
    expect(appt?.reminderSentAt).not.toBeNull();
    expect(appt?.reminder24hPushSentAt).not.toBeNull();

    // Default-card balance 6: "Free Beard Trim" (6) ready, "Free Cut" at 6/10.
    const earns = await prisma.punchLedger.findMany({
      where: { shopId: result.shopId, clientId: client!.id, cardTypeId: null },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(earns[0]?.runningBalance).toBe(6);
  });

  it("is idempotent: a second run restores identical canonical counts", async () => {
    const first = await seedDemoShop();
    const second = await seedDemoShop();
    expect(second.shopId).toBe(first.shopId);
    expect(await demoCounts(second.shopId)).toEqual(CANONICAL);
    // Fixed tokens survive the wipe+recreate.
    expect(await prisma.client.findUnique({ where: { magicToken: DEMO.MAGIC_TOKEN } })).not.toBeNull();
    expect(await prisma.appointment.findUnique({ where: { manageToken: DEMO.MANAGE_TOKEN } })).not.toBeNull();
  });

  it("refuses to reseed when another owner holds the demo slug", async () => {
    // Park the slug on a foreign shop, then verify the seeder aborts untouched.
    const seeded = await seedDemoShop();
    const outsider = await prisma.user.create({
      data: { email: `outsider-${randomToken(6)}@test.local`, name: "O" },
    });
    const foreign = await prisma.shop.create({
      data: { ownerId: outsider.id, name: "Not The Demo", webhookSecret: randomToken() },
    });
    await prisma.shop.update({ where: { id: seeded.shopId }, data: { slug: `parked-${randomToken(6)}` } });
    await prisma.shop.update({ where: { id: foreign.id }, data: { slug: DEMO.SHOP_SLUG } });

    await expect(seedDemoShop()).rejects.toThrow(/refusing/i);

    // Restore: give the slug back to the real demo tenant and drop the decoy.
    await prisma.shop.update({ where: { id: foreign.id }, data: { slug: null } });
    await prisma.shop.update({ where: { id: seeded.shopId }, data: { slug: DEMO.SHOP_SLUG } });
    await prisma.shop.delete({ where: { id: foreign.id } });
    await prisma.user.delete({ where: { id: outsider.id } });
  });
});

describe("runDemoReset", () => {
  it("clears viewer-submitted pollution and restores canonical state", async () => {
    const { shopId } = await seedDemoShop();
    const staff = await prisma.staff.findFirstOrThrow({ where: { shopId } });
    const service = await prisma.service.findFirstOrThrow({ where: { shopId } });

    // Pollute: an off-tour review, a waitlist join, and a real booking.
    await prisma.review.create({
      data: { shopId, rating: 1, body: "spam", status: "PENDING" },
    });
    await prisma.waitlistEntry.create({ data: { shopId, firstName: "Stray" } });
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "Walk",
        status: "BOOKED",
        startsAt: new Date(Date.now() + 7 * 86_400_000),
        endsAt: new Date(Date.now() + 7 * 86_400_000 + 30 * 60_000),
        manageToken: randomToken(),
      },
    });

    await runDemoReset();
    expect(await demoCounts(shopId)).toEqual(CANONICAL);
  });

  it("no-ops when no demo shop exists", async () => {
    const shop = await prisma.shop.findFirst({ where: { slug: DEMO.SHOP_SLUG } });
    if (shop) await prisma.shop.delete({ where: { id: shop.id } });
    await expect(runDemoReset()).resolves.toBeUndefined();
    expect(await prisma.shop.findFirst({ where: { slug: DEMO.SHOP_SLUG } })).toBeNull();
  });

  it("never texts a demo client from the rebooking sweep (cap 0 kills sends)", async () => {
    await seedDemoShop();
    const shop = await prisma.shop.findFirstOrThrow({ where: { slug: DEMO.SHOP_SLUG } });
    sent = [];
    await sweepShop(shop, { now: new Date(), dryRun: false });
    expect(sent).toEqual([]);
  });
});

describe("POST /api/demo/session (read-only demo dashboard)", () => {
  const app = createApp();

  /** The cb_session cookie pair ("name=value") from a mint response. */
  function sessionCookie(res: request.Response): string {
    const setCookies = res.headers["set-cookie"] as unknown as string[] | undefined;
    const raw = (setCookies ?? []).find((c) => c.startsWith("cb_session="));
    expect(raw, "mint response sets the session cookie").toBeDefined();
    return raw!.split(";")[0]!;
  }

  it("mints a session that reads the demo shop's dashboard", async () => {
    await seedDemoShop();
    const mint = await request(app).post("/api/demo/session");
    expect(mint.status).toBe(200);
    const cookie = sessionCookie(mint);

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(DEMO.OWNER_EMAIL);
    expect(me.body.demo).toBe(true);
    expect(me.body.welcomeSeen).toBe(true); // never bounce into /welcome

    const shop = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(shop.status).toBe(200);
    expect(shop.body.slug).toBe(DEMO.SHOP_SLUG);
  });

  it("rejects mutating requests with demo_read_only", async () => {
    await seedDemoShop();
    const cookie = sessionCookie(await request(app).post("/api/demo/session"));

    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ name: "Hacked District" });
    expect(patch.status).toBe(403);
    expect(patch.body.error).toBe("demo_read_only");

    const shop = await prisma.shop.findFirstOrThrow({ where: { slug: DEMO.SHOP_SLUG } });
    expect(shop.name).toBe("Fade District"); // the write really didn't land
  });

  it("a demo logout never revokes the shared owner's other demo sessions", async () => {
    await seedDemoShop();
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: DEMO.OWNER_EMAIL } });
    const cookie = sessionCookie(await request(app).post("/api/demo/session"));

    // Logout isn't requireUser-guarded (it inline-verifies), so it answers 200
    // — but for a demo-claim token it must NOT bump the shared tokenVersion.
    const logout = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect(logout.status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { email: DEMO.OWNER_EMAIL } });
    expect(after.tokenVersion).toBe(owner.tokenVersion);

    // The "other prospect's" session (same version) still works after it.
    const other = sessionCookie(await request(app).post("/api/demo/session"));
    const me = await request(app).get("/api/auth/me").set("Cookie", other);
    expect(me.status).toBe(200);
  });

  it("refuses OAuth paths even though they are GETs", async () => {
    await seedDemoShop();
    const cookie = sessionCookie(await request(app).post("/api/demo/session"));
    const res = await request(app).get("/api/acuity/oauth/start").set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("demo_read_only");
  });

  it("404s when the demo tenant does not exist", async () => {
    const seeded = await seedDemoShop();
    await prisma.shop.update({ where: { id: seeded.shopId }, data: { slug: "demo-parked" } });
    const res = await request(app).post("/api/demo/session");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("demo_unavailable");
    await prisma.shop.update({ where: { id: seeded.shopId }, data: { slug: DEMO.SHOP_SLUG } });
  });
});
