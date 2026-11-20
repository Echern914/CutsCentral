import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { fairChairOrder } from "@chairback/config/fairChair";
import { createApp } from "../app.js";

/**
 * GET /api/book/:slug/day - an "any available" booking is shared out fairly.
 *
 * A shop with several people working shows ONE list of times. Each time
 * carries the ids of everyone free then, and the page books the FIRST id. That
 * list used to come out in the order the database returned the service links,
 * which is the order the chairs were created in - so the first chair took
 * nearly every booking from a customer who did not mind who cut their hair.
 *
 * Now the person with the fewest bookings that day leads, and a tie is broken
 * by a hash of the day and the person (config/fairChair.ts), so no one is first
 * every day. A one-person shop is untouched.
 */
const app = createApp();
const userIds: string[] = [];

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Three days out: well clear of "now" and of the lead time, in a UTC shop. */
const date = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
const dayStart = new Date(`${date}T00:00:00.000Z`).getTime();
const at = (hour: number) => new Date(dayStart + hour * HOUR);

interface Slot {
  startsAt: string;
  staffIds: string[];
}
interface DayBody {
  bundles: { services: { id: string; slots: Slot[] }[] }[];
  ungrouped: { id: string; slots: Slot[] }[];
}

async function makeShop(staffNames: string[]) {
  const user = await prisma.user.create({
    data: { email: `fairchair-${randomToken(6)}@test.chairback`, name: "F" },
    select: { id: true },
  });
  userIds.push(user.id);
  const slug = `fair-${randomToken(5)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Fair Chair",
      slug,
      webhookSecret: randomToken(),
      bookingMode: "native",
      publicPageEnabled: true,
      timezone: "UTC",
      bookingLeadMinutes: 0,
      bookingMaxDays: 30,
    },
    select: { id: true },
  });
  const service = await prisma.service.create({
    data: { shopId: shop.id, name: "Cut", durationMin: 60, price: 30 },
    select: { id: true },
  });
  const staffIds: string[] = [];
  // Created one at a time so creation order (the OLD winner) is unambiguous.
  for (const [index, name] of staffNames.entries()) {
    const staff = await prisma.staff.create({
      data: { shopId: shop.id, name, sortOrder: index },
      select: { id: true },
    });
    staffIds.push(staff.id);
    await prisma.serviceStaff.create({
      data: { shopId: shop.id, serviceId: service.id, staffId: staff.id },
    });
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        shopId: shop.id,
        staffId: staff.id,
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });
  }
  return { shopId: shop.id, slug, serviceId: service.id, staffIds };
}

async function book(
  shop: { shopId: string; serviceId: string },
  staffId: string,
  hour: number,
  extra: { status?: "BOOKED" | "PENDING" | "CANCELED" | "COMPLETED" | "NO_SHOW"; holdExpiresAt?: Date } = {},
): Promise<string> {
  const row = await prisma.appointment.create({
    data: {
      shopId: shop.shopId,
      staffId,
      serviceId: shop.serviceId,
      firstName: "Test",
      status: extra.status ?? "BOOKED",
      holdExpiresAt: extra.holdExpiresAt ?? null,
      startsAt: at(hour),
      endsAt: at(hour + 1),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return row.id;
}

async function slotsFor(slug: string): Promise<Slot[]> {
  const res = await request(app).get(`/api/book/${slug}/day?date=${date}`);
  expect(res.status).toBe(200);
  const body = res.body as DayBody;
  return [...body.bundles.flatMap((b) => b.services), ...body.ungrouped].flatMap((s) => s.slots);
}

/** The slot at a given hour - one everyone in the test is free for. */
async function slotAt(slug: string, hour: number): Promise<Slot> {
  const slot = (await slotsFor(slug)).find((s) => s.startsAt === at(hour).toISOString());
  expect(slot, `no ${hour}:00 slot`).toBeTruthy();
  return slot!;
}

let trio: Awaited<ReturnType<typeof makeShop>>;
let ana: string;
let ben: string;
let cy: string;

beforeAll(async () => {
  trio = await makeShop(["Ana", "Ben", "Cy"]);
  [ana, ben, cy] = trio.staffIds as [string, string, string];
});

// Each test starts from an empty book. Here and not at the end of each test,
// so one failed assertion cannot leave rows behind that fail the tests after it.
afterEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId: trio.shopId } });
});

afterAll(async () => {
  for (const id of userIds) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("GET /:slug/day - whose turn an 'any available' booking is", () => {
  it("with nobody booked, everyone rides the slot and the tie order is the shared rule's", async () => {
    const slot = await slotAt(trio.slug, 15);
    expect([...slot.staffIds].sort()).toEqual([ana, ben, cy].sort());
    expect(slot.staffIds).toEqual(fairChairOrder([ana, ben, cy], new Map(), date));
  });

  it("🔴 the first chair created no longer leads once it holds more bookings than the others", async () => {
    // Ana (created first - the old permanent winner) has 2, Ben 1, Cy none.
    await book(trio, ana, 9);
    await book(trio, ana, 10);
    await book(trio, ben, 9);
    const slot = await slotAt(trio.slug, 15);
    expect(slot.staffIds).toEqual([cy, ben, ana]);
  });

  it("the order follows the bookings: whoever was last leads once the others fill up", async () => {
    await book(trio, cy, 9);
    await book(trio, cy, 10);
    await book(trio, ben, 9);
    const slot = await slotAt(trio.slug, 15);
    expect(slot.staffIds).toEqual([ana, ben, cy]);
  });

  it("a visit already done that day still counts", async () => {
    await book(trio, ana, 9, { status: "COMPLETED" });
    await book(trio, ben, 9, { status: "COMPLETED" });
    expect((await slotAt(trio.slug, 15)).staffIds[0]).toBe(cy);
  });

  it("🔴 a canceled booking, a no-show and a receptionist hold do not count against anyone", async () => {
    await book(trio, ana, 9, { status: "CANCELED" });
    await book(trio, ana, 10, { status: "NO_SHOW" });
    await book(trio, ana, 11, {
      status: "PENDING",
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    // Nothing counted for anyone: the plain tie order.
    expect((await slotAt(trio.slug, 15)).staffIds).toEqual(
      fairChairOrder([ana, ben, cy], new Map(), date),
    );
  });

  it("a request waiting on the shop does count", async () => {
    await book(trio, ana, 9, { status: "PENDING" });
    await book(trio, ben, 9, { status: "PENDING" });
    expect((await slotAt(trio.slug, 15)).staffIds[0]).toBe(cy);
  });

  it("only that day's bookings count: a full day before does not push anyone back", async () => {
    await prisma.appointment.create({
      data: {
        shopId: trio.shopId,
        staffId: ana,
        serviceId: trio.serviceId,
        firstName: "Yesterday",
        status: "BOOKED",
        startsAt: new Date(at(9).getTime() - DAY),
        endsAt: new Date(at(10).getTime() - DAY),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    expect((await slotAt(trio.slug, 15)).staffIds).toEqual(
      fairChairOrder([ana, ben, cy], new Map(), date),
    );
  });

  it("a time only one person is free for still lists only that person", async () => {
    await book(trio, ana, 13);
    await book(trio, ben, 13);
    expect((await slotAt(trio.slug, 13)).staffIds).toEqual([cy]);
  });
});

describe("GET /:slug/day - a one-person shop is unchanged", () => {
  it("🔴 every time lists the one person, however many bookings they hold", async () => {
    const solo = await makeShop(["Solo"]);
    const [only] = solo.staffIds as [string];
    const before = await slotsFor(solo.slug);
    expect(before.length).toBeGreaterThan(0);
    for (const s of before) expect(s.staffIds).toEqual([only]);

    await book(solo, only, 9);
    await book(solo, only, 10);
    const after = await slotsFor(solo.slug);
    for (const s of after) expect(s.staffIds).toEqual([only]);
    // The same times as before, less the two that were just booked.
    expect(after.map((s) => s.startsAt)).toEqual(
      before
        .map((s) => s.startsAt)
        .filter((t) => t !== at(9).toISOString() && t !== at(10).toISOString()),
    );
  });
});

describe("GET /:slug - each person's working days", () => {
  it("sends the weekdays each person keeps hours, so the page can grey the days they are off", async () => {
    const shop = await makeShop(["Dee", "Eli"]);
    const [dee, eli] = shop.staffIds as [string, string];
    // Eli only works Tuesdays and Thursdays.
    await prisma.availabilityRule.deleteMany({
      where: { staffId: eli, weekday: { notIn: [2, 4] } },
    });
    const res = await request(app).get(`/api/book/${shop.slug}`);
    expect(res.status).toBe(200);
    const staff = res.body.staff as { id: string; weekdays: number[] }[];
    expect(staff.find((s) => s.id === dee)!.weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(staff.find((s) => s.id === eli)!.weekdays).toEqual([2, 4]);
  });
});
