import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { apiEnv, encrypt, randomToken } from "@chairback/config";
import { getSquareClientForShop, rateLimitDelayMs, SquareError } from "./client.js";

/**
 * What a Square refusal says, and what the client does when Square says "slow
 * down". Square itself is a stub at the network edge.
 *
 * The first one matters because for months every Square sync failed with the
 * same 400 and the log said only "Square 400": the reason (a range over 31
 * days) was in the body, and nothing read it.
 */

const key = apiEnv().TOKEN_ENCRYPTION_KEY;
let userId: string;
let shopId: string;

let answers: Response[] = [];
const fetchMock = vi.fn(async () => answers.shift() ?? new Response("{}", { status: 500 }));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const refusal = (status: number, code: string, detail: string, headers: Record<string, string> = {}) =>
  json({ errors: [{ category: "INVALID_REQUEST_ERROR", code, detail }] }, status, headers);

const LIST = { startAtMin: "2026-09-01T00:00:00.000Z", startAtMax: "2026-09-30T00:00:00.000Z" };

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqclient-${randomToken(6)}@test.local`, passwordHash: "x", name: "SQC" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: { ownerId: user.id, name: "Square Client Shop", webhookSecret: randomToken() },
  });
  shopId = shop.id;
  await prisma.squareConnection.create({
    data: {
      shopId,
      squareMerchantId: `m-${randomToken(6)}`,
      squareLocationId: "loc1",
      accessToken: encrypt("access", key),
      refreshToken: encrypt("refresh", key),
      tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
    },
  });
});

beforeEach(() => {
  answers = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("a refusal from Square", () => {
  it("🔴 carries Square's own code and reason, not just the status", async () => {
    answers = [
      refusal(400, "BAD_REQUEST", "The time range between start_at_min and start_at_max must be at most 31 days."),
    ];
    const square = await getSquareClientForShop(shopId);
    const err = await square.listBookings(LIST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquareError);
    expect(err).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect((err as Error).message).toContain("31 days");
  });

  it("a body that isn't Square's error shape still fails cleanly, with the status", async () => {
    answers = [new Response("upstream timeout", { status: 502 })];
    const square = await getSquareClientForShop(shopId);
    await expect(square.listBookings(LIST)).rejects.toMatchObject({ status: 502, code: null });
  });
});

describe("told to slow down (429)", () => {
  it("waits and tries again - a long import is not thrown away part-way", async () => {
    answers = [
      refusal(429, "RATE_LIMITED", "Too many requests.", { "Retry-After": "0" }),
      json({ bookings: [{ id: "b1", start_at: "2026-09-10T15:00:00Z" }] }),
    ];
    const square = await getSquareClientForShop(shopId);
    const page = await square.listBookings(LIST);
    expect(page.bookings.map((b) => b.id)).toEqual(["b1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after three retries, saying why", async () => {
    answers = Array.from({ length: 4 }, () =>
      refusal(429, "RATE_LIMITED", "Too many requests.", { "Retry-After": "0" }),
    );
    const square = await getSquareClientForShop(shopId);
    await expect(square.listBookings(LIST)).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("honours Square's Retry-After, capped, and backs off without one", () => {
    expect(rateLimitDelayMs("2", 0)).toBe(2000);
    expect(rateLimitDelayMs("120", 0)).toBe(10_000);
    expect(rateLimitDelayMs(null, 0)).toBe(1000);
    expect(rateLimitDelayMs(null, 2)).toBe(4000);
    expect(rateLimitDelayMs("soon", 1)).toBe(2000);
  });
});
