import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  buildObserveReport,
  completeReschedule,
  dispatchAfterCommit,
  reconcileShop,
  recordMirrorIntent,
  staffMirrorBlocked,
  swapForReschedule,
} from "./acuityMirror.js";
import { AcuityError } from "../acuity/client.js";

/**
 * MODE BEHAVIOUR AND OPERATOR SAFETY.
 *
 * The promise a flag has to keep: OFF and OBSERVE make ZERO outbound writes.
 * Not "few" - zero. If that is ever untrue, a shop that has not opted in is
 * having its barber's real Acuity calendar edited, which is the worst possible
 * outcome of a feature meant to prevent surprises.
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
  return { ...actual, getAcuityClientForShop: vi.fn(async () => acuityMock) };
});

let userId: string;
let shopId: string;
let mapped: string;
let unmapped: string;
let serviceId: string;
let connectedAt: Date;

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const FUTURE_END = new Date(FUTURE.getTime() + 20 * 60_000);

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `mode-${randomToken(6)}@test.local`, passwordHash: "x", name: "M" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Mode Shop",
      bookingUrl: "https://mode.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
      acuityOutboundMode: "OFF",
    },
  });
  shopId = shop.id;
  const conn = await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: "acct", accessToken: "enc" },
  });
  connectedAt = conn.connectedAt;
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 20, price: 30 },
  });
  serviceId = svc.id;
  const m = await prisma.staff.create({
    data: {
      shopId,
      name: "Mapped",
      acuityCalendarId: "cal_ok",
      acuityCalendarMappedAt: new Date(connectedAt.getTime() + 1000),
    },
  });
  const u = await prisma.staff.create({ data: { shopId, name: "Unmapped" } });
  mapped = m.id;
  unmapped = u.id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId, staffId: mapped },
      { shopId, serviceId, staffId: unmapped },
    ],
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

async function setMode(mode: "OFF" | "OBSERVE" | "ENFORCE") {
  await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: mode } });
}

async function makeAppt(staffId: string, status: "BOOKED" | "PENDING" = "BOOKED") {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "T",
      status,
      startsAt: FUTURE,
      endsAt: FUTURE_END,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

/** Record an intent the way a booking transaction would. */
async function intent(appointmentId: string, staffId: string, status: "BOOKED" | "PENDING" = "BOOKED") {
  return prisma.$transaction((tx) =>
    recordMirrorIntent(tx, {
      shopId,
      now: new Date(),
      appointmentId,
      staffId,
      startsAt: FUTURE,
      endsAt: FUTURE_END,
      occupancy: {
        status,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
        holdExpiresAt: null,
        visitId: null,
      },
    }),
  );
}

describe("OFF makes zero outbound writes", () => {
  it("records no intent and calls Acuity not once", async () => {
    await setMode("OFF");
    const a = await makeAppt(mapped);
    expect(await intent(a.id, mapped)).toBeNull();
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(0);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
  });

  it("an already-recorded row does not dispatch while OFF", async () => {
    await setMode("ENFORCE");
    const a = await makeAppt(mapped);
    const id = await intent(a.id, mapped);
    await setMode("OFF");
    expect(await dispatchAfterCommit(id, { shopId, appointmentId: a.id, via: "t" })).toBe("skipped");
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });
});

