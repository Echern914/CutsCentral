import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { ingestSquareBooking } from "./ingest.js";
import { refreshAccessToken } from "./client.js";

/**
 * THE INBOUND CORRECTIONS, and the token race.
 *
 * Both are bugs that were live in main and both fail in the same direction -
 * quietly, in a way that only shows up as a customer sitting in a chair that is
 * still occupied, or a shop whose Square sync stopped working weeks ago.
 */

const squareMock = vi.hoisted(() => ({
  getBooking: vi.fn(),
  listBookings: vi.fn(),
  getCustomer: vi.fn(async () => ({ id: "C1", given_name: "Ada", family_name: "Lovelace" })),
  listLocations: vi.fn(),
  getBusinessBookingProfile: vi.fn(),
  listTeamMemberBookingProfiles: vi.fn(),
  listServiceCatalogItems: vi.fn(),
  getTokenStatus: vi.fn(),
  ensureCustomer: vi.fn(),
  searchAvailability: vi.fn(),
  createBooking: vi.fn(),
  updateBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return { ...actual, getSquareClientForShop: vi.fn(async () => squareMock) };
});

let userId: string;
let shop: { id: string } & Record<string, unknown>;

const START = "2026-09-01T15:00:00.000Z";

function booking(segments: unknown[], id = `BK_${randomToken(6)}`) {
  return {
    id,
    status: "ACCEPTED",
    start_at: START,
    customer_id: "C1",
    appointment_segments: segments,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqspan-${randomToken(6)}@test.local`, passwordHash: "x", name: "S" },
  });
  userId = user.id;
  shop = (await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Span Shop",
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
    },
  })) as never;
});

beforeEach(() => {
  vi.clearAllMocks();
  squareMock.getCustomer.mockResolvedValue({ id: "C1", given_name: "Ada", family_name: "Lovelace" });
});

afterEach(async () => {
  if (shop?.id) {
    await prisma.visit.deleteMany({ where: { shopId: shop.id } });
    await prisma.client.deleteMany({ where: { shopId: shop.id } });
  }
});

afterAll(async () => {
  if (shop?.id) {
    await prisma.squareConnection.deleteMany({ where: { shopId: shop.id } });
    await prisma.shop.deleteMany({ where: { id: shop.id } });
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

async function visitFor(bookingId: string) {
  return prisma.visit.findUnique({
    where: {
      shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: `square:${bookingId}` },
    },
  });
}

describe("the occupied span", () => {
  it("counts EVERY segment, not just the first", async () => {
    // A cut-plus-colour is two segments. Reading only the first understated the
    // chair by an hour, and ChairBack offered a slot the barber was working
    // through.
    const b = booking([{ duration_minutes: 30 }, { duration_minutes: 60 }]);
    squareMock.getBooking.mockResolvedValueOnce(b);
    await ingestSquareBooking(shop as never, b.id);
    const v = await visitFor(b.id);
    expect(v!.endAt!.getTime() - v!.scheduledAt.getTime()).toBe(90 * 60_000);
  });

  it("includes the intermission - the chair is busy through the gap", async () => {
    const b = booking([
      { duration_minutes: 20, intermission_minutes: 25 },
      { duration_minutes: 15 },
    ]);
    squareMock.getBooking.mockResolvedValueOnce(b);
    await ingestSquareBooking(shop as never, b.id);
    const v = await visitFor(b.id);
    expect(v!.endAt!.getTime() - v!.scheduledAt.getTime()).toBe(60 * 60_000);
  });

  it("NO LONGER guesses half an hour when the duration is missing", async () => {
    // The old fallback was a silent 30 minutes - a guess that is too SHORT,
    // which is the one direction that sells an occupied chair.
    const b = booking([{ duration_minutes: null }]);
    squareMock.getBooking.mockResolvedValueOnce(b);
    await ingestSquareBooking(shop as never, b.id);
    const v = await visitFor(b.id);
    const minutes = (v!.endAt!.getTime() - v!.scheduledAt.getTime()) / 60_000;
    expect(minutes).not.toBe(30);
    // Conservative: longer than any ordinary service, so the error over-blocks.
    expect(minutes).toBeGreaterThanOrEqual(120);
  });

  it("still blocks SOMETHING when Square sends no segments at all", async () => {
    // A null endAt is invisible to the slot engine's `endAt: { gt }` busy-join,
    // so the visit would block nothing at all - worse than over-blocking.
    const b = booking([]);
    squareMock.getBooking.mockResolvedValueOnce(b);
    await ingestSquareBooking(shop as never, b.id);
    const v = await visitFor(b.id);
    expect(v!.endAt).not.toBeNull();
    expect(v!.endAt!.getTime()).toBeGreaterThan(v!.scheduledAt.getTime());
  });

  it("never fabricates SMS consent for a Square client", async () => {
    const b = booking([{ duration_minutes: 30 }]);
    squareMock.getBooking.mockResolvedValueOnce(b);
    await ingestSquareBooking(shop as never, b.id);
    const client = await prisma.client.findFirst({ where: { shopId: shop.id } });
    expect(client!.smsConsentAt).toBeNull();
    expect(client!.smsConsentSource).toBeNull();
  });
});

describe("what stays on the books and what frees the chair", () => {
  it("keeps a NO_SHOW as history while freeing the time", async () => {
    // A no-show is a real event the shop needs in its records - it drives
    // cadence and the barber's own view - but the chair is free.
    const b = { ...booking([{ duration_minutes: 30 }]), status: "NO_SHOW" };
    squareMock.getBooking.mockResolvedValueOnce(b);
    await ingestSquareBooking(shop as never, b.id);
    const v = await visitFor(b.id);
    expect(v!.status).toBe("NO_SHOW");
    expect(v!.noShow).toBe(true);
    // Still present - not deleted, not hidden.
    expect(v!.scheduledAt.toISOString()).toBe(START);
  });

  it("marks a cancelled booking CANCELED so it stops occupying the chair", async () => {
    for (const status of ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED"]) {
      const b = { ...booking([{ duration_minutes: 30 }]), status };
      squareMock.getBooking.mockResolvedValueOnce(b);
      await ingestSquareBooking(shop as never, b.id);
      const v = await visitFor(b.id);
      expect(v!.status).toBe("CANCELED");
      expect(v!.canceledAt).not.toBeNull();
    }
  });

  it("does not downgrade a COMPLETED visit when the same event is redelivered", async () => {
    const b = booking([{ duration_minutes: 30 }]);
    squareMock.getBooking.mockResolvedValue(b);
    await ingestSquareBooking(shop as never, b.id);
    await prisma.visit.updateMany({
      where: { shopId: shop.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await ingestSquareBooking(shop as never, b.id);
    const v = await visitFor(b.id);
    // ACCEPTED resolves to SCHEDULED; a redelivery must not un-complete a
    // visit the promotion job already settled.
    expect(v!.status).toBe("COMPLETED");
  });
});

describe("the token refresh race", () => {
  it("does not let a loser overwrite the winner's rotated token", async () => {
    // Two requests 401 at the same moment. Square rotates the refresh token, so
    // the second exchange used one the first already retired - and a blind
    // UPDATE would leave the row holding a token Square no longer honours,
    // which fails permanently and forces the seller to reconnect.
    await prisma.squareConnection.deleteMany({ where: { shopId: shop.id } });
    const conn = await prisma.squareConnection.create({
      data: {
        shopId: shop.id,
        squareMerchantId: `M_${randomToken(6)}`,
        accessToken: "enc-access-v1",
        refreshToken: "enc-refresh-v1",
        tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
      },
      select: { refreshToken: true },
    });

    // Someone else already rotated it between our read and our write.
    await prisma.squareConnection.update({
      where: { shopId: shop.id },
      data: { refreshToken: "enc-refresh-v2", accessToken: "enc-access-v2" },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "loser-access",
          refresh_token: "loser-refresh",
          expires_at: "2099-02-01T00:00:00Z",
          merchant_id: "M",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );
    try {
      await refreshAccessToken(shop.id, "plaintext-v1", conn.refreshToken).catch(() => {});
    } finally {
      fetchSpy.mockRestore();
    }

    const after = await prisma.squareConnection.findUnique({ where: { shopId: shop.id } });
    // The winner's token survives untouched.
    expect(after!.refreshToken).toBe("enc-refresh-v2");
    expect(after!.accessToken).toBe("enc-access-v2");
  });

  it("writes normally when nobody else has touched the row", async () => {
    await prisma.squareConnection.deleteMany({ where: { shopId: shop.id } });
    const conn = await prisma.squareConnection.create({
      data: {
        shopId: shop.id,
        squareMerchantId: `M_${randomToken(6)}`,
        accessToken: "enc-access-v1",
        refreshToken: "enc-refresh-v1",
        tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
      },
      select: { refreshToken: true },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_at: "2099-02-01T00:00:00Z",
          merchant_id: "M",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );
    try {
      await refreshAccessToken(shop.id, "plaintext-v1", conn.refreshToken);
    } finally {
      fetchSpy.mockRestore();
    }
    const after = await prisma.squareConnection.findUnique({ where: { shopId: shop.id } });
    expect(after!.refreshToken).not.toBe("enc-refresh-v1");
  });
});
