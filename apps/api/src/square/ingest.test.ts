import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import type { SquareBooking, SquareCustomer } from "./types.js";

/**
 * Square ingest: a Booking becomes a Visit through the same idempotent path as
 * Acuity. Asserts: first ingest creates a SCHEDULED Visit + a client from the
 * Square customer; re-ingest is idempotent (no duplicate Visit); a Square-sourced
 * client gets NO auto SMS consent; a retro-cancel after the visit was promoted to
 * COMPLETED claws the phantom punch back out.
 */
const CUSTOMER: SquareCustomer = {
  id: "cust_1",
  given_name: "Sam",
  family_name: "Stone",
  phone_number: "+13025551234",
  email_address: "sam@example.com",
};

let currentBooking: SquareBooking = {
  id: "bk_1",
  status: "ACCEPTED",
  start_at: "2026-01-15T15:00:00Z",
  location_id: "loc_1",
  customer_id: "cust_1",
  appointment_segments: [{ duration_minutes: 30 }],
};

vi.mock("./client.js", () => ({
  getSquareClientForShop: vi.fn(async () => ({
    getBooking: async () => currentBooking,
    getCustomer: async () => CUSTOMER,
    listBookings: async () => ({ bookings: [], cursor: null }),
  })),
  squareEnabled: () => true,
  NotConnectedError: class extends Error {},
  SquareError: class extends Error {},
  refreshAccessToken: async () => "tok",
}));

const { ingestSquareBooking } = await import("./ingest.js");
const { earnPunchForVisit } = await import("../services/punch.js");

let userId: string;
let shopId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sq-${randomToken(6)}@test.local`, passwordHash: "x", name: "SQ" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      rewardsEnabled: true, // rewards are opt-IN for new shops; this suite exercises loyalty
      ownerId: userId,
      name: "SQ Shop",
      bookingUrl: "https://sq.test",
      webhookSecret: randomToken(),
      punchesPerVisit: 1,
    },
  });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

async function getShop() {
  return prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
}

describe("ingestSquareBooking", () => {
  it("creates a SCHEDULED visit + client, with NO auto SMS consent", async () => {
    currentBooking = { ...currentBooking, status: "ACCEPTED" };
    await ingestSquareBooking(await getShop(), "bk_1");

    const visit = await prisma.visit.findUnique({
      where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: "square:bk_1" } },
      include: { client: true },
    });
    expect(visit).not.toBeNull();
    expect(visit!.status).toBe("SCHEDULED");
    expect(visit!.client.phone).toBe("+13025551234");
    // Square has no intake consent checkbox -> never auto-consent.
    expect(visit!.client.smsConsentAt).toBeNull();
    expect(visit!.client.smsConsentSource).toBeNull();
  });

  it("is idempotent: re-ingesting the same booking makes no duplicate", async () => {
    await ingestSquareBooking(await getShop(), "bk_1");
    const count = await prisma.visit.count({
      where: { shopId, acuityAppointmentId: "square:bk_1" },
    });
    expect(count).toBe(1);
  });

  it("a retro-cancel after promotion claws back the phantom punch", async () => {
    // Promote the visit to COMPLETED and earn a punch (what the scheduler does).
    const visit = await prisma.visit.findUniqueOrThrow({
      where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: "square:bk_1" } },
    });
    await prisma.visit.update({
      where: { id: visit.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    const shop = await getShop();
    const earn = await earnPunchForVisit(shop, visit.clientId, visit.id, null, new Date());
    expect(earn).not.toBeNull();
    const balanceAfterEarn = await prisma.punchLedger.aggregate({
      where: { shopId, clientId: visit.clientId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const earned = balanceAfterEarn._sum.punchesEarned ?? 0;
    expect(earned).toBeGreaterThan(0);

    // Now Square reports the booking cancelled -> ingest must claw back the earn.
    currentBooking = { ...currentBooking, status: "CANCELLED_BY_CUSTOMER" };
    await ingestSquareBooking(await getShop(), "bk_1");

    const after = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(after.status).toBe("CANCELED");
    // Net punches back to zero (earn + offsetting claw-back correction row).
    const net = await prisma.punchLedger.aggregate({
      where: { shopId, clientId: visit.clientId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const netBalance = (net._sum.punchesEarned ?? 0) - (net._sum.punchesRedeemed ?? 0);
    expect(netBalance).toBe(0);
  });
});
