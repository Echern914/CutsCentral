import request from "supertest";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { apiEnv, randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE WEBHOOK INBOX, end to end through the real route.
 *
 * Three promises, each of which the old handler could not make:
 *
 *   1. A DUPLICATE DELIVERY DOES ZERO WORK. The Visit upsert deduped rows, not
 *      work - a redelivery still re-fetched the booking, re-fetched the
 *      customer and re-ran the punch pipeline.
 *   2. A BOOKING CHAIRBACK CREATED NEVER IMPORTS AS A SECOND VISIT. Otherwise
 *      the mirror double-books the very chair it was protecting.
 *   3. NOTHING IS LOST BY ACKNOWLEDGING EARLY, because the durable ledger row
 *      is written before any processing starts.
 */

// Square config, set BEFORE any module evaluates `apiEnv()` at import time -
// several of them capture it in a module-level const, so a beforeAll would be
// far too late. vi.hoisted is the only hook that runs early enough.
vi.hoisted(() => {
  process.env.SQUARE_OAUTH_CLIENT_ID ??= "test-square-client";
  process.env.SQUARE_OAUTH_CLIENT_SECRET ??= "test-square-secret";
  process.env.SQUARE_OAUTH_REDIRECT_URI ??= "http://localhost:4000/api/square/oauth/callback";
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ??= "test-square-webhook-key";
  process.env.SQUARE_ENV ??= "sandbox";
});

const ingestMock = vi.hoisted(() => ({ ingestSquareBooking: vi.fn(async () => {}) }));
vi.mock("./ingest.js", () => ingestMock);

const app = createApp();
const env = apiEnv();
const NOTIFICATION_URL = `${env.API_BASE_URL.replace(/\/$/, "")}/webhooks/square`;

let shopId: string;
let userId: string;
let merchantId: string;

function sign(body: string): string {
  return createHmac("sha256", env.SQUARE_WEBHOOK_SIGNATURE_KEY!)
    .update(NOTIFICATION_URL)
    .update(body)
    .digest("base64");
}

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    merchant_id: merchantId,
    type: "booking.created",
    event_id: `evt_${randomToken(8)}`,
    data: { object: { booking: { id: `BK_${randomToken(6)}`, status: "ACCEPTED", start_at: new Date().toISOString() } } },
    ...over,
  });
}

