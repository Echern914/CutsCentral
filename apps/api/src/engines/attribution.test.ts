import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addDays, randomToken } from "@chairback/config";
import { forShop, prisma } from "@chairback/db";
import { linkBookingsToNudges } from "./attribution.js";

/**
 * Booking attribution is kind-aware: a rebooking nudge/promo uses a 7-day
 * window, a win-back uses 14 (the deeply-lapsed re-engage slower). This proves
 * the win-back window is actually applied — the bug the review caught was that
 * WINBACK.attributionWindowDays was dead config and win-backs silently used 7.
 */

const NOW = new Date("2026-06-20T12:00:00Z");

let userId: string;
let shopId: string;

/** A SENT nudge of `kind` sent `daysAgo`, plus a visit the client booked
 *  `bookedDaysAfterSend` days after the send. Returns the nudge id. */
async function seedNudgeAndBooking(
  kind: string,
  daysAgo: number,
  bookedDaysAfterSend: number,
): Promise<string> {
  const db = forShop(shopId);
  const key = `tel:+1302${Math.floor(1000000 + Math.random() * 8999999)}`;
  const client = await db.client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
    create: { acuityClientKey: key, magicToken: randomToken(), firstName: "A" },
    update: {},
  });
  const sentAt = addDays(NOW, -daysAgo);
  const nudge = await db.nudge.create({
    data: { clientId: client.id, channel: "SMS", status: "SENT", kind, body: "x", sentAt },
  });
  // The booking, created (booked) bookedDaysAfterSend days after the send. Uses
  // upsert (the scoped accessor exposes no .create for visit).
  const apptKey = `a-${randomToken(6)}`;
  await db.visit.upsert({
    where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: apptKey } },
    create: {
      clientId: client.id,
      acuityAppointmentId: apptKey,
      status: "SCHEDULED",
      scheduledAt: addDays(sentAt, bookedDaysAfterSend + 2),
      createdAt: addDays(sentAt, bookedDaysAfterSend),
    },
    update: {},
  });
  return nudge.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `attr-${randomToken(6)}@test.local`, passwordHash: "x", name: "A" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Attr Shop",
      bookingUrl: "https://attr.test",
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
});

afterEach(async () => {
  // Plain prisma for cleanup: the scoped forShop() accessor intentionally exposes
  // no deleteMany for visit/client. Order: nudge -> visit -> client (FKs).
  await prisma.nudge.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

// Assertions check the SPECIFIC nudge's resultedInBookingAt, not the global
// `linked` count: linkBookingsToNudges scans ALL shops' unattributed nudges, so
// a sibling case's rows could inflate a count-based assertion. The per-row check
// is order- and cross-file-independent.
describe("linkBookingsToNudges (kind-aware window)", () => {
  it("attributes a booking 3 days after a regular nudge (within 7d)", async () => {
    const id = await seedNudgeAndBooking("nudge", 4, 3);
    await linkBookingsToNudges(NOW);
    const n = await prisma.nudge.findUnique({ where: { id } });
    expect(n?.resultedInBookingAt).not.toBeNull();
  });

  it("does NOT attribute a booking 10 days after a regular nudge (past 7d)", async () => {
    const id = await seedNudgeAndBooking("nudge", 11, 10);
    await linkBookingsToNudges(NOW);
    const n = await prisma.nudge.findUnique({ where: { id } });
    expect(n?.resultedInBookingAt).toBeNull();
  });

  it("DOES attribute a booking 10 days after a WIN-BACK (within 14d)", async () => {
    // This is the bug the review caught: with the old 7-day-for-all logic this
    // win-back booking would be missed, under-counting recovered revenue.
    const id = await seedNudgeAndBooking("winback", 11, 10);
    await linkBookingsToNudges(NOW);
    const n = await prisma.nudge.findUnique({ where: { id } });
    expect(n?.resultedInBookingAt).not.toBeNull();
  });

  it("does NOT attribute a booking 16 days after a win-back (past 14d)", async () => {
    const id = await seedNudgeAndBooking("winback", 17, 16);
    await linkBookingsToNudges(NOW);
    const n = await prisma.nudge.findUnique({ where: { id } });
    expect(n?.resultedInBookingAt).toBeNull();
  });
});
