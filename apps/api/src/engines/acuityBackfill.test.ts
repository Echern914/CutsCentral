import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { AcuityError } from "../acuity/client.js";
import type { AcuityBlock } from "../acuity/types.js";
import { blockReference } from "./acuityMirrorRules.js";
import { reconcileShop, releaseForAppointment } from "./acuityMirror.js";
import {
  auditCoverage,
  backfillShop,
  BackfillRefusedError,
  type BackfillCursor,
} from "./acuityBackfill.js";

/**
 * The backfill, against a real database and a mocked Acuity account.
 *
 * WHAT THIS FILE IS DEFENDING. Switching a shop to ENFORCE protects only the
 * bookings made after the switch; everything already on the books stays
 * invisible to Acuity, and the reconciler cannot help because it only drains
 * rows that exist. That gap was found live on the first pilot shop. The danger
 * in closing it is that a bulk writer touches many real customers at once, so
 * every test below is about a way this could do harm:
 *
 *   - blocking time a customer already cancelled
 *   - blocking Acuity's own booking with a duplicate of itself
 *   - creating two blocks for one appointment
 *   - adopting or deleting a block the barber made by hand
 *   - writing at all while the shop is only rehearsing
 *   - leaking a customer's name into a report or a log
 */

const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  listBlocks: vi.fn(),
  listCalendars: vi.fn(),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));

vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return {
    ...actual,
    getAcuityClientForShop: vi.fn(async () => acuityMock),
  };
});

const CAL = "cal_backfill_1";
const OTHER_CAL = "cal_backfill_2";

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;
/** A second tenant, used only to prove nothing crosses the boundary. */
let otherShopId: string;
let otherStaffId: string;
let otherServiceId: string;

/** Far enough out that nothing collides with the "already started" cases. */
const soon = (minutesFromNow: number) => new Date(Date.now() + minutesFromNow * 60_000);

let blockSeq = 0;
function stubCreateOk() {
  acuityMock.createBlock.mockImplementation(async () => ({ id: `blk_${++blockSeq}` }));
}

