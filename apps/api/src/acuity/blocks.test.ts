import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { syncAcuityBlocks } from "./blocks.js";
import type { AcuityBlock } from "./types.js";

/**
 * Acuity BLOCKED-OFF TIME sync. The contract that matters: a block the barber
 * removes in Acuity has no "canceled" flag - its ABSENCE from the response is
 * the only signal - so this reconciles (upsert + delete-what's-missing) rather
 * than only upserting. And it must never reach outside the synced window, or a
 * narrow sweep would wipe blocks it never asked about.
 */
let userId: string;
let shopId: string;

const block = (id: string, start: string, end: string, extra: Partial<AcuityBlock> = {}) =>
  ({ id, start, end, ...extra }) as AcuityBlock;

const WIN_FROM = new Date("2026-08-01T00:00:00Z");
const WIN_TO = new Date("2026-08-31T00:00:00Z");

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `blk-${randomToken(6)}@test.local`, passwordHash: "x", name: "B" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Block Shop",
      bookingUrl: "https://blk.test",
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const rows = () =>
  prisma.externalBlock.findMany({ where: { shopId }, orderBy: { startsAt: "asc" } });

describe("syncAcuityBlocks", () => {
  it("stores blocks, keyed so a re-sync updates instead of duplicating", async () => {
    const res = await syncAcuityBlocks(
      shopId,
      [
        block("1", "2026-08-04T14:00:00Z", "2026-08-04T16:00:00Z", { notes: "Lunch" }),
        block("2", "2026-08-06T09:00:00Z", "2026-08-06T17:00:00Z", { calendarID: 42 }),
      ],
      WIN_FROM,
      WIN_TO,
    );
    expect(res.upserted).toBe(2);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[0]!.externalId).toBe("acuity:1");
    expect(all[0]!.reason).toBe("Lunch");
    expect(all[1]!.externalCalendarId).toBe("42");

    // Same ids, MOVED time: updated in place, still two rows.
    await syncAcuityBlocks(
      shopId,
      [
        block("1", "2026-08-04T15:00:00Z", "2026-08-04T18:00:00Z", { notes: "Longer lunch" }),
        block("2", "2026-08-06T09:00:00Z", "2026-08-06T17:00:00Z"),
      ],
      WIN_FROM,
      WIN_TO,
    );
    const after = await rows();
    expect(after).toHaveLength(2);
    expect(after[0]!.startsAt.toISOString()).toBe("2026-08-04T15:00:00.000Z");
    expect(after[0]!.reason).toBe("Longer lunch");
  });

  it("DELETES a block the barber removed in Acuity (absence is the only signal)", async () => {
    const res = await syncAcuityBlocks(
      shopId,
      [block("2", "2026-08-06T09:00:00Z", "2026-08-06T17:00:00Z")],
      WIN_FROM,
      WIN_TO,
    );
    expect(res.removed).toBe(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.externalId).toBe("acuity:2");
  });

  it("never touches blocks outside the synced window", async () => {
    // A block in September, synced by a wide sweep...
    await syncAcuityBlocks(
      shopId,
      [block("9", "2026-09-10T12:00:00Z", "2026-09-10T13:00:00Z")],
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-30T00:00:00Z"),
    );
    expect((await rows()).some((r) => r.externalId === "acuity:9")).toBe(true);

    // ...must survive a later NARROW sweep of August that doesn't mention it.
    await syncAcuityBlocks(
      shopId,
      [block("2", "2026-08-06T09:00:00Z", "2026-08-06T17:00:00Z")],
      WIN_FROM,
      WIN_TO,
    );
    const all = await rows();
    expect(all.map((r) => r.externalId).sort()).toEqual(["acuity:2", "acuity:9"]);
  });

  it("skips unusable rows instead of throwing the sweep away", async () => {
    const res = await syncAcuityBlocks(
      shopId,
      [
        block("bad-1", "not a date", "2026-08-07T10:00:00Z"),
        block("bad-2", "2026-08-07T10:00:00Z", "2026-08-07T09:00:00Z"), // ends before it starts
        { id: "bad-3" } as AcuityBlock, // no times at all
        block("good", "2026-08-08T10:00:00Z", "2026-08-08T11:00:00Z"),
      ],
      WIN_FROM,
      WIN_TO,
    );
    expect(res.skipped).toBe(3);
    expect((await rows()).some((r) => r.externalId === "acuity:good")).toBe(true);
  });

  it("accepts the startTime/endTime spelling and falls back to description", async () => {
    await syncAcuityBlocks(
      shopId,
      [
        {
          id: "alt",
          startTime: "2026-08-09T10:00:00Z",
          endTime: "2026-08-09T12:00:00Z",
          description: "Wednesday 10am - 12pm",
        } as AcuityBlock,
      ],
      WIN_FROM,
      WIN_TO,
    );
    const alt = (await rows()).find((r) => r.externalId === "acuity:alt");
    expect(alt).toBeDefined();
    expect(alt!.endsAt.toISOString()).toBe("2026-08-09T12:00:00.000Z");
    expect(alt!.reason).toBe("Wednesday 10am - 12pm");
  });

  it("never deletes another shop's blocks", async () => {
    const other = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Other",
        bookingUrl: "https://o.test",
        webhookSecret: randomToken(),
      },
    });
    await syncAcuityBlocks(
      other.id,
      [block("x", "2026-08-04T14:00:00Z", "2026-08-04T16:00:00Z")],
      WIN_FROM,
      WIN_TO,
    );
    // A sweep of THIS shop that returns nothing clears only this shop.
    await syncAcuityBlocks(shopId, [], WIN_FROM, WIN_TO);
    expect(await prisma.externalBlock.count({ where: { shopId: other.id } })).toBe(1);
    await prisma.shop.delete({ where: { id: other.id } });
  });
});
