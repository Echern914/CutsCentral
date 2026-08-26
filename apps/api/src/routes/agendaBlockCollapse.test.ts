import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Duplicate external blocks, end to end.
 *
 * The unit tests in engines/externalBlockCollapse.test.ts prove the grouping;
 * these prove the AGENDA actually applies it, which is the part that was
 * broken on Drick's calendar: four byte-identical "7:15 PM - 11:15 PM · Acuity
 * · 4h" bands on one Wednesday, each saying "Remove this in Acuity".
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

async function shopWithBlocks(tag: string): Promise<{ cookie: string; shopId: string }> {
  const email = `blockdupe-${tag}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Block Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Block ${tag}`, bookingUrl: "https://blk.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const shopId = shop.body.id as string;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });
  return { cookie, shopId };
}

/** ExternalBlock is FORCE RLS, so seeding has to carry the shop context. */
async function seedBlocks(
  shopId: string,
  rows: {
    externalId: string;
    startsAt: Date;
    endsAt: Date;
    reason?: string | null;
    externalCalendarId?: string | null;
  }[],
): Promise<void> {
  await runWithShop(shopId, async (tx) => {
    for (const r of rows) {
      await tx.externalBlock.create({
        data: {
          shopId,
          externalId: r.externalId,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          reason: r.reason ?? null,
          externalCalendarId: r.externalCalendarId ?? null,
        },
      });
    }
  });
}

const windowQs = () =>
  `from=${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}` +
  `&to=${encodeURIComponent(new Date(Date.now() + 30 * 864e5).toISOString())}`;

const agenda = async (cookie: string) => {
  const res = await request(app)
    .get(`/api/booking/agenda?${windowQs()}`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.agenda as {
    source: string;
    start: string;
    end: string;
    duplicateCount?: number;
    clientName: string;
  }[];
};

// A 4h evening block, tomorrow — the exact shape from the real calendar.
const START = new Date(Date.now() + 24 * 60 * 60 * 1000);
const END = new Date(START.getTime() + 4 * 60 * 60 * 1000);

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("GET /api/booking/agenda — duplicate external blocks", () => {
  it("returns ONE row for four identical blocks, counted", async () => {
    const { cookie, shopId } = await shopWithBlocks("four");
    await seedBlocks(
      shopId,
      [1, 2, 3, 4].map((n) => ({
        externalId: `acuity:${n}`,
        startsAt: START,
        endsAt: END,
        externalCalendarId: "14200364",
      })),
    );

    const rows = (await agenda(cookie)).filter((r) => r.source === "block");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.duplicateCount).toBe(4);
    // The span still has to be the real one, not a merged invention.
    expect(rows[0]!.start).toBe(START.toISOString());
    expect(rows[0]!.end).toBe(END.toISOString());
  });

  it("reports 1 for a lone block", async () => {
    const { cookie, shopId } = await shopWithBlocks("one");
    await seedBlocks(shopId, [
      { externalId: "acuity:solo", startsAt: START, endsAt: END },
    ]);
    const rows = (await agenda(cookie)).filter((r) => r.source === "block");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.duplicateCount).toBe(1);
  });

  it("keeps overlapping blocks with different ends SEPARATE", async () => {
    // The dangerous direction. 7:15-11:15 and 7:15-9:15 are two different
    // answers to "when does the chair free up"; merging invents a third.
    const { cookie, shopId } = await shopWithBlocks("overlap");
    const shortEnd = new Date(START.getTime() + 2 * 60 * 60 * 1000);
    await seedBlocks(shopId, [
      { externalId: "acuity:long", startsAt: START, endsAt: END },
      { externalId: "acuity:short", startsAt: START, endsAt: shortEnd },
    ]);

    const rows = (await agenda(cookie)).filter((r) => r.source === "block");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.end).sort()).toEqual(
      [END.toISOString(), shortEnd.toISOString()].sort(),
    );
  });

  it("keeps same-span blocks with different notes SEPARATE", async () => {
    // Hiding "Dentist" under "Lunch" swaps one wrong display for another.
    const { cookie, shopId } = await shopWithBlocks("notes");
    await seedBlocks(shopId, [
      { externalId: "acuity:l", startsAt: START, endsAt: END, reason: "Lunch" },
      { externalId: "acuity:d", startsAt: START, endsAt: END, reason: "Dentist" },
    ]);

    const rows = (await agenda(cookie)).filter((r) => r.source === "block");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.clientName).sort()).toEqual(["Dentist", "Lunch"]);
  });

  it("keeps identical spans on different calendars SEPARATE", async () => {
    // Two barbers each blocking the same evening is two real blocks.
    const { cookie, shopId } = await shopWithBlocks("cals");
    await seedBlocks(shopId, [
      { externalId: "acuity:c1", startsAt: START, endsAt: END, externalCalendarId: "1" },
      { externalId: "acuity:c2", startsAt: START, endsAt: END, externalCalendarId: "2" },
    ]);

    const rows = (await agenda(cookie)).filter((r) => r.source === "block");
    expect(rows).toHaveLength(2);
  });
});
