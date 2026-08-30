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
 *   dbb2b6a               made it defaultless + required - the first real choice.
 *                        Committed 2026-06-28T22:58:42-04:00 == 2026-06-29T02:58:42Z.
 *
 * 🔴 THE CUTOFF IS 2026-06-30 00:00:00 UTC, NOT 06-29.
 *
 * An earlier draft used 06-29 00:00:00, which is 2h58m BEFORE dbb2b6a existed -
 * it would have claimed a choice for shops created while the defaultless picker
 * was still unwritten. The production deploy time could not be established
 * (GitHub retains only recent Preview deployments), so the boundary is the next
 * midnight after the commit: ~21h of slack.
 *
 * The two errors are NOT symmetric, which is why this may only ever move later:
 * a false NULL shows one legitimate shop the picker once; a false stamp
 * permanently claims a choice that shop never made.
 *
 * `Shop."createdAt"` is `timestamp WITHOUT time zone` holding UTC, so the bare
 * literal below is a UTC-to-UTC comparison no session TimeZone can shift.
 *
 * These tests exercise the RULE against synthetic rows on both sides of the
 * line, rather than re-running the migration (which has already applied).
 */
const app = createApp();

/**
 * The exact predicate in 20260829120000_business_type_selected_at.
 * 🔴 Keep byte-identical to the migration's literal.
 */
const CUTOFF = "2026-06-30 00:00:00";

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
    // 2026-06-13..06-29: the dropdown existed but defaulted to Barbershop, so a
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
});

/**
 * 🔴 THE BOUNDARY ITSELF.
 *
 * The predicate is `>=`, so the instant AT the cutoff is stamped and everything
 * strictly before it is not. These drive both sides to the millisecond, because
 * an off-by-one here is not a rounding error - it is a shop permanently credited
 * with a choice it never made.
 */
describe("the cutoff boundary, to the millisecond", () => {
  const AT = "2026-06-30T00:00:00.000Z";
  const JUST_BEFORE = "2026-06-29T23:59:59.999Z";
  const JUST_AFTER = "2026-06-30T00:00:00.001Z";

  async function selectedAtFor(iso: string): Promise<Date | null> {
    const id = await makeShopRow(new Date(iso), "barber");
    await applyBackfill(id);
    const row = await prisma.shop.findUnique({
      where: { id },
      select: { businessTypeSelectedAt: true },
    });
    return row?.businessTypeSelectedAt ?? null;
  }

  it("a shop created 1ms BEFORE the cutoff stays NULL", async () => {
    expect(await selectedAtFor(JUST_BEFORE)).toBeNull();
  });

  it("a shop created EXACTLY at the cutoff is stamped", async () => {
    const stamped = await selectedAtFor(AT);
    expect(stamped).not.toBeNull();
    expect(stamped?.toISOString()).toBe(AT);
  });

  it("a shop created 1ms AFTER the cutoff is stamped", async () => {
    expect(await selectedAtFor(JUST_AFTER)).not.toBeNull();
  });

  it("🔴 the cutoff is AFTER dbb2b6a existed", async () => {
    // dbb2b6a was committed 2026-06-29T02:58:42Z. A shop created at that exact
    // instant - the moment the defaultless picker's code first existed, before
    // any deploy - must NOT be treated as having chosen.
    expect(await selectedAtFor("2026-06-29T02:58:42.000Z")).toBeNull();
    // And the constant itself must be strictly later than the commit.
    expect(new Date(`${CUTOFF}Z`).getTime()).toBeGreaterThan(
      new Date("2026-06-29T02:58:42.000Z").getTime(),
    );
  });

  it("older shops are untouched by the boundary cases above", async () => {
    const id = await makeShopRow(new Date("2026-01-05T08:00:00.000Z"), "barber");
    await applyBackfill(id);
    const row = await prisma.shop.findUnique({
      where: { id },
      select: { businessTypeSelectedAt: true, industry: true },
    });
    expect(row?.businessTypeSelectedAt).toBeNull();
    expect(row?.industry).toBe("barber");
  });

  it("running the backfill twice is idempotent", async () => {
    // A re-run must not move a stamp that already records a real createdAt.
    const id = await makeShopRow(new Date("2026-08-01T10:15:00.000Z"), "nails");
    await applyBackfill(id);
    const first = (
      await prisma.shop.findUnique({ where: { id }, select: { businessTypeSelectedAt: true } })
    )?.businessTypeSelectedAt;
    await applyBackfill(id);
    const second = (
      await prisma.shop.findUnique({ where: { id }, select: { businessTypeSelectedAt: true } })
    )?.businessTypeSelectedAt;
    expect(first).not.toBeNull();
    expect(second?.toISOString()).toBe(first?.toISOString());
  });

  it("re-running does not resurrect a shop an owner has since re-answered", async () => {
    // The migration writes `= "createdAt"`, so a later human choice would be
    // overwritten if it ever ran again. It is a one-shot migration, but the
    // predicate must at least never touch a PRE-cutoff row.
    const id = await makeShopRow(new Date("2026-05-01T12:00:00.000Z"), "barber");
    const chosen = new Date("2026-08-15T09:00:00.000Z");
    await prisma.shop.update({ where: { id }, data: { businessTypeSelectedAt: chosen } });
    await applyBackfill(id);
    const row = await prisma.shop.findUnique({
      where: { id },
      select: { businessTypeSelectedAt: true },
    });
    expect(row?.businessTypeSelectedAt?.toISOString()).toBe(chosen.toISOString());
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
