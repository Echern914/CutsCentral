import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { ADOPTION_FEATURES, DEMO, FEATURE_ADOPTION, randomToken } from "@chairback/config";
import {
  __setFeatureAdoptionSourceForTests,
  computeFeatureAdoption,
  getFeatureAdoptionTotals,
  shopFeatureUsage,
  type AdoptionTotals,
} from "./featureAdoption.js";

/**
 * Platform feature adoption: who counts, what counts as "uses it", and the
 * privacy floor. The test database is shared by every suite, so every exact
 * percentage here is measured over shops this file made (`onlyShopIds`); the
 * exclusions still apply inside that set, which is what the exclusion tests
 * lean on.
 */

const DAY = 86_400_000;
const NOW = new Date();
const tag = randomToken(6).toLowerCase();

const createdUserIds: string[] = [];
const createdShopIds: string[] = [];

/** Real-looking owner (not on any excluded domain), or an existing account reused. */
async function ownerFor(email: string): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing.id;
  const u = await prisma.user.create({ data: { email, name: "Adoption Owner" } });
  createdUserIds.push(u.id);
  return u.id;
}

let seq = 0;
/** A shop, optionally with a booking made today (active) or only 60 days ago. */
async function makeShop(opts: {
  email?: string;
  booking?: "recent" | "old" | "none";
  data?: Record<string, unknown>;
} = {}): Promise<string> {
  seq += 1;
  const ownerId = await ownerFor(opts.email ?? `adopt-${tag}-${seq}@adoption-fixture.dev`);
  const shop = await prisma.shop.create({
    data: { ownerId, name: `Adoption ${seq}`, webhookSecret: randomToken(), ...(opts.data ?? {}) },
  });
  createdShopIds.push(shop.id);
  const booking = opts.booking ?? "recent";
  if (booking !== "none") {
    const when = booking === "recent" ? new Date(NOW.getTime() - 2 * DAY) : new Date(NOW.getTime() - 60 * DAY);
    const staff = await prisma.staff.create({ data: { shopId: shop.id, name: "Chair" } });
    const service = await prisma.service.create({ data: { shopId: shop.id, name: "Standard", durationMin: 30 } });
    await prisma.appointment.create({
      data: {
        shopId: shop.id,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "Pat",
        status: "COMPLETED",
        startsAt: when,
        endsAt: new Date(when.getTime() + 30 * 60_000),
        manageToken: randomToken(16),
        createdAt: when,
      },
    });
  }
  return shop.id;
}

/** Every one of the ten signals, written the way the product writes them. */
async function turnEverythingOn(shopId: string): Promise<void> {
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      bookingMode: "native",
      rewardsEnabled: true,
      waitlistEnabled: true,
      autoFillEnabled: true,
      paymentsMode: "deposit",
      connectChargesEnabled: true,
      customDomain: `adopt-${randomToken(6).toLowerCase()}.example`,
      customDomainVerifiedAt: NOW,
    },
  });
  const group = await prisma.serviceGroup.create({ data: { shopId, name: "Group" } });
  await prisma.service.create({
    data: { shopId, name: "Grouped", durationMin: 30, serviceGroupId: group.id },
  });
  await prisma.service.create({
    data: { shopId, name: "Holiday", durationMin: 30, dateOverrides: { "2026-12-24": 75 } },
  });
  const client = await prisma.client.create({
    data: { shopId, firstName: "Sam", acuityClientKey: `adopt:${randomToken(8)}`, magicToken: randomToken() },
  });
  await prisma.nudge.create({
    data: { shopId, clientId: client.id, kind: "nudge", status: "SENT", sentAt: NOW },
  });
  await prisma.broadcast.create({
    data: { shopId, channel: "push", body: "Open Saturday", status: "SENT", queuedAt: NOW, sentAt: NOW },
  });
}

// The population: eleven real, active shops, with a known mix of features.
const real: string[] = [];
// Shops that must NEVER count, each with every feature on so a leak shows.
const excluded: Record<string, string> = {};

