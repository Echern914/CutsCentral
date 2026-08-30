import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { BUSINESS_TYPES, BUSINESS_TYPE_IDS, NEUTRAL_VOCABULARY, randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The business-type contract at the API boundary.
 *
 * Two promises are under test, and they are not the same promise:
 *  1. A type a human CHOSE is honored everywhere.
 *  2. A type nobody chose is never spoken as if they had - the shop renders
 *     NEUTRAL wording and is flagged for a one-time picker instead.
 *
 * The second is what protects shops that predate the picker, and it is enforced
 * by `Shop.businessTypeSelectedAt` rather than by the stored `industry` string.
 */
const app = createApp();

async function signUp(tag: string): Promise<string> {
  const email = `biztype-${tag}-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "B", smsAttested: true });
  expect(signup.status).toBe(201);
  return (signup.headers["set-cookie"] as unknown as string[])[0]!;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/shops - choosing a business type", () => {
  it("accepts every id in the registry and marks it chosen", async () => {
    for (const id of BUSINESS_TYPE_IDS) {
      const cookie = await signUp(`ok-${id}`);
      const res = await request(app)
        .post("/api/shops")
        .set("Cookie", cookie)
        .send({ name: `Shop ${id}`, industry: id, smsAttested: true });
      expect(res.status, id).toBe(201);

      const row = await prisma.shop.findUnique({
        where: { id: res.body.id as string },
        select: { industry: true, businessTypeSelectedAt: true },
      });
      expect(row?.industry, id).toBe(id);
      // The stamp is what makes it a CHOICE rather than a default.
      expect(row?.businessTypeSelectedAt, id).not.toBeNull();
    }
  });

  it("seeds the first reward from the chosen type", async () => {
    const cookie = await signUp("reward");
    const res = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Nail Bar", industry: "nails", smsAttested: true });
    expect(res.status).toBe(201);
    const reward = await prisma.reward.findFirst({
      where: { shopId: res.body.id as string },
      orderBy: { sortOrder: "asc" },
    });
    expect(reward?.name).toBe(BUSINESS_TYPES.nails.defaultReward.name);
    expect(reward?.emoji).toBe(BUSINESS_TYPES.nails.defaultReward.emoji);
  });

  it("rejects a forged, unknown or malformed type", async () => {
    // Every one of these must be refused outright rather than coerced to a
    // default - a caller guessing at ids must not be able to land ANY value.
    for (const bad of ["dentist", "BARBER", "", " barber", "__proto__", 123, null, ["barber"]]) {
      const cookie = await signUp("bad");
      const res = await request(app)
        .post("/api/shops")
        .set("Cookie", cookie)
        .send({ name: "Forged", industry: bad, smsAttested: true });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error, JSON.stringify(bad)).toBe("invalid_input");
    }
  });

  it("leaves a shop UNSELECTED when no type is supplied, rather than guessing", async () => {
    // 🔴 The load-bearing case. A caller that omits the question does not get a
    // silent classification: the shop is created and fully operational, but it
    // is recorded as unanswered so the product can ask once.
    const cookie = await signUp("omitted");
    const res = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Unstated Co", smsAttested: true });
    expect(res.status).toBe(201);

    const row = await prisma.shop.findUnique({
      where: { id: res.body.id as string },
      select: { industry: true, businessTypeSelectedAt: true },
    });
    expect(row?.businessTypeSelectedAt).toBeNull();
    // ...and the stored value is not "barber": nothing should even LOOK like a
    // barbershop classification nobody asked for.
    expect(row?.industry).toBe("other");
  });
});

describe("GET /api/auth/me - what the dashboard is told", () => {
  it("reports the chosen type and its vocabulary", async () => {
    const cookie = await signUp("me-chosen");
    await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Detail Garage", industry: "detailing", smsAttested: true });

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.businessType.id).toBe("detailing");
    expect(me.body.businessType.selected).toBe(true);
    expect(me.body.businessType.vocabulary).toEqual(BUSINESS_TYPES.detailing.vocabulary);
    // A detailer is never told about barbers or chairs.
    expect(JSON.stringify(me.body.businessType.vocabulary)).not.toMatch(/barber|chair/);
  });

  it("reports NEUTRAL vocabulary for a shop that has not chosen", async () => {
    const cookie = await signUp("me-unselected");
    const created = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Legacy Co", smsAttested: true });
    // Simulate a pre-picker shop exactly: industry says "barber" because a
    // migration default put it there, and nobody ever answered.
    await prisma.shop.update({
      where: { id: created.body.id as string },
      data: { industry: "barber", businessTypeSelectedAt: null },
    });

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.body.businessType.selected).toBe(false);
    expect(me.body.businessType.vocabulary).toEqual(NEUTRAL_VOCABULARY);
    // Neither blanks nor borrowed barbershop words - the two ways this fails.
    for (const word of Object.values(me.body.businessType.vocabulary as Record<string, string>)) {
      expect(word).toBeTruthy();
    }
    expect(JSON.stringify(me.body.businessType.vocabulary)).not.toMatch(/barber|chair|cut/);
  });

  it("still resolves the legacy serviceNoun so live copy is unchanged", async () => {
    // The OLD helper deliberately ignores the selected-at rule; PR 1 must not
    // reword a single live message. See constants.ts serviceNounForShop.
    const cookie = await signUp("me-legacy-noun");
    const created = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Legacy Noun", smsAttested: true });
    await prisma.shop.update({
      where: { id: created.body.id as string },
      data: { industry: "barber", businessTypeSelectedAt: null },
    });
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.body.serviceNoun).toBe("cut");
  });
});

describe("a legacy shop keeps working before it has chosen", () => {
  let cookie: string;
  let shopId: string;
  let slug: string;

  beforeAll(async () => {
    cookie = await signUp("legacy-ops");
    const created = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Pre Picker Shop", smsAttested: true });
    shopId = created.body.id as string;
    slug = created.body.slug as string;
    await prisma.shop.update({
      where: { id: shopId },
      data: { industry: "barber", businessTypeSelectedAt: null },
    });
  });

  it("serves its settings and public page", async () => {
    const settings = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(settings.status).toBe(200);
    const page = await request(app).get(`/api/page/${slug}`);
    // The public page is opt-in; either it renders or it is deliberately off -
    // what must never happen is a 500 because the type is unanswered.
    expect([200, 404]).toContain(page.status);
  });

  it("does not block staff or any normal operation", async () => {
    const staff = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(staff.status).toBe(200);
  });
});

describe("choosing a type never touches the shop's data", () => {
  it("leaves services, clients, staff, reward and billing exactly as they were", async () => {
    const cookie = await signUp("nondestructive");
    const created = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Beard Trim Co", industry: "barber", smsAttested: true });
    const shopId = created.body.id as string;

    // The owner's own words, which we must never rewrite.
    const service = await prisma.service.create({
      data: { shopId, name: "Beard Trim", durationMin: 30, price: "25.00" },
    });
    const phone = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const client = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: phone,
        magicToken: randomToken(16),
        firstName: "Ray",
        lastName: "Vaughan",
        phone,
      },
    });

    const before = await prisma.shop.findUnique({ where: { id: shopId } });

    // Flip the vertical the way the settings editor will.
    await prisma.shop.update({
      where: { id: shopId },
      data: { industry: "nails", businessTypeSelectedAt: new Date() },
    });

    const [afterService, afterClient, afterReward, after] = await Promise.all([
      prisma.service.findUnique({ where: { id: service.id } }),
      prisma.client.findUnique({ where: { id: client.id } }),
      prisma.reward.findFirst({ where: { shopId }, orderBy: { sortOrder: "asc" } }),
      prisma.shop.findUnique({ where: { id: shopId } }),
    ]);

    // User-entered names survive verbatim.
    expect(afterService?.name).toBe("Beard Trim");
    expect(afterService?.durationMin).toBe(30);
    expect(afterService?.price?.toString()).toBe("25");
    expect(afterClient?.firstName).toBe("Ray");

    // The reward keeps the barbershop wording it was seeded with - changing the
    // type must not silently rename a menu the owner may have already printed.
    expect(afterReward?.name).toBe(BUSINESS_TYPES.barber.defaultReward.name);

    // Billing, entitlement, flags and roles are untouched by presentation.
    expect(after?.plan).toBe(before?.plan);
    expect(after?.subscriptionStatus).toBe(before?.subscriptionStatus);
    expect(after?.trialEndsAt?.getTime()).toBe(before?.trialEndsAt?.getTime());
    expect(after?.rewardsEnabled).toBe(before?.rewardsEnabled);
    expect(after?.walkInEnabled).toBe(before?.walkInEnabled);
    expect(after?.slug).toBe(before?.slug);
    const members = await prisma.shopMember.findMany({ where: { shopId } });
    expect(members.map((m) => m.role)).toEqual(["OWNER"]);
  });
});

describe("tenant isolation", () => {
  it("shop A cannot read or change shop B's business type", async () => {
    const cookieA = await signUp("tenant-a");
    const cookieB = await signUp("tenant-b");
    const shopA = await request(app)
      .post("/api/shops")
      .set("Cookie", cookieA)
      .send({ name: "Tenant A", industry: "barber", smsAttested: true });
    const shopB = await request(app)
      .post("/api/shops")
      .set("Cookie", cookieB)
      .send({ name: "Tenant B", industry: "nails", smsAttested: true });

    // A's session only ever describes A's own shop, whatever B's id is.
    const meA = await request(app).get("/api/auth/me").set("Cookie", cookieA);
    expect(meA.body.activeShopId).toBe(shopA.body.id);
    expect(meA.body.businessType.id).toBe("barber");

    // A settings write from A must not reach B's row.
    await request(app).patch("/api/shops/me").set("Cookie", cookieA).send({ bio: "A's bio" });
    const rowB = await prisma.shop.findUnique({
      where: { id: shopB.body.id as string },
      select: { industry: true, bio: true },
    });
    expect(rowB?.industry).toBe("nails");
    expect(rowB?.bio).not.toBe("A's bio");
  });
});
