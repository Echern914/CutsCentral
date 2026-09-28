import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import type { SquareBooking, SquareCustomer } from "./types.js";
import { suppressionAddressHash } from "../engines/broadcastAudience.js";

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

/** The customer Square returns; a case may swap it. */
let currentCustomer: SquareCustomer = CUSTOMER;

vi.mock("./client.js", () => ({
  getSquareClientForShop: vi.fn(async () => ({
    getBooking: async () => currentBooking,
    getCustomer: async () => currentCustomer,
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

describe("a Square email unsubscribe carries over - and is never undone", () => {
  const booking = (id: string, customerId: string): SquareBooking => ({
    id,
    status: "ACCEPTED",
    start_at: "2026-01-20T15:00:00Z",
    location_id: "loc_1",
    customer_id: customerId,
    appointment_segments: [{ duration_minutes: 30 }],
  });
  const customer = (id: string, phone: string, unsubscribed: boolean | null): SquareCustomer => ({
    id,
    given_name: "Una",
    phone_number: phone,
    email_address: `${id}@example.com`,
    preferences: unsubscribed === null ? null : { email_unsubscribed: unsubscribed },
  });
  const ingestAs = async (c: SquareCustomer, bookingId: string) => {
    currentCustomer = c;
    currentBooking = booking(bookingId, c.id);
    await ingestSquareBooking(await getShop(), bookingId);
  };
  const byPhone = (phone: string) =>
    prisma.client.findUniqueOrThrow({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey: `tel:${phone}` } },
    });

  it("a customer Square says unsubscribed arrives opted out of marketing email - and nothing else", async () => {
    await ingestAs(customer("cust_unsub", "+13025551301", true), "bk_unsub_1");
    const c = await byPhone("+13025551301");
    expect(c.emailOptedOut).toBe(true);
    expect(c.emailOptedOutAt).not.toBeNull();
    // Email marketing only: texting consent is a different fact, untouched.
    expect(c.smsConsentAt).toBeNull();
    expect(c.optedOut).toBe(false);
  });

  it("a later sync where Square says subscribed (or says nothing) never clears it or re-stamps it", async () => {
    const phone = "+13025551302";
    await ingestAs(customer("cust_flip", phone, true), "bk_flip_1");
    const first = (await byPhone(phone)).emailOptedOutAt;

    await ingestAs(customer("cust_flip", phone, false), "bk_flip_2");
    await ingestAs(customer("cust_flip", phone, null), "bk_flip_3");
    await ingestAs(customer("cust_flip", phone, true), "bk_flip_4");
    const after = await byPhone(phone);
    expect(after.emailOptedOut).toBe(true);
    expect(after.emailOptedOutAt?.toISOString()).toBe(first?.toISOString());
  });

  it("keeps an unsubscribe made in ChairBack, with its own date, whatever Square says", async () => {
    const phone = "+13025551303";
    await ingestAs(customer("cust_cb", phone, false), "bk_cb_1");
    const optedOutAt = new Date("2026-01-05T00:00:00Z");
    await prisma.client.update({
      where: { id: (await byPhone(phone)).id },
      data: { emailOptedOut: true, emailOptedOutAt: optedOutAt }, // the unsubscribe link
    });

    await ingestAs(customer("cust_cb", phone, false), "bk_cb_2");
    await ingestAs(customer("cust_cb", phone, true), "bk_cb_3");
    const after = await byPhone(phone);
    expect(after.emailOptedOut).toBe(true);
    expect(after.emailOptedOutAt?.toISOString()).toBe(optedOutAt.toISOString());
  });

  it("an existing client who unsubscribed in Square since is opted out on the next sync", async () => {
    const phone = "+13025551304";
    await ingestAs(customer("cust_later", phone, false), "bk_later_1");
    expect((await byPhone(phone)).emailOptedOut).toBe(false);
    await ingestAs(customer("cust_later", phone, true), "bk_later_2");
    expect((await byPhone(phone)).emailOptedOut).toBe(true);
  });

  it("🔴 the address it was about stays unsubscribed after Square's customer moves to a new one (#514)", async () => {
    const phone = "+13025551305";
    const unsubscribed = customer("cust_moved", phone, true);
    await ingestAs(unsubscribed, "bk_moved_1");
    await ingestAs({ ...unsubscribed, email_address: "moved.on@example.com", preferences: null }, "bk_moved_2");

    expect((await byPhone(phone)).email).toBe("moved.on@example.com");
    const rows = await prisma.emailAddressSuppression.findMany({
      where: { shopId },
      select: { addressHash: true, kind: true, source: true },
    });
    expect(rows).toContainEqual({
      addressHash: suppressionAddressHash(shopId, "cust_moved@example.com"),
      kind: "unsubscribe",
      source: "square_sync",
    });
  });
});