describe("OBSERVE evaluates but writes nothing", () => {
  it("records no outbox row and makes no Acuity call", async () => {
    await setMode("OBSERVE");
    const a = await makeAppt(mapped);
    expect(await intent(a.id, mapped)).toBeNull();
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(0);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });

  it("the report says exactly what ENFORCE would do, and flags unmapped chairs", async () => {
    await setMode("OBSERVE");
    const ok = await makeAppt(mapped);
    const bad = await makeAppt(unmapped);

    const report = await buildObserveReport(shopId);
    expect(report.mode).toBe("OBSERVE");
    const byId = new Map(report.wouldCreate.map((w) => [w.appointmentId, w]));
    expect(byId.get(ok.id)!.blocked).toBe(false);
    expect(byId.get(ok.id)!.calendarId).toBe("cal_ok");
    expect(byId.get(bad.id)!.blocked).toBe(true);
    expect(byId.get(bad.id)!.reason).toBe("unmapped");
    expect(report.unmappedStaff.map((u) => u.staffId)).toContain(unmapped);
    // Still zero writes.
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });

  it("the report omits appointments that do not occupy the chair", async () => {
    await setMode("OBSERVE");
    const past = await prisma.appointment.create({
      data: {
        shopId,
        staffId: mapped,
        serviceId,
        firstName: "T",
        status: "BOOKED",
        startsAt: new Date("2020-01-01T10:00:00Z"),
        endsAt: new Date("2020-01-01T10:20:00Z"),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const report = await buildObserveReport(shopId);
    expect(report.wouldCreate.map((w) => w.appointmentId)).not.toContain(past.id);
  });
});

describe("ENFORCE: per-barber isolation, never shop-wide collapse", () => {
  it("blocks ONLY the unmapped barber; the mapped one keeps working", async () => {
    await setMode("ENFORCE");
    expect(await staffMirrorBlocked(shopId, unmapped)).toBe(true);
    expect(await staffMirrorBlocked(shopId, mapped)).toBe(false);
  });

  it("a STALE mapping blocks that barber too - it may point at another account's chair", async () => {
    await setMode("ENFORCE");
    await prisma.staff.update({
      where: { id: mapped },
      data: { acuityCalendarMappedAt: new Date(connectedAt.getTime() - 60_000) },
    });
    expect(await staffMirrorBlocked(shopId, mapped)).toBe(true);
    await prisma.staff.update({
      where: { id: mapped },
      data: { acuityCalendarMappedAt: new Date(connectedAt.getTime() + 1000) },
    });
  });

  it("nobody is blocked when the shop is not enforcing", async () => {
    for (const mode of ["OFF", "OBSERVE"] as const) {
      await setMode(mode);
      expect(await staffMirrorBlocked(shopId, unmapped)).toBe(false);
    }
  });

  it("an unmapped chair under ENFORCE refuses rather than borrowing a calendar", async () => {
    await setMode("ENFORCE");
    const a = await makeAppt(unmapped);
    await expect(intent(a.id, unmapped)).rejects.toThrow("mirror_not_configured");
    // Nothing recorded, and certainly nothing sent to someone else's calendar.
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(0);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });
});

describe("what gets mirrored", () => {
  it("an indefinite approval REQUEST is mirrored - it holds the chair", async () => {
    await setMode("ENFORCE");
    const a = await makeAppt(mapped, "PENDING");
    expect(await intent(a.id, mapped, "PENDING")).not.toBeNull();
  });

  it("an EPHEMERAL receptionist hold is not mirrored", async () => {
    await setMode("ENFORCE");
    const a = await makeAppt(mapped, "PENDING");
    const id = await prisma.$transaction((tx) =>
      recordMirrorIntent(tx, {
        shopId,
        now: new Date(),
        appointmentId: a.id,
        staffId: mapped,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
        occupancy: {
          status: "PENDING",
          startsAt: FUTURE,
          endsAt: FUTURE_END,
          holdExpiresAt: new Date(Date.now() + 5 * 60_000),
          visitId: null,
        },
      }),
    );
    expect(id).toBeNull();
  });

  it("an appointment promoted from a synced Visit is never echoed back out", async () => {
    await setMode("ENFORCE");
    const visit = await prisma.visit.create({
      data: {
        shopId,
        clientId: (
          await prisma.client.create({
            data: { shopId, acuityClientKey: randomToken(8), magicToken: randomToken() },
          })
        ).id,
        acuityAppointmentId: randomToken(8),
        status: "SCHEDULED",
        scheduledAt: FUTURE,
        endAt: FUTURE_END,
      },
      select: { id: true },
    });
    const a = await makeAppt(mapped);
    const id = await prisma.$transaction((tx) =>
      recordMirrorIntent(tx, {
        shopId,
        now: new Date(),
        appointmentId: a.id,
        staffId: mapped,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
        occupancy: {
          status: "BOOKED",
          startsAt: FUTURE,
          endsAt: FUTURE_END,
          holdExpiresAt: null,
          visitId: visit.id,
        },
      }),
    );
    expect(id).toBeNull();
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });
});

describe("reschedule NEVER releases the old block before the new one is live", () => {
  async function stageSwap() {
    await setMode("ENFORCE");
    const a = await makeAppt(mapped);
    // Old block, live on Acuity.
    acuityMock.createBlock.mockResolvedValueOnce({ id: "blk_old" });
    const oldId = await intent(a.id, mapped);
    await dispatchAfterCommit(oldId, { shopId, appointmentId: a.id, via: "t" });
    expect(
      await prisma.acuityOutboundBlock.count({ where: { shopId, state: "ACTIVE" } }),
    ).toBe(1);
    acuityMock.createBlock.mockReset();
    acuityMock.deleteBlock.mockReset();
    // Now move it: swap retires the old row and records the replacement.
    const newStart = new Date(FUTURE.getTime() + 60 * 60_000);
    const newEnd = new Date(newStart.getTime() + 20 * 60_000);
    const newId = await prisma.$transaction((tx) =>
      swapForReschedule(tx, {
        shopId,
        now: new Date(),
        appointmentId: a.id,
        staffId: mapped,
        startsAt: newStart,
        endsAt: newEnd,
        occupancy: {
          status: "BOOKED",
          startsAt: newStart,
          endsAt: newEnd,
          holdExpiresAt: null,
          visitId: null,
        },
      }),
    );
    return { apptId: a.id, newId };
  }

  it("new block ACTIVE -> the old one is released", async () => {
    const { apptId, newId } = await stageSwap();
    acuityMock.createBlock.mockResolvedValueOnce({ id: "blk_new" });
    acuityMock.deleteBlock.mockResolvedValueOnce(undefined);
    expect(await completeReschedule(shopId, apptId, newId)).toBe("active");
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_old");
    const states = await prisma.acuityOutboundBlock.findMany({
      where: { shopId },
      select: { state: true, acuityBlockId: true },
    });
    expect(states.find((s) => s.acuityBlockId === "blk_new")!.state).toBe("ACTIVE");
    expect(states.find((s) => s.acuityBlockId === "blk_old")!.state).toBe("RELEASED");
  });

  it("create FAILS -> the old block is RETAINED, never deleted", async () => {
    const { apptId, newId } = await stageSwap();
    // 422 = a definitive rejection, so the replacement is terminal-failed.
    acuityMock.createBlock.mockRejectedValueOnce(new AcuityError(422, "nope"));
    expect(await completeReschedule(shopId, apptId, newId)).toBe("failed");
    // THE POINT: the old block was never deleted from Acuity.
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
    const old = await prisma.acuityOutboundBlock.findFirst({
      where: { shopId, acuityBlockId: "blk_old" },
      select: { state: true },
    });
    // ...and its record is honest about it still being live.
    expect(old!.state).toBe("ACTIVE");
  });

  it("create is UNKNOWN -> the old block is RETAINED pending reconciliation", async () => {
    const { apptId, newId } = await stageSwap();
    acuityMock.createBlock.mockRejectedValueOnce(new AcuityError(504, "timeout"));
    expect(await completeReschedule(shopId, apptId, newId)).toBe("unknown");
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
    const old = await prisma.acuityOutboundBlock.findFirst({
      where: { shopId, acuityBlockId: "blk_old" },
      select: { state: true },
    });
    expect(old!.state).toBe("RELEASING"); // held, not freed
  });

  it("the reconciler will not free the old block while the replacement is in flight", async () => {
    const { apptId, newId } = await stageSwap();
    acuityMock.createBlock.mockRejectedValueOnce(new AcuityError(504, "timeout"));
    await completeReschedule(shopId, apptId, newId);
    acuityMock.deleteBlock.mockReset();
    // Reconciler runs while the replacement is still UNKNOWN.
    acuityMock.listBlocks.mockResolvedValue([]); // replacement genuinely absent
    await reconcileShop(shopId);
    // The old block must still not have been deleted in the same pass that
    // was still deciding the replacement's fate.
    const old = await prisma.acuityOutboundBlock.findFirst({
      where: { shopId, acuityBlockId: "blk_old" },
      select: { state: true },
    });
    expect(old!.state).not.toBe("RELEASED");
  });
});