async function makeAppointment(over: {
  shop?: string;
  staff?: string;
  service?: string;
  status?: "PENDING" | "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  startsAt?: Date;
  endsAt?: Date;
  holdExpiresAt?: Date | null;
  visitId?: string | null;
} = {}) {
  const startsAt = over.startsAt ?? soon(60);
  return prisma.appointment.create({
    data: {
      shopId: over.shop ?? shopId,
      staffId: over.staff ?? staffId,
      serviceId: over.service ?? serviceId,
      // Real customer fields, deliberately: the PII assertions below are
      // meaningless against a row that has nothing to leak.
      firstName: "Marcus",
      lastName: "Holloway",
      phone: "+15555550123",
      email: "marcus@example.test",
      status: over.status ?? "BOOKED",
      startsAt,
      endsAt: over.endsAt ?? new Date(startsAt.getTime() + 20 * 60_000),
      holdExpiresAt: over.holdExpiresAt ?? null,
      visitId: over.visitId ?? null,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

/** A Visit is how an Acuity-owned booking appears inside ChairBack. */
async function makeSyncedVisit(): Promise<string> {
  const visit = await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acuity-${randomToken(6)}`,
      status: "SCHEDULED",
      scheduledAt: soon(90),
      endAt: soon(110),
    },
    select: { id: true },
  });
  return visit.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `bf-${randomToken(6)}@test.local`, passwordHash: "x", name: "B" },
  });
  userId = user.id;

  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Backfill Shop",
      bookingUrl: "https://bf.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
      acuityOutboundMode: "ENFORCE",
    },
  });
  shopId = shop.id;
  await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: "acct_bf",
      accessToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
  const staff = await prisma.staff.create({
    data: { shopId, name: "Dre", acuityCalendarId: CAL, acuityCalendarMappedAt: new Date() },
  });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 20, price: 30 },
  });
  serviceId = service.id;
  const client = await prisma.client.create({
    data: {
      shopId,
      firstName: "Marcus",
      lastName: "Holloway",
      phone: "+15555550123",
      acuityClientKey: `key-${randomToken(6)}`,
      magicToken: randomToken(),
    },
    select: { id: true },
  });
  clientId = client.id;

  const other = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Other Shop",
      bookingUrl: "https://bf2.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
      acuityOutboundMode: "ENFORCE",
    },
  });
  otherShopId = other.id;
  await prisma.acuityConnection.create({
    data: {
      shopId: otherShopId,
      acuityAccountId: "acct_bf2",
      accessToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
  const otherStaff = await prisma.staff.create({
    data: {
      shopId: otherShopId,
      name: "Ana",
      acuityCalendarId: OTHER_CAL,
      acuityCalendarMappedAt: new Date(),
    },
  });
  otherStaffId = otherStaff.id;
  const otherService = await prisma.service.create({
    data: { shopId: otherShopId, name: "Cut", durationMin: 20, price: 30 },
  });
  otherServiceId = otherService.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

beforeEach(() => {
  vi.clearAllMocks();
  acuityMock.listBlocks.mockResolvedValue([]);
  stubCreateOk();
});

afterEach(async () => {
  // 🔴 The filter is guarded because Prisma reads `{ shopId: undefined }` as NO
  // FILTER, not as "no match". If beforeAll ever dies part-way, an unguarded
  // cleanup here would delete EVERY appointment in the shared test database and
  // surface as unrelated files failing at random.
  for (const s of [shopId, otherShopId].filter(Boolean)) {
    await prisma.acuityOutboundBlock.deleteMany({ where: { shopId: s } });
    await prisma.appointment.deleteMany({ where: { shopId: s } });
  }
  if (shopId) await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.shop.updateMany({
    where: { id: shopId },
    data: { acuityOutboundMode: "ENFORCE", bookingMode: "native" },
  });
  await prisma.staff.updateMany({
    where: { id: staffId },
    data: { acuityCalendarId: CAL, acuityCalendarMappedAt: new Date() },
  });
});

const liveRows = (shop = shopId) =>
  prisma.acuityOutboundBlock.findMany({
    where: { shopId: shop, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
  });

describe("the dry run", () => {
  it("writes nothing and never calls Acuity", async () => {
    await makeAppointment();
    await makeAppointment({ startsAt: soon(200) });

    const before = await prisma.acuityOutboundBlock.count();
    const audit = await auditCoverage([shopId]);
    const after = await prisma.acuityOutboundBlock.count();

    expect(after).toBe(before);
    // Not "no createBlock" - NO Acuity call of any kind. A dry run that has to
    // reach Acuity cannot be run while Acuity is the thing that is broken.
    for (const fn of Object.values(acuityMock)) expect(fn).not.toHaveBeenCalled();

    const shop = audit.shops[0]!;
    // Asserted as one object, and alongside blockingChairs, so a failure prints
    // WHY - "missing: 0, blocked: 2, blocking: [Dre/stale]" diagnoses itself,
    // where a bare toBe(2) only says the number was wrong.
    expect({ counts: shop.counts, blocking: shop.blockingChairs }).toMatchObject({
      counts: { eligible: 2, missing: 2, protected: 0, blocked: 0 },
      blocking: [],
    });
    expect(shop.counts.protected).toBe(0);
    expect(shop.executable).toBe(true);
  });

  it("reports per-shop counts that add up", async () => {
    await makeAppointment(); // eligible
    await makeAppointment({ status: "CANCELED" }); // freed
    await makeAppointment({ visitId: await makeSyncedVisit() }); // imported
    await makeAppointment({ holdExpiresAt: soon(5) }); // ephemeral hold
    await makeAppointment({ shop: otherShopId, staff: otherStaffId, service: otherServiceId });

    const audit = await auditCoverage([shopId, otherShopId]);
    expect(audit.shops).toHaveLength(2);
    const mine = audit.shops.find((s) => s.shopId === shopId)!;
    const c = mine.counts;
    expect(c.inWindow).toBe(4);
    expect(c.excludedFreed + c.excludedImported + c.excludedHold + c.eligible).toBe(c.inWindow);
    expect(c.eligible).toBe(1);
    expect(c.excludedImported).toBe(1);
    expect(c.excludedHold).toBe(1);
    expect(c.excludedFreed).toBe(1);
    // Totals are the sum of the parts, so an admin sweep needs no second pass.
    expect(audit.totals.eligible).toBe(2);
    expect(audit.totals.inWindow).toBe(5);
  });

  it("carries no customer PII", async () => {
    await makeAppointment();
    await prisma.staff.update({
      where: { id: staffId },
      data: { acuityCalendarId: null, acuityCalendarMappedAt: null },
    });
    const audit = await auditCoverage([shopId]);
    const wire = JSON.stringify(audit);
    for (const secret of ["Marcus", "Holloway", "5555550123", "marcus@example.test"]) {
      expect(wire).not.toContain(secret);
    }
    // The chair's own name IS present - that is staff, and it is the whole
    // point of naming who is blocking coverage.
    expect(wire).toContain("Dre");
  });
});

describe("protecting what is already booked", () => {
  it("gives an existing future appointment a live block", async () => {
    const appt = await makeAppointment();

    const run = await backfillShop(shopId);
    expect(run.created).toBe(1);
    expect(run.active).toBe(1);
    expect(run.done).toBe(true);

    const rows = await liveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.appointmentId).toBe(appt.id);
    expect(rows[0]!.state).toBe("ACTIVE");
    expect(rows[0]!.acuityCalendarId).toBe(CAL);
    expect(rows[0]!.acuityBlockId).toBeTruthy();

    // The block Acuity was asked for: right calendar, right span, and an
    // OPAQUE reference - never a customer's name on the barber's calendar.
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(1);
    const sent = acuityMock.createBlock.mock.calls[0]![0] as Record<string, string>;
    expect(sent.calendarID).toBe(CAL);
    expect(sent.notes).toBe(blockReference(rows[0]!.id));
    expect(sent.notes).not.toContain("Marcus");

    const audit = await auditCoverage([shopId]);
    expect(audit.shops[0]!.counts.missing).toBe(0);
    expect(audit.shops[0]!.counts.protected).toBe(1);
  });

  it("creates nothing on a rerun", async () => {
    await makeAppointment();
    const first = await backfillShop(shopId);
    expect(first.created).toBe(1);

    const second = await backfillShop(shopId);
    expect(second.created).toBe(0);
    expect(second.skippedProtected).toBe(1);
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(1);
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a block for an appointment cancelled after the first run", async () => {
    const appt = await makeAppointment();
    await backfillShop(shopId);
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await releaseForAppointment(shopId, appt.id);

    const rerun = await backfillShop(shopId);
    expect(rerun.created).toBe(0);
    expect(await liveRows()).toHaveLength(0);
  });
});

describe("what must never be mirrored", () => {
  it("excludes an Acuity-imported appointment", async () => {
    // Acuity's OWN booking, reflected inward. Mirroring it back out would block
    // the barber's real Acuity appointment with a duplicate of itself.
    await makeAppointment({ visitId: await makeSyncedVisit() });

    const audit = await auditCoverage([shopId]);
    expect(audit.shops[0]!.counts.excludedImported).toBe(1);
    expect(audit.shops[0]!.counts.eligible).toBe(0);

    const run = await backfillShop(shopId);
    expect(run.created).toBe(0);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });

  it("excludes canceled and no-show at any time", async () => {
    await makeAppointment({ status: "CANCELED" });
    await makeAppointment({ status: "NO_SHOW", startsAt: soon(120) });

    const audit = await auditCoverage([shopId]);
    expect(audit.shops[0]!.counts.eligible).toBe(0);
    expect(audit.shops[0]!.counts.excludedFreed).toBe(2);

    const run = await backfillShop(shopId);
    expect(run.created).toBe(0);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });

  it("excludes a COMPLETED appointment whose span has passed", async () => {
    await makeAppointment({
      status: "COMPLETED",
      startsAt: new Date(Date.now() - 90 * 60_000),
      endsAt: new Date(Date.now() - 60 * 60_000),
    });
    const audit = await auditCoverage([shopId]);
    expect(audit.shops[0]!.counts.inWindow).toBe(0); // outside the window entirely
    expect((await backfillShop(shopId)).created).toBe(0);
  });

  it("STILL protects a COMPLETED walk-in who is in the chair right now", async () => {
    // A walk-in is stored COMPLETED at creation because the money is already in
    // the till - but the clippers are running for another 20 minutes. Treating
    // COMPLETED as free would offer that exact time in Acuity. This is why the
    // backfill defers to shouldMirrorOnCreate instead of filtering on status.
    await makeAppointment({
      status: "COMPLETED",
      startsAt: new Date(Date.now() - 5 * 60_000),
      endsAt: soon(15),
    });
    const audit = await auditCoverage([shopId]);
    expect(audit.shops[0]!.counts.eligible).toBe(1);
    expect(audit.shops[0]!.counts.walkInsInChair).toBe(1);
    expect((await backfillShop(shopId)).created).toBe(1);
  });

  it("excludes an ephemeral receptionist hold", async () => {
    await makeAppointment({ status: "PENDING", holdExpiresAt: soon(4) });
    expect((await auditCoverage([shopId])).shops[0]!.counts.excludedHold).toBe(1);
    expect((await backfillShop(shopId)).created).toBe(0);
  });

  it("DOES protect a PENDING approval request, which waits indefinitely", async () => {
    await makeAppointment({ status: "PENDING", holdExpiresAt: null });
    expect((await auditCoverage([shopId])).shops[0]!.counts.eligible).toBe(1);
    expect((await backfillShop(shopId)).created).toBe(1);
  });
});

describe("the chair has to be genuinely mapped", () => {
  it("refuses an unmapped chair and names it", async () => {
    await prisma.staff.update({
      where: { id: staffId },
      data: { acuityCalendarId: null, acuityCalendarMappedAt: null },
    });
    await makeAppointment();

    const audit = await auditCoverage([shopId]);
    expect(audit.shops[0]!.counts.blocked).toBe(1);
    expect(audit.shops[0]!.counts.missing).toBe(0);
    expect(audit.shops[0]!.blockingChairs).toEqual([
      { staffId, staffName: "Dre", problem: "unmapped" },
    ]);

    const run = await backfillShop(shopId);
    expect(run.skippedBlocked).toBe(1);
    expect(run.created).toBe(0);
    // Never guessed a calendar. An unmapped chair whose block lands on a
    // colleague's calendar is the original bug wearing a different hat.
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });

  it("refuses a chair mapped before the current connection (stale)", async () => {
    // A reconnect can be a DIFFERENT Acuity account, where the stored calendar
    // id belongs to somebody else entirely.
    await prisma.acuityConnection.update({
      where: { shopId },
      data: { connectedAt: new Date(Date.now() + 60_000) },
    });
    await makeAppointment();

    const audit = await auditCoverage([shopId]);
    expect(audit.shops[0]!.blockingChairs[0]!.problem).toBe("stale");

    const run = await backfillShop(shopId);
    expect(run.skippedBlocked).toBe(1);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();

    await prisma.acuityConnection.update({
      where: { shopId },
      data: { connectedAt: new Date(Date.now() - 60_000) },
    });
  });
});

describe("the mode is the flag", () => {
  for (const mode of ["OFF", "OBSERVE"] as const) {
    it(`refuses to execute while ${mode}`, async () => {
      await makeAppointment();
      await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: mode } });

      await expect(backfillShop(shopId)).rejects.toBeInstanceOf(BackfillRefusedError);
      await expect(backfillShop(shopId)).rejects.toMatchObject({ reason: "not_enforcing" });
      expect(acuityMock.createBlock).not.toHaveBeenCalled();
      expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(0);

      // ...but the AUDIT still answers, because "what would I be missing if I
      // turned this on" is the question OBSERVE exists to let an owner ask.
      const audit = await auditCoverage([shopId]);
      expect(audit.shops[0]!.executable).toBe(false);
      expect(audit.shops[0]!.counts.missing).toBe(1);
    });
  }

  it("refuses a link-mode shop even at ENFORCE", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "link" } });
    await expect(backfillShop(shopId)).rejects.toMatchObject({ reason: "not_native" });
  });
});

describe("failure that is not failure", () => {
  it("leaves an ambiguous create UNKNOWN, and the reconciler recovers it", async () => {
    const appt = await makeAppointment();
    // A 502 can follow a request Acuity actually processed. Compensating here
    // would cancel a real customer AND orphan a live block.
    acuityMock.createBlock.mockRejectedValueOnce(new AcuityError(502, "bad gateway"));

    const run = await backfillShop(shopId);
    expect(run.created).toBe(1);
    expect(run.unknown).toBe(1);
    expect(run.active).toBe(0);

    const row = (await liveRows())[0]!;
    expect(row.state).toBe("UNKNOWN");
    expect(row.acuityBlockId).toBeNull();
    // The appointment is untouched - a backfill never cancels a booking.
    const still = await prisma.appointment.findUnique({ where: { id: appt.id } });
    expect(still!.status).toBe("BOOKED");

    // The block DID exist. The reconciler finds it by our opaque reference.
    acuityMock.listBlocks.mockResolvedValue([
      {
        id: "blk_recovered",
        calendarID: CAL,
        start: row.startsAt.toISOString(),
        end: row.endsAt.toISOString(),
        notes: blockReference(row.id),
      } satisfies AcuityBlock,
    ]);
    const rec = await reconcileShop(shopId);
    expect(rec.adopted).toBe(1);
    const after = await prisma.acuityOutboundBlock.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.state).toBe("ACTIVE");
    expect(after.acuityBlockId).toBe("blk_recovered");

    // And a rerun still creates nothing - the recovered row is live.
    expect((await backfillShop(shopId)).created).toBe(0);
  });

  it("keeps going after one appointment definitively fails", async () => {
    await makeAppointment({ startsAt: soon(60) });
    await makeAppointment({ startsAt: soon(120) });
    // 400 is DEFINITIVE - Acuity answered, and the answer proves no block was
    // made. Contrast the 502 above, which must never be treated this way.
    acuityMock.createBlock.mockRejectedValueOnce(new AcuityError(400, "bad request"));

    const run = await backfillShop(shopId);
    expect(run.created).toBe(2);
    expect(run.failed).toBe(1);
    expect(run.active).toBe(1);
  });
});

describe("stopping and starting again", () => {
  it("resumes a partial batch from the cursor, oldest first", async () => {
    const made = [];
    for (let i = 1; i <= 5; i++) made.push(await makeAppointment({ startsAt: soon(60 * i) }));

    const first = await backfillShop(shopId, { limit: 2 });
    expect(first.created).toBe(2);
    expect(first.done).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    // Oldest first: the two soonest-exposed chairs are the ones protected.
    const doneIds = (await liveRows()).map((r) => r.appointmentId);
    expect(doneIds.sort()).toEqual([made[0]!.id, made[1]!.id].sort());

    const second = await backfillShop(shopId, { limit: 2, cursor: first.nextCursor });
    expect(second.created).toBe(2);
    expect(second.done).toBe(false);

    const third = await backfillShop(shopId, { limit: 2, cursor: second.nextCursor });
    expect(third.created).toBe(1);
    expect(third.done).toBe(true);

    expect(await liveRows()).toHaveLength(5);
    expect((await auditCoverage([shopId])).shops[0]!.counts.missing).toBe(0);
  });

  it("survives a restart that loses the cursor entirely", async () => {
    for (let i = 1; i <= 4; i++) await makeAppointment({ startsAt: soon(60 * i) });
    await backfillShop(shopId, { limit: 2 });
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(2);

    // The process died; nobody kept the cursor. Starting over is safe because
    // the already-protected rows are skipped, not recreated.
    const restart = await backfillShop(shopId, { limit: 10 });
    expect(restart.skippedProtected).toBe(2);
    expect(restart.created).toBe(2);
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(4);
    expect(await liveRows()).toHaveLength(4);
  });

  it("advances past a blocked chair instead of looping on it", async () => {
    const blockedStaff = await prisma.staff.create({
      data: { shopId, name: "Unmapped", acuityCalendarId: null },
    });
    await makeAppointment({ staff: blockedStaff.id, startsAt: soon(30) });
    await makeAppointment({ startsAt: soon(90) });

    const first = await backfillShop(shopId, { limit: 1 });
    expect(first.skippedBlocked).toBe(1);
    expect(first.created).toBe(0);
    expect(first.nextCursor).not.toBeNull(); // the cursor MOVED

    const second = await backfillShop(shopId, { limit: 1, cursor: first.nextCursor });
    expect(second.created).toBe(1);

    // Staff is onDelete: Restrict from Appointment, so clear the rows first.
    await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
    await prisma.appointment.deleteMany({ where: { shopId } });
    await prisma.staff.delete({ where: { id: blockedStaff.id } });
  });

  it("rejects a malformed cursor rather than silently restarting", async () => {
    await expect(
      backfillShop(shopId, { cursor: { startsAt: "not-a-date", id: "x" } as BackfillCursor }),
    ).rejects.toBeInstanceOf(BackfillRefusedError);
  });
});

describe("tenant isolation", () => {
  it("never touches another shop's appointments", async () => {
    const mine = await makeAppointment();
    const theirs = await makeAppointment({
      shop: otherShopId,
      staff: otherStaffId,
      service: otherServiceId,
    });

    const run = await backfillShop(shopId);
    expect(run.created).toBe(1);

    const rows = await prisma.acuityOutboundBlock.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.appointmentId).toBe(mine.id);
    expect(rows[0]!.shopId).toBe(shopId);
    expect(rows[0]!.acuityCalendarId).toBe(CAL);

    // The other shop is still exposed, and its own audit says so.
    const audit = await auditCoverage([otherShopId]);
    expect(audit.shops[0]!.counts.missing).toBe(1);
    expect(theirs.id).not.toBe(mine.id);
  });

  it("audits only the shops it was asked about", async () => {
    await makeAppointment();
    await makeAppointment({ shop: otherShopId, staff: otherStaffId, service: otherServiceId });
    const audit = await auditCoverage([otherShopId]);
    expect(audit.shops.map((s) => s.shopId)).toEqual([otherShopId]);
    expect(audit.totals.eligible).toBe(1);
  });
});

describe("a block the barber made by hand", () => {
  it("is never adopted, and never deleted", async () => {
    const appt = await makeAppointment();
    // The barber blocked the same time themselves, in the Acuity UI, with their
    // own note. It overlaps our appointment exactly.
    const manual: AcuityBlock = {
      id: "blk_manual_999",
      calendarID: CAL,
      start: (await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).startsAt.toISOString(),
      end: (await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).endsAt.toISOString(),
      notes: "ChairBack existing booking - do not delete",
    };
    acuityMock.listBlocks.mockResolvedValue([manual]);

    const run = await backfillShop(shopId);
    expect(run.created).toBe(1);
    expect(run.active).toBe(1);

    // We made our OWN block rather than claiming theirs. Adoption requires an
    // exact `chairback:<outboxId>` reference; a human note can never match, no
    // matter how similar it looks or how exactly the span lines up.
    const row = (await liveRows())[0]!;
    expect(row.acuityBlockId).not.toBe(manual.id);
    expect(row.acuityBlockId).toMatch(/^blk_\d+$/);

    // Reconciling does not adopt it either.
    await reconcileShop(shopId);
    const afterRec = await prisma.acuityOutboundBlock.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterRec.acuityBlockId).not.toBe(manual.id);

    // And cancelling deletes only OUR id. The barber's block is theirs.
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await releaseForAppointment(shopId, appt.id);
    const deleted = acuityMock.deleteBlock.mock.calls.map((c) => c[0]);
    expect(deleted).toContain(row.acuityBlockId);
    expect(deleted).not.toContain(manual.id);
  });
});

describe("what the caller gets back", () => {
  it("returns counts and ids, and no customer PII", async () => {
    await makeAppointment();
    const run = await backfillShop(shopId);
    const wire = JSON.stringify(run);
    for (const secret of ["Marcus", "Holloway", "5555550123", "marcus@example.test"]) {
      expect(wire).not.toContain(secret);
    }
    expect(run.runId).toBeTruthy();
    expect(run.shopId).toBe(shopId);
  });

  it("refuses a shop that does not exist", async () => {
    await expect(backfillShop("shop_does_not_exist")).rejects.toMatchObject({
      reason: "shop_not_found",
    });
  });
});
