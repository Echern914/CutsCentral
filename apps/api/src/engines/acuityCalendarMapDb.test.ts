import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  CalendarTakenError,
  ConnectionChangedError,
  getMappingSnapshot,
  setStaffCalendar,
} from "./acuityCalendarMap.js";

/**
 * The three foundation guarantees that need a real database to prove:
 *
 *  1. ONE CALENDAR, ONE CHAIR - enforced by a partial unique index, so it
 *     holds under concurrency rather than only in the pre-check.
 *  2. ONE live GET /calendars per request - two fetches could disagree and
 *     show a "ready" badge above a list that no longer matches.
 *  3. THE RECONNECT RACE - a mapping validated against account A must never be
 *     stamped fresh after the shop reconnects as account B, where the same
 *     calendar id is a stranger's chair.
 */

const acuityMock = vi.hoisted(() => ({
  listCalendars: vi.fn(),
  listBlocks: vi.fn(),
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));
vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return { ...actual, getAcuityClientForShop: vi.fn(async () => acuityMock) };
});

let userId: string;
let shopId: string;
let staffA: string;
let staffB: string;
let connectedAt: Date;

const CALS = [
  { id: "cal_1", name: "Chair 1" },
  { id: "cal_2", name: "Chair 2" },
];

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `cmap-${randomToken(6)}@test.local`, passwordHash: "x", name: "C" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Map Shop",
      bookingUrl: "https://map.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
  });
  shopId = shop.id;
  const conn = await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: "acct_A", accessToken: "enc" },
  });
  connectedAt = conn.connectedAt;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 20, price: 30 },
  });
  const a = await prisma.staff.create({ data: { shopId, name: "A" } });
  const b = await prisma.staff.create({ data: { shopId, name: "B" } });
  staffA = a.id;
  staffB = b.id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId: service.id, staffId: staffA },
      { shopId, serviceId: service.id, staffId: staffB },
    ],
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.staff.updateMany({
    where: { shopId },
    data: { acuityCalendarId: null, acuityCalendarMappedAt: null },
  });
});

describe("one calendar, one chair", () => {
  it("refuses a calendar another chair already owns, with a clean conflict", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    await setStaffCalendar(shopId, staffA, "cal_1", connectedAt);
    await expect(setStaffCalendar(shopId, staffB, "cal_1", connectedAt)).rejects.toThrow(
      CalendarTakenError,
    );
  });

  it("re-saving the SAME calendar to the SAME chair is allowed (re-attest after a reconnect)", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    await setStaffCalendar(shopId, staffA, "cal_1", connectedAt);
    await expect(setStaffCalendar(shopId, staffA, "cal_1", connectedAt)).resolves.toBeUndefined();
  });

  it("any number of chairs may stay UNMAPPED - null must not collide", async () => {
    const rows = await prisma.staff.findMany({ where: { shopId }, select: { acuityCalendarId: true } });
    expect(rows.every((r) => r.acuityCalendarId === null)).toBe(true);
    expect(rows.length).toBeGreaterThan(1); // two nulls coexist happily
  });

  it("THE DATABASE holds the line under concurrency, not just the pre-check", async () => {
    // Bypass setStaffCalendar entirely: this is the partial unique index alone.
    await prisma.staff.update({ where: { id: staffA }, data: { acuityCalendarId: "cal_2" } });
    await expect(
      prisma.staff.update({ where: { id: staffB }, data: { acuityCalendarId: "cal_2" } }),
    ).rejects.toThrow();
  });

  it("concurrent saves of one calendar to two chairs: exactly one wins", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    const results = await Promise.allSettled([
      setStaffCalendar(shopId, staffA, "cal_1", connectedAt),
      setStaffCalendar(shopId, staffB, "cal_1", connectedAt),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const owners = await prisma.staff.count({
      where: { shopId, acuityCalendarId: "cal_1" },
    });
    expect(owners).toBe(1);
  });
});

describe("one live GET /calendars per request", () => {
  it("the snapshot fetches calendars EXACTLY once", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    const snap = await getMappingSnapshot(shopId);
    expect(acuityMock.listCalendars).toHaveBeenCalledTimes(1);
    // ...and readiness was computed from that same array.
    expect(snap.calendars).toHaveLength(2);
    expect(snap.readiness.staff).toHaveLength(2);
  });

  it("carries the connection generation back to the caller", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    const snap = await getMappingSnapshot(shopId);
    expect(snap.connectedAt?.getTime()).toBe(connectedAt.getTime());
  });
});