async function post(body: string) {
  return request(app)
    .post("/webhooks/square")
    .set("x-square-hmacsha256-signature", sign(body))
    .set("Content-Type", "application/json")
    .send(body);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqinbox-${randomToken(6)}@test.local`, passwordHash: "x", name: "I" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Inbox Shop",
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
  });
  shopId = shop.id;
  merchantId = `M_${randomToken(8)}`;
  await prisma.squareConnection.create({
    data: {
      shopId,
      squareMerchantId: merchantId,
      accessToken: "enc",
      refreshToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  ingestMock.ingestSquareBooking.mockResolvedValue(undefined);
});

afterEach(async () => {
  await prisma.squareWebhookEvent.deleteMany({ where: { merchantId } });
  if (shopId) await prisma.squareOutboundBooking.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  if (shopId) {
    await prisma.squareConnection.deleteMany({ where: { shopId } });
    await prisma.shop.deleteMany({ where: { id: shopId } });
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("the ledger", () => {
  it("records the event before doing any work", async () => {
    const body = envelope();
    const eventId = JSON.parse(body).event_id as string;
    const res = await post(body);
    expect(res.status).toBe(200);
    const row = await prisma.squareWebhookEvent.findUnique({ where: { eventId } });
    expect(row).toMatchObject({ status: "PROCESSED", merchantId, shopId, type: "booking.created" });
  });

  it("stores Square ids ONLY - never the envelope", async () => {
    // A stored payload is customer PII sitting in a table nobody remembers to
    // purge. The columns are the boundary.
    const body = envelope();
    await post(body);
    const row = await prisma.squareWebhookEvent.findFirst({ where: { merchantId } });
    expect(Object.keys(row!)).not.toContain("payload");
    expect(JSON.stringify(row)).not.toContain("start_at");
  });

  it("does ZERO work on a duplicate delivery", async () => {
    const body = envelope();
    await post(body);
    expect(ingestMock.ingestSquareBooking).toHaveBeenCalledTimes(1);

    ingestMock.ingestSquareBooking.mockClear();
    const again = await post(body);
    expect(again.status).toBe(200);
    // Not one re-fetch, not one re-run of the punch pipeline.
    expect(ingestMock.ingestSquareBooking).not.toHaveBeenCalled();
    expect(await prisma.squareWebhookEvent.count({ where: { merchantId } })).toBe(1);
  });

  it("dedupes a duplicate that arrives CONCURRENTLY", async () => {
    // Square delivers the same event twice in the same second often enough that
    // a read-then-write check would let both through. The unique index is the
    // authority.
    const body = envelope();
    const results = await Promise.all([post(body), post(body)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await prisma.squareWebhookEvent.count({ where: { merchantId } })).toBe(1);
    expect(ingestMock.ingestSquareBooking).toHaveBeenCalledTimes(1);
  });

  it("handles OUT-OF-ORDER events as two distinct pieces of work", async () => {
    const created = envelope({ type: "booking.created" });
    const updated = envelope({ type: "booking.updated" });
    await post(updated);
    await post(created);
    expect(await prisma.squareWebhookEvent.count({ where: { merchantId } })).toBe(2);
    expect(ingestMock.ingestSquareBooking).toHaveBeenCalledTimes(2);
  });

  it("records an unknown merchant as IGNORED rather than silently dropping it", async () => {
    const body = envelope({ merchant_id: `M_${randomToken(8)}` });
    const res = await post(body);
    expect(res.status).toBe(200);
    const row = await prisma.squareWebhookEvent.findFirst({
      where: { eventId: JSON.parse(body).event_id },
    });
    expect(row).toMatchObject({ status: "IGNORED", lastError: "unknown_merchant" });
    expect(ingestMock.ingestSquareBooking).not.toHaveBeenCalled();
  });

  it("records a processing failure as FAILED, and still asks Square to retry", async () => {
    ingestMock.ingestSquareBooking.mockRejectedValueOnce(new Error("boom"));
    const body = envelope();
    const res = await post(body);
    expect(res.status).toBe(500);
    const row = await prisma.squareWebhookEvent.findUnique({
      where: { eventId: JSON.parse(body).event_id },
    });
    // The row IS the retry queue now; the 500 is belt and braces because
    // Square's retry arrives sooner than any sweep.
    expect(row).toMatchObject({ status: "FAILED" });
  });

  it("still rejects an unsigned or mis-signed body before touching the ledger", async () => {
    const body = envelope();
    const res = await request(app)
      .post("/webhooks/square")
      .set("x-square-hmacsha256-signature", "not-a-signature")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
    expect(await prisma.squareWebhookEvent.count({ where: { merchantId } })).toBe(0);
  });
});

describe("self-echo", () => {
  it("does NOT import a booking ChairBack created", async () => {
    // Importing would give the shop a phantom second appointment on a chair
    // that is already booked - the mirror double-booking what it was
    // protecting.
    const service = await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: 30, price: 30 },
    });
    const staff = await prisma.staff.create({ data: { shopId, name: "Dre" } });
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "A",
        status: "BOOKED",
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 5_400_000),
        manageToken: randomToken(),
      },
    });
    const ourBookingId = `BK_OURS_${randomToken(4)}`;
    await prisma.squareOutboundBooking.create({
      data: {
        shopId,
        appointmentId: appt.id,
        staffId: staff.id,
        serviceId: service.id,
        squareBookingId: ourBookingId,
        squareBookingStatus: "ACCEPTED",
        squareLocationId: "L1",
        squareTeamMemberId: "TM1",
        squareServiceVariationId: "VAR1",
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        idempotencyKey: `k-${randomToken(6)}`,
        state: "ACTIVE",
      },
    });

    const body = envelope({
      data: { object: { booking: { id: ourBookingId, status: "ACCEPTED", start_at: appt.startsAt.toISOString() } } },
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(ingestMock.ingestSquareBooking).not.toHaveBeenCalled();

    await prisma.squareOutboundBooking.deleteMany({ where: { shopId } });
    await prisma.appointment.deleteMany({ where: { shopId } });
    await prisma.staff.deleteMany({ where: { shopId } });
    await prisma.service.deleteMany({ where: { shopId } });
  });

  it("surfaces the barber cancelling OUR booking inside Square", async () => {
    const service = await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: 30, price: 30 },
    });
    const staff = await prisma.staff.create({ data: { shopId, name: "Dre" } });
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "A",
        status: "BOOKED",
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 5_400_000),
        manageToken: randomToken(),
      },
    });
    const ourBookingId = `BK_OURS_${randomToken(4)}`;
    const row = await prisma.squareOutboundBooking.create({
      data: {
        shopId,
        appointmentId: appt.id,
        staffId: staff.id,
        serviceId: service.id,
        squareBookingId: ourBookingId,
        squareBookingStatus: "ACCEPTED",
        squareLocationId: "L1",
        squareTeamMemberId: "TM1",
        squareServiceVariationId: "VAR1",
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        idempotencyKey: `k-${randomToken(6)}`,
        state: "ACTIVE",
      },
    });

    await post(
      envelope({
        type: "booking.updated",
        data: {
          object: {
            booking: {
              id: ourBookingId,
              status: "CANCELLED_BY_SELLER",
              start_at: appt.startsAt.toISOString(),
            },
          },
        },
      }),
    );

    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    // FAILED + a loud log, NOT an auto-cancel: a barber tidying their Square
    // calendar must not silently cancel a customer who was told they were
    // booked. The ChairBack appointment survives and the coverage report shows
    // it as unprotected.
    expect(after).toMatchObject({ state: "FAILED", lastError: "cancelled_in_square" });
    expect(await prisma.appointment.count({ where: { id: appt.id } })).toBe(1);

    await prisma.squareOutboundBooking.deleteMany({ where: { shopId } });
    await prisma.appointment.deleteMany({ where: { shopId } });
    await prisma.staff.deleteMany({ where: { shopId } });
    await prisma.service.deleteMany({ where: { shopId } });
  });
});
