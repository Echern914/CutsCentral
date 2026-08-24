import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { apiEnv, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintClaimToken } from "../engines/waitlistOffer.js";

/**
 * POST /admin/waitlist-expiry-preview
 *
 * The point of this endpoint is to answer "how many would go?" WITHOUT
 * enabling anything - so the tests are mostly about what it refuses. It has no
 * write mode to ask for, it will not quietly ignore a parameter that implies
 * one, and it hands back counts rather than customers.
 */

const app = createApp();
const TZ = "America/New_York";
const TOKEN = apiEnv().ADMIN_TOKEN;

/** Two shops, so the per-shop grouping is exercised rather than assumed. */
let shopA: string;
let shopB: string;
let slugA: string;
let staffId: string;
let serviceId: string;

/** Every entry this file makes, so assertions never depend on other suites. */
const mine = { expiring: "", held: "", legacy: "", zeroWindow: "", live: "", otherShop: "" };

const yday = () => new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);
const far = () => new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);

async function makeShop(name: string) {
  const user = await prisma.user.create({
    data: { email: `wl-prev-${randomToken(6)}@test.local`, name: "P" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name,
      slug: `wl-prev-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: TZ,
      bookingMode: "native",
      bookingLeadHours: 0,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
    select: { id: true, slug: true },
  });
  return shop;
}

async function entry(
  shopId: string,
  windows: { startDate: string | null; endDate: string | null }[],
  over: Record<string, unknown> = {},
) {
  const e = await prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: "Marcus",
      lastName: "Reed",
      phone: "+12025550171",
      email: `prev-${randomToken(5)}@test.local`,
      note: "prefers the chair by the window",
      status: "WAITING",
      windows: { create: windows.map((w) => ({ shopId, ...w })) },
      ...over,
    },
    select: { id: true },
  });
  return e.id;
}

const preview = () => request(app).post("/admin/waitlist-expiry-preview");
const auth = () => preview().set("Authorization", `Bearer ${TOKEN}`);

interface ShopRow {
  shopId: string;
  name: string;
  slug: string | null;
  scanned: number;
  wouldExpire: number;
  heldBackByLiveOffer: number;
  legacySkipped: number;
  zeroWindowSkipped: number;
  evaluationErrors: number;
}
const shopRow = (body: { shops: ShopRow[] }, id: string): ShopRow | undefined =>
  body.shops.find((s) => s.shopId === id);

beforeAll(async () => {
  const a = await makeShop("Preview Cuts A");
  const b = await makeShop("Preview Cuts B");
  shopA = a.id;
  slugA = a.slug!;
  shopB = b.id;

  const staff = await prisma.staff.create({ data: { shopId: shopA, name: "Sam" }, select: { id: true } });
  staffId = staff.id;
  const svc = await prisma.service.create({
    data: { shopId: shopA, name: "Cut", durationMin: 30 },
    select: { id: true },
  });
  serviceId = svc.id;

  // Shop A: one that would go, one held by a live offer, one legacy, one with
  // no windows, and one whose window is still to come.
  mine.expiring = await entry(shopA, [{ startDate: yday(), endDate: yday() }]);
  mine.held = await entry(shopA, [{ startDate: yday(), endDate: yday() }]);
  mine.legacy = await entry(shopA, [{ startDate: null, endDate: null }]);
  mine.zeroWindow = await entry(shopA, []);
  mine.live = await entry(shopA, [{ startDate: far(), endDate: far() }]);
  // Shop B: one that would go, so the grouping has something to separate.
  mine.otherShop = await entry(shopB, [{ startDate: yday(), endDate: yday() }]);

  const startsAt = new Date(Math.ceil((Date.now() + 72 * 3600_000) / 1800_000) * 1800_000);
  await prisma.waitlistOffer.create({
    data: {
      shopId: shopA,
      entryId: mine.held,
      staffId,
      serviceId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      tokenHash: mintClaimToken().hash,
      status: "OFFERED",
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
});

afterAll(async () => {
  await prisma.waitlistEntry.updateMany({
    where: { shopId: { in: [shopA, shopB] }, status: { in: ["WAITING", "CONTACTED"] } },
    data: { status: "REMOVED" },
  });
  await prisma.waitlistOffer.updateMany({
    where: { shopId: shopA, status: "OFFERED" },
    data: { status: "RELEASED" },
  });
});

// ───────────────────────────────────────── the locks

describe("who may ask", () => {
  it("🔴 no credentials, no answer", async () => {
    const res = await preview();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("a wrong bearer token is refused", async () => {
    const res = await preview().set("Authorization", `Bearer ${randomToken(24)}`);
    expect(res.status).toBe(401);
  });

  it("a bare token without the Bearer scheme is refused", async () => {
    const res = await preview().set("Authorization", String(TOKEN));
    expect(res.status).toBe(401);
  });

  it("🔑 it sits behind the SAME guards as the rest of /admin", async () => {
    // Not a claim about this handler - a check that it is mounted inside the
    // router those guards wrap. An unauthenticated sibling answers identically.
    const sibling = await request(app).post("/admin/promote");
    expect(sibling.status).toBe(401);
    expect((await preview()).status).toBe(401);
    // And the IP allowlist covers the whole mount (adminIp.test.ts pins its
    // behaviour); it is applied at app.use("/admin", requireAdminIp, ...).
  });
});

// ───────────────────────────────────────── it refuses to be told what to do

describe("there is no write mode to ask for", () => {
  it("🔴 dryRun:false is REFUSED, not ignored", async () => {
    const res = await auth().send({ dryRun: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_parameters_accepted");
    expect(res.body.rejected).toContain("dryRun");
  });

  it("🔴 ?dryRun=false in the query is refused too", async () => {
    const res = await request(app)
      .post("/admin/waitlist-expiry-preview?dryRun=false")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.rejected).toContain("dryRun");
  });

  it("write:true is refused", async () => {
    const res = await auth().send({ write: true });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toContain("write");
  });

  it("any unexpected field is refused", async () => {
    const res = await auth().send({ shopId: "anything", limit: 5 });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toEqual(expect.arrayContaining(["shopId", "limit"]));
  });

  it("an empty body is accepted", async () => {
    expect((await auth().send({})).status).toBe(200);
    expect((await auth()).status).toBe(200);
  });
});

// ───────────────────────────────────────── what it reports

describe("what it reports", () => {
  it("returns the aggregate shape, marked dry-run", async () => {
    const res = await auth();
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(new Date(res.body.evaluatedAt).getTime()).not.toBeNaN();
    for (const k of [
      "scanned",
      "wouldExpire",
      "heldBackByLiveOffer",
      "legacySkipped",
      "zeroWindowSkipped",
      "evaluationErrors",
    ]) {
      expect(typeof res.body[k], k).toBe("number");
    }
    expect(Array.isArray(res.body.shops)).toBe(true);
  });

  it("counts the entry that would go, and the one a live hold protects", async () => {
    const res = await auth();
    const a = shopRow(res.body, shopA)!;
    expect(a.wouldExpire).toBe(1); // the expiring one
    expect(a.heldBackByLiveOffer).toBe(1); // eligible, but its claim link is live
    expect(a.legacySkipped).toBe(1);
    expect(a.zeroWindowSkipped).toBe(1);
    expect(a.evaluationErrors).toBe(0);
    expect(a.scanned).toBe(5); // the fifth window is simply still to come
  });

  it("🔴 legacy and zero-window are reported SEPARATELY, not lumped together", async () => {
    const a = shopRow((await auth()).body, shopA)!;
    expect(a.legacySkipped).toBe(1);
    expect(a.zeroWindowSkipped).toBe(1);
    expect(a.legacySkipped + a.zeroWindowSkipped).toBe(2);
  });

  it("groups two shops separately and labels each", async () => {
    const res = await auth();
    const a = shopRow(res.body, shopA)!;
    const b = shopRow(res.body, shopB)!;
    expect(a.name).toBe("Preview Cuts A");
    expect(b.name).toBe("Preview Cuts B");
    expect(a.slug).toBe(slugA);
    expect(b.wouldExpire).toBe(1);
    expect(b.heldBackByLiveOffer).toBe(0);
    expect(b.scanned).toBe(1);
  });

  it("the global totals are at least the sum of the shops we seeded", async () => {
    const res = await auth();
    expect(res.body.wouldExpire).toBeGreaterThanOrEqual(2);
    expect(res.body.scanned).toBeGreaterThanOrEqual(6);
  });
});

// ───────────────────────────────────────── it changes nothing

describe("it changes nothing", () => {
  it("🔴 every candidate is still WAITING afterwards", async () => {
    const before = await prisma.waitlistEntry.findMany({
      where: { id: { in: Object.values(mine) } },
      select: { id: true, status: true, expiresAt: true },
      orderBy: { id: "asc" },
    });
    expect(before.every((e) => e.status === "WAITING")).toBe(true);

    await auth().expect(200);
    await auth().expect(200); // twice, in case one run armed the next

    const after = await prisma.waitlistEntry.findMany({
      where: { id: { in: Object.values(mine) } },
      select: { id: true, status: true, expiresAt: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });

  it("🔴 expiresAt is untouched", async () => {
    await auth().expect(200);
    const rows = await prisma.waitlistEntry.findMany({
      where: { id: { in: Object.values(mine) } },
      select: { expiresAt: true },
    });
    expect(rows.every((r) => r.expiresAt === null)).toBe(true);
  });

  it("🔴 not one entry.expired_auto event is written", async () => {
    await auth().expect(200);
    const events = await prisma.waitlistEvent.count({
      where: { entryId: { in: Object.values(mine) }, type: "entry.expired_auto" },
    });
    expect(events).toBe(0);
  });

  it("a CONTACTED candidate is left alone too", async () => {
    const id = await entry(shopA, [{ startDate: yday(), endDate: yday() }], {
      status: "CONTACTED",
    });
    await auth().expect(200);
    const row = await prisma.waitlistEntry.findUnique({
      where: { id },
      select: { status: true, expiresAt: true },
    });
    expect(row!.status).toBe("CONTACTED");
    expect(row!.expiresAt).toBeNull();
  });
});

// ───────────────────────────────────────── nothing personal comes back

describe("nothing customer-level comes back", () => {
  it("🔴 no name, contact detail, note, window, id or token in the whole response", async () => {
    const res = await auth();
    const dump = JSON.stringify(res.body);

    for (const needle of [
      "Marcus",
      "Reed",
      "+12025550171",
      "2025550171",
      "prefers the chair",
      "@test.local",
      yday(),
      far(),
      "startDate",
      "endDate",
      "startMin",
      "token",
      "entryId",
      ...Object.values(mine), // every seeded entry id
    ]) {
      expect(dump, `leaked: ${needle}`).not.toContain(needle);
    }
  });

  it("a shop row carries shop identity and counts - nothing else", async () => {
    const a = shopRow((await auth()).body, shopA)!;
    expect(Object.keys(a).sort()).toEqual(
      [
        "evaluationErrors",
        "heldBackByLiveOffer",
        "legacySkipped",
        "name",
        "scanned",
        "shopId",
        "slug",
        "wouldExpire",
        "zeroWindowSkipped",
      ].sort(),
    );
  });

  it("the top level exposes only aggregates", async () => {
    const res = await auth();
    expect(Object.keys(res.body).sort()).toEqual(
      [
        "dryRun",
        "evaluatedAt",
        "evaluationErrors",
        "heldBackByLiveOffer",
        "legacySkipped",
        "partial",
        "scanned",
        "shops",
        "wouldExpire",
        "zeroWindowSkipped",
      ].sort(),
    );
  });
});