beforeAll(async () => {
  for (let i = 0; i < 11; i++) real.push(await makeShop());
  // rewards: 4 of 11 = 36.4% -> 35. waitlist: 1 of 11 = 9.1% -> 10.
  // special pricing: 2 of 11 = 18.2% -> 20. custom domain: 0 -> 0.
  for (const id of real.slice(0, 4)) {
    await prisma.shop.update({ where: { id }, data: { rewardsEnabled: true } });
  }
  await prisma.shop.update({ where: { id: real[0]! }, data: { waitlistEnabled: true } });
  for (const id of real.slice(0, 2)) {
    await prisma.service.create({
      data: { shopId: id, name: "Sunday", durationMin: 30, priceOverrides: { "0": 50 } },
    });
  }

  // The demo tenant: its owner account (reused if another suite seeded it).
  excluded.demoOwner = await makeShop({ email: DEMO.OWNER_EMAIL });
  // A real-looking owner on the demo slug, if nobody holds it.
  const slugTaken = await prisma.shop.findUnique({ where: { slug: DEMO.SHOP_SLUG } });
  if (!slugTaken) excluded.demoSlug = await makeShop({ data: { slug: DEMO.SHOP_SLUG } });
  // Seed / test accounts.
  excluded.testLocal = await makeShop({ email: `adopt-${tag}@test.local` });
  excluded.exampleCom = await makeShop({ email: `adopt-${tag}@example.com` });
  // Signed up, then nothing for two months.
  excluded.inactive = await makeShop({ booking: "old" });
  excluded.neverBooked = await makeShop({ booking: "none" });
  for (const id of Object.values(excluded)) await turnEverythingOn(id);
  // Deleted: a shop is hard-deleted (DELETE /api/shops/me), so its id stays
  // in the candidate list below with no row behind it.
  excluded.deleted = await makeShop();
  await turnEverythingOn(excluded.deleted);
  await prisma.appointment.deleteMany({ where: { shopId: excluded.deleted } });
  await prisma.shop.delete({ where: { id: excluded.deleted } });
});