describe("the reconnect race", () => {
  it("refuses to save when the connection changed since the snapshot", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    const stale = new Date(connectedAt.getTime() - 60_000);
    await expect(setStaffCalendar(shopId, staffA, "cal_1", stale)).rejects.toThrow(
      ConnectionChangedError,
    );
    // Nothing was written - an old account's mapping is never stamped fresh.
    const row = await prisma.staff.findUnique({
      where: { id: staffA },
      select: { acuityCalendarId: true, acuityCalendarMappedAt: true },
    });
    expect(row!.acuityCalendarId).toBeNull();
    expect(row!.acuityCalendarMappedAt).toBeNull();
  });

  it("an ACTUAL reconnect mid-flight is caught", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    const snapshotGeneration = connectedAt;
    // The shop reconnects (possibly a different Acuity account) after we listed.
    const moved = new Date(connectedAt.getTime() + 5_000);
    await prisma.acuityConnection.update({
      where: { shopId },
      data: { connectedAt: moved, acuityAccountId: "acct_B" },
    });
    await expect(
      setStaffCalendar(shopId, staffA, "cal_1", snapshotGeneration),
    ).rejects.toThrow(ConnectionChangedError);
    // Restore for the remaining tests.
    await prisma.acuityConnection.update({
      where: { shopId },
      data: { connectedAt, acuityAccountId: "acct_A" },
    });
  });

  it("a DISCONNECT mid-flight fails safe rather than writing", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    const saved = await prisma.acuityConnection.findUnique({ where: { shopId } });
    await prisma.acuityConnection.delete({ where: { shopId } });
    await expect(setStaffCalendar(shopId, staffA, "cal_1", connectedAt)).rejects.toThrow(
      ConnectionChangedError,
    );
    await prisma.acuityConnection.create({
      data: {
        shopId,
        acuityAccountId: saved!.acuityAccountId,
        accessToken: saved!.accessToken,
        connectedAt: saved!.connectedAt,
      },
    });
  });

  it("CLEARING a mapping needs no generation - it can never point at the wrong chair", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    await setStaffCalendar(shopId, staffA, "cal_1", connectedAt);
    await expect(setStaffCalendar(shopId, staffA, null, null)).resolves.toBeUndefined();
    const row = await prisma.staff.findUnique({
      where: { id: staffA },
      select: { acuityCalendarId: true, acuityCalendarMappedAt: true },
    });
    expect(row!.acuityCalendarId).toBeNull();
    expect(row!.acuityCalendarMappedAt).toBeNull();
    // Clearing performs no Acuity call at all.
    expect(acuityMock.listCalendars).toHaveBeenCalledTimes(1);
  });

  it("a successful save stamps mappedAt fresh, clearing the stale flag", async () => {
    acuityMock.listCalendars.mockResolvedValue(CALS);
    await setStaffCalendar(shopId, staffA, "cal_1", connectedAt);
    const row = await prisma.staff.findUnique({
      where: { id: staffA },
      select: { acuityCalendarMappedAt: true },
    });
    expect(row!.acuityCalendarMappedAt!.getTime()).toBeGreaterThanOrEqual(connectedAt.getTime());
  });
});

describe("RLS", () => {
  it("AcuityOutboundBlock has RLS enabled AND forced, with a tenant policy", async () => {
    const [rls] = await prisma.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname = 'AcuityOutboundBlock'`;
    expect(rls?.relrowsecurity).toBe(true);
    expect(rls?.relforcerowsecurity).toBe(true);

    const policies = await prisma.$queryRaw<{ polname: string }[]>`
      SELECT polname FROM pg_policy
       WHERE polrelid = '"AcuityOutboundBlock"'::regclass`;
    expect(policies.map((p) => p.polname)).toContain("tenant_isolation");
  });

  it("the partial unique index exists with the right predicate", async () => {
    const [idx] = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE indexname = 'Staff_shopId_acuityCalendarId_key'`;
    expect(idx?.indexdef).toContain("UNIQUE");
    expect(idx?.indexdef).toMatch(/acuityCalendarId.*IS NOT NULL/s);
  });
});
