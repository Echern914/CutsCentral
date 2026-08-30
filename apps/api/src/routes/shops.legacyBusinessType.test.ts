import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { NEUTRAL_VOCABULARY, randomToken, vocabularyForShop } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Legacy shops: the ones that predate the business-type question.
 *
 * The migration's whole job is to tell apart "chose Barbershop" from "a default
 * put Barbershop there". Two commits set the line:
 *   a249a68 (2026-06-13) shipped the picker PRE-SELECTED to barber - a shop
 *                        whose owner never touched it still submitted "barber".
 *   dbb2b6a (2026-06-28) made it defaultless + required - the first real choice.
 * So only shops created from the cutoff forward are treated as having answered.
 *
 * These tests exercise the RULE against synthetic rows on both sides of the
 * line, rather than re-running the migration (which has already applied).
 */
const app = createApp();

/** The exact predicate in 20260829120000_business_type_selected_at. */
const CUTOFF = "2026-06-29 00:00:00";

/** Every row this file creates, so cleanup can be exact rather than broad. */
const createdShopIds: string[] = [];
const createdUserIds: string[] = [];

async function makeShopRow(createdAt: Date, industry: string): Promise<string> {
  const owner = await prisma.user.create({
    data: {
      email: `legacy-${randomToken(8)}@test.local`.toLowerCase(),
      name: "Legacy Owner",
      smsAttestedAt: new Date(),
    },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: owner.id,
      name: "Legacy Shop",
      slug: `legacy-${randomToken(8)}`.toLowerCase(),
      webhookSecret: randomToken(),
      industry,
      // Every row starts unselected; the backfill below decides.
      businessTypeSelectedAt: null,
    },
  });
  createdUserIds.push(owner.id);
  createdShopIds.push(shop.id);
  // createdAt has a DB default, so set it explicitly to place the row in a cohort.
  await prisma.$executeRawUnsafe(
    `UPDATE "Shop" SET "createdAt" = $1::timestamp WHERE id = $2`,
    createdAt.toISOString(),
    shop.id,
  );
  return shop.id;
}

/** Re-run the migration's UPDATE, scoped to one row. */
async function applyBackfill(shopId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "Shop" SET "businessTypeSelectedAt" = "createdAt"
       WHERE id = $1 AND "createdAt" >= TIMESTAMP '${CUTOFF}'`,
    shopId,
  );
}

afterAll(async () => {
  // 🔴 Guard the id lists. Prisma reads `{ id: { in: [] } }` safely, but a bare
  // `{ shopId: undefined }` would match EVERY row - that is how one broken setup
  // hook wipes a shared test DB and makes unrelated files fail at random.
  if (createdShopIds.length > 0) {
    await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe("the backfill cohort rule", () => {
  it("leaves a pre-picker shop UNSELECTED even though it stores 'barber'", async () => {
    const id = await makeShopRow(new Date("2026-05-01T12:00:00.000Z"), "barber");
    await applyBackfill(id);
    const row = await prisma.shop.findUnique({
      where: { id },
      select: { industry: true, businessTypeSelectedAt: true },
    });
    expect(row?.industry).toBe("barber");
    expect(row?.businessTypeSelectedAt).toBeNull();
    // ...so it speaks neutrally rather than as a barbershop.
    expect(vocabularyForShop(row!)).toEqual(NEUTRAL_VOCABULARY);
  });

  it("leaves the PRE-SELECTED-picker cohort unselected too", async () => {
    // 2026-06-13..06-28: the dropdown existed but defaulted to Barbershop, so a
    // stored "barber" is still not an answer. This is the subtle cohort, and
    // getting it wrong would mislabel real shops permanently.
    const id = await makeShopRow(new Date("2026-06-20T12:00:00.000Z"), "barber");
    await applyBackfill(id);
    const row = await prisma.shop.findUnique({
      where: { id },
      select: { businessTypeSelectedAt: true },
    });
    expect(row?.businessTypeSelectedAt).toBeNull();
  });

  it("stamps a post-cutoff shop from its OWN createdAt", async () => {
    const createdAt = new Date("2026-07-15T09:30:00.000Z");
    const id = await makeShopRow(createdAt, "nails");
    await applyBackfill(id);
    const row = await prisma.shop.findUnique({
      where: { id },
      select: { businessTypeSelectedAt: true, createdAt: true },
    });
    expect(row?.businessTypeSelectedAt).not.toBeNull();
    // The timestamp records something true rather than inventing a moment.
    expect(row?.businessTypeSelectedAt?.getTime()).toBe(row?.createdAt.getTime());
  });

  it("never invents an industry - the backfill only ever writes the timestamp", async () => {
    const id = await makeShopRow(new Date("2026-07-15T09:30:00.000Z"), "lashes");
    await applyBackfill(id);
    const row = await prisma.shop.findUnique({ where: { id }, select: { industry: true } });
    expect(row?.industry).toBe("lashes");
  });
});

describe("an unselected shop renders correctly everywhere", () => {
  it("speaks neutral words, not blanks and not barbershop", async () => {
    const id = await makeShopRow(new Date("2026-05-01T12:00:00.000Z"), "barber");
    const row = await prisma.shop.findUnique({
      where: { id },
      select: { industry: true, serviceNoun: true, businessTypeSelectedAt: true },
    });
    const v = vocabularyForShop(row!);

    // The two ways this fails, asserted separately so a failure names itself.
    for (const [field, word] of Object.entries(v)) {
      expect(word, `blank ${field}`).toBeTruthy();
    }
    expect(JSON.stringify(v)).not.toMatch(/barber|chair|haircut/);

    // And it is complete - every key the vocabulary contract promises.
    expect(Object.keys(v).sort()).toEqual(Object.keys(NEUTRAL_VOCABULARY).sort());
  });

  it("still serves its public page without a 500", async () => {
    const id = await makeShopRow(new Date("2026-05-01T12:00:00.000Z"), "barber");
    const shop = await prisma.shop.findUnique({ where: { id }, select: { slug: true } });
    const res = await request(app).get(`/api/page/${shop!.slug}`);
    // Public pages are opt-in; a 404 is a legitimate answer. A 500 is not.
    expect([200, 404]).toContain(res.status);
  });

  it("keeps its custom visit-noun if the owner had set one", async () => {
    const id = await makeShopRow(new Date("2026-05-01T12:00:00.000Z"), "barber");
    await prisma.shop.update({ where: { id }, data: { serviceNoun: "twist" } });
    const row = await prisma.shop.findUnique({
      where: { id },
      select: { industry: true, serviceNoun: true, businessTypeSelectedAt: true },
    });
    // The TYPE is unknown; the owner's own word is not, and must survive.
    const v = vocabularyForShop(row!);
    expect(v.serviceNoun).toBe("twist");
    expect(v.providerNoun).toBe(NEUTRAL_VOCABULARY.providerNoun);
  });
});