afterAll(async () => {
  __setFeatureAdoptionSourceForTests();
  await prisma.appointment.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

const everyone = () => [...real, ...Object.values(excluded)];

describe("the percentages", () => {
  it("are each feature's share of the population, rounded to the nearest 5%", async () => {
    const totals = await computeFeatureAdoption({ now: NOW, onlyShopIds: real });
    expect(totals).not.toBeNull();
    expect(totals!.pct.rewards).toBe(35); // 4/11 = 36.4%
    expect(totals!.pct.waitlist).toBe(10); // 1/11 = 9.1%
    expect(totals!.pct.special_pricing).toBe(20); // 2/11 = 18.2%
    expect(totals!.pct.custom_domain).toBe(0);
    expect(totals!.pct.auto_fill).toBe(0);
  });

  it("every figure is a multiple of 5 between 0 and 100", async () => {
    const totals = await computeFeatureAdoption({ now: NOW, onlyShopIds: real });
    for (const f of ADOPTION_FEATURES) {
      const v = totals!.pct[f.id];
      expect(v % FEATURE_ADOPTION.roundToPct).toBe(0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("the production path (the whole platform, no narrowing) runs", async () => {
    // Its numbers depend on every other suite's shops, so only its shape is
    // checked: nothing, or a percentage for every feature.
    const totals = await computeFeatureAdoption({ now: NOW });
    if (totals) {
      expect(Object.keys(totals.pct).sort()).toEqual(ADOPTION_FEATURES.map((f) => f.id).sort());
    } else {
      expect(totals).toBeNull();
    }
  });

  it("carries percentages only: no population, no counts, no shop ids", async () => {
    const totals = await computeFeatureAdoption({ now: NOW, onlyShopIds: real });
    expect(Object.keys(totals!)).toEqual(["pct"]);
    expect(Object.keys(totals!.pct).sort()).toEqual(ADOPTION_FEATURES.map((f) => f.id).sort());
    const json = JSON.stringify(totals);
    for (const id of everyone()) expect(json).not.toContain(id);
  });
});

describe("who counts", () => {
  it("demo, seeded, test, deleted and inactive shops are excluded", async () => {
    // Every excluded shop has every feature on. If any one of them counted,
    // the population would be 12+ and custom domain (0 real shops) would move
    // off 0, and rewards (4 real) off 4/11.
    const totals = await computeFeatureAdoption({ now: NOW, onlyShopIds: everyone() });
    expect(totals!.pct.custom_domain).toBe(0);
    expect(totals!.pct.auto_fill).toBe(0);
    expect(totals!.pct.rewards).toBe(35);
  });

  it.each(["demoOwner", "testLocal", "exampleCom", "inactive", "neverBooked"])(
    "%s alone is not a population of one",
    async (key) => {
      // Ten real shops (no custom domain) + the one excluded shop (which has
      // one). Counted, it would make 1 of 11 = 10%; excluded, it stays 0%.
      const totals = await computeFeatureAdoption({
        now: NOW,
        onlyShopIds: [...real.slice(0, 10), excluded[key]!],
      });
      expect(totals).not.toBeNull();
      expect(totals!.pct.custom_domain).toBe(0);
    },
  );

  it("a booking that was only HELD in the window (made earlier) still makes a shop active", async () => {
    const id = await makeShop({ booking: "none" });
    const staff = await prisma.staff.create({ data: { shopId: id, name: "Chair" } });
    const service = await prisma.service.create({ data: { shopId: id, name: "S", durationMin: 30 } });
    const held = new Date(NOW.getTime() - 3 * DAY);
    await prisma.appointment.create({
      data: {
        shopId: id,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "Pat",
        status: "COMPLETED",
        startsAt: held,
        endsAt: new Date(held.getTime() + 30 * 60_000),
        manageToken: randomToken(16),
        createdAt: new Date(NOW.getTime() - 50 * DAY),
      },
    });
    await prisma.shop.update({ where: { id }, data: { customDomain: `held-${tag}.example`, customDomainVerifiedAt: NOW } });
    // 9 real shops with no domain + this one = 10 -> 10%.
    const totals = await computeFeatureAdoption({ now: NOW, onlyShopIds: [...real.slice(0, 9), id] });
    expect(totals!.pct.custom_domain).toBe(10);
  });

  it("a synced (Acuity/Square) visit counts as a booking", async () => {
    const id = await makeShop({ booking: "none", data: { autoFillEnabled: true } });
    const client = await prisma.client.create({
      data: { shopId: id, firstName: "Lee", acuityClientKey: `adopt:${randomToken(8)}`, magicToken: randomToken() },
    });
    await prisma.visit.create({
      data: {
        shopId: id,
        clientId: client.id,
        acuityAppointmentId: `adopt-${randomToken(6)}`,
        status: "COMPLETED",
        scheduledAt: new Date(NOW.getTime() - DAY),
      },
    });
    // No real shop has auto-fill; this one does -> 1 of 10. Not counted would
    // be 9 shops: below the floor, null.
    const totals = await computeFeatureAdoption({ now: NOW, onlyShopIds: [...real.slice(0, 9), id] });
    expect(totals!.pct.auto_fill).toBe(10);
  });
});

describe("the privacy floor", () => {
  it(`below ${FEATURE_ADOPTION.minPopulation} qualifying shops there is nothing at all`, async () => {
    const below = real.slice(0, FEATURE_ADOPTION.minPopulation - 1);
    expect(await computeFeatureAdoption({ now: NOW, onlyShopIds: below })).toBeNull();
  });

  it("at the floor, the figures appear", async () => {
    const at = real.slice(0, FEATURE_ADOPTION.minPopulation);
    expect(await computeFeatureAdoption({ now: NOW, onlyShopIds: at })).not.toBeNull();
  });

  it("excluded shops never lift a small population over the floor", async () => {
    const below = real.slice(0, FEATURE_ADOPTION.minPopulation - 1);
    expect(
      await computeFeatureAdoption({ now: NOW, onlyShopIds: [...below, ...Object.values(excluded)] }),
    ).toBeNull();
  });
});

describe("what 'uses it' means (one definition, shared with the totals)", () => {
  it("a shop with every signal set uses every feature", async () => {
    const id = await makeShop();
    await turnEverythingOn(id);
    const usage = await shopFeatureUsage(id, NOW);
    for (const f of ADOPTION_FEATURES) expect(usage[f.id], f.id).toBe(true);
  });

  it("a bare active shop uses none of them", async () => {
    const usage = await shopFeatureUsage(real[10]!, NOW);
    for (const f of ADOPTION_FEATURES) expect(usage[f.id], f.id).toBe(false);
  });

  it("a time-of-day window counts as pricing only when it carries a price", async () => {
    const lengthOnly = await makeShop();
    await prisma.service.create({
      data: { shopId: lengthOnly, name: "Late", durationMin: 30, timeOverrides: [{ s: 1260, e: 1380, durationMin: 45 }] },
    });
    const priced = await makeShop();
    await prisma.service.create({
      data: { shopId: priced, name: "Late", durationMin: 30, timeOverrides: [{ s: 1260, e: 1380, price: 60 }] },
    });
    expect((await shopFeatureUsage(lengthOnly, NOW)).special_pricing).toBe(false);
    expect((await shopFeatureUsage(priced, NOW)).special_pricing).toBe(true);
  });

  it("a group with no active service, a draft message, an old nudge and an unready card account do not count", async () => {
    const id = await makeShop({ data: { paymentsMode: "deposit", connectChargesEnabled: false } });
    await prisma.serviceGroup.create({ data: { shopId: id, name: "Empty" } });
    const client = await prisma.client.create({
      data: { shopId: id, firstName: "Ari", acuityClientKey: `adopt:${randomToken(8)}`, magicToken: randomToken() },
    });
    await prisma.nudge.create({
      data: { shopId: id, clientId: client.id, kind: "nudge", status: "SENT", sentAt: new Date(NOW.getTime() - 45 * DAY) },
    });
    await prisma.broadcast.create({ data: { shopId: id, channel: "email", body: "draft", status: "DRAFT" } });
    const usage = await shopFeatureUsage(id, NOW);
    expect(usage.service_groups).toBe(false);
    expect(usage.client_messages).toBe(false);
    expect(usage.rebook_nudges).toBe(false);
    expect(usage.card_at_booking).toBe(false);
  });

  it("an unverified custom domain claim is not a custom domain", async () => {
    const id = await makeShop({ data: { customDomain: `claim-${tag}.example`, customDomainVerifiedAt: null } });
    expect((await shopFeatureUsage(id, NOW)).custom_domain).toBe(false);
  });
});

describe("the cache: computed once per day, never per request", () => {
  const T0 = new Date("2026-10-30T12:00:00.000Z");
  const totals: AdoptionTotals = {
    pct: Object.fromEntries(ADOPTION_FEATURES.map((f) => [f.id, 50])) as AdoptionTotals["pct"],
  };

  it("reuses one computation until the TTL runs out", async () => {
    const source = vi.fn(async () => totals);
    __setFeatureAdoptionSourceForTests(source);
    expect(await getFeatureAdoptionTotals(T0)).toBe(totals);
    expect(await getFeatureAdoptionTotals(new Date(T0.getTime() + 60_000))).toBe(totals);
    expect(await getFeatureAdoptionTotals(new Date(T0.getTime() + 23 * 3_600_000))).toBe(totals);
    expect(source).toHaveBeenCalledTimes(1);
    await getFeatureAdoptionTotals(new Date(T0.getTime() + FEATURE_ADOPTION.cacheTtlMs + 1));
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("requests that arrive together share the one computation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const source = vi.fn(async () => {
      await gate;
      return totals;
    });
    __setFeatureAdoptionSourceForTests(source);
    const all = Promise.all([getFeatureAdoptionTotals(T0), getFeatureAdoptionTotals(T0), getFeatureAdoptionTotals(T0)]);
    release();
    expect(await all).toEqual([totals, totals, totals]);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("a below-floor answer (null) is cached too", async () => {
    const source = vi.fn(async () => null);
    __setFeatureAdoptionSourceForTests(source);
    expect(await getFeatureAdoptionTotals(T0)).toBeNull();
    expect(await getFeatureAdoptionTotals(new Date(T0.getTime() + 3_600_000))).toBeNull();
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("a failure hides the card and is not retried on every request", async () => {
    const source = vi.fn(async () => {
      throw new Error("db down");
    });
    __setFeatureAdoptionSourceForTests(source);
    expect(await getFeatureAdoptionTotals(T0)).toBeNull();
    expect(await getFeatureAdoptionTotals(new Date(T0.getTime() + 60_000))).toBeNull();
    expect(source).toHaveBeenCalledTimes(1);
    // A few minutes later it tries again.
    await getFeatureAdoptionTotals(new Date(T0.getTime() + 10 * 60_000));
    expect(source).toHaveBeenCalledTimes(2);
  });
});
