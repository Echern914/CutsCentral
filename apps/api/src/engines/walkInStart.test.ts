import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { completeEntry, startEntry } from "./walkInStart.js";
import { SlotTakenError } from "./bookingWrite.js";
import { promoteOneAppointmentInTx } from "./appointmentPromotion.js";
import { createEntryByStaff, claimEntry, assignEntry, markLeft, type QueueActor } from "./walkInQueue.js";
import {
  WalkInStaleTransitionError,
} from "./walkInQueue.js";

/**
 * Service start and completion: the two moments the queue touches the real
 * calendar and the real books.
 *
 *   - start = guard -> ONE BOOKED appointment -> entry CAS, one transaction:
 *     a lost slot race writes NOTHING, a stale entry strands NO appointment;
 *   - the mirror can only ever SKIP loudly, never refuse a start;
 *   - completion flows through the one promotion pipeline: one Visit, one
 *     punch, one revenue ticket - and repeating any completion path changes
 *     nothing.
 */

let userId: string;
let shopId: string;
let chairA: string;
let chairB: string;
let svc30: string;
let svc15: string;
let phoneSeq = 0;

const NOW = new Date("2026-09-02T15:00:00.000Z");
// Every start occupies [t, t+dur] on a shared chair pair, and the partial
// unique on (staffId, startsAt) is real - so each test gets its OWN 4-hour
// lane and can never collide with a neighbour's appointment.
let laneSeq = 0;
const lane = () => new Date(NOW.getTime() + laneSeq++ * 4 * 3600_000);

const MANAGER: Extract<QueueActor, { kind: "manager" }> = {
  kind: "manager",
  userId: null,
  staffId: null,
};
const barberOn = (staffId: string): Extract<QueueActor, { kind: "barber" }> => ({
  kind: "barber",
  userId: null,
  staffId,
});

function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(7000 + phoneSeq).padStart(4, "0")}`;
}

async function makeEntry(over: { serviceIds?: string[]; client?: boolean } = {}) {
  let clientId: string | null = null;
  const phone = freshPhone();
  if (over.client) {
    const c = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: phone,
        firstName: "Linked",
        phone,
        magicToken: randomToken(),
      },
      select: { id: true },
    });
    clientId = c.id;
  }
  const entry = await createEntryByStaff({
    shopId,
    timezone: "UTC",
    actor: MANAGER,
    input: {
      firstName: `Start${phoneSeq}`,
      phone,
      serviceIds: over.serviceIds ?? [svc30],
    },
    now: NOW,
  });
  if (clientId) {
    await prisma.walkInEntry.update({
      where: { id: entry.id },
      data: { clientId },
    });
  }
  return { ...entry, clientId };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wst-${randomToken(6)}@test.local`, name: "WST" },
    select: { id: true },
  });
  userId = user.id;
  MANAGER.userId = userId;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Start Cuts",
      slug: `wst-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
      bookingBufferMin: 0,
      walkInEnabled: true,
      // Loyalty ON so the one-punch assertions bite (the master gate would
      // otherwise correctly earn nothing - that behavior is loyalty's suite).
      rewardsEnabled: true,
      punchesPerVisit: 1,
    },
    select: { id: true },
  });
  shopId = shop.id;
  chairA = (await prisma.staff.create({ data: { shopId, name: "Ava" } })).id;
  chairB = (await prisma.staff.create({ data: { shopId, name: "Ben" } })).id;
  svc30 = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
    })
  ).id;
  svc15 = (
    await prisma.service.create({
      data: { shopId, name: "Beard", durationMin: 15, price: 20 },
    })
  ).id;
});

afterEach(async () => {
  // Reset the mirror mode any ENFORCE test flipped on.
  await prisma.shop.update({
    where: { id: shopId },
    data: { acuityOutboundMode: "OFF" },
  });
});

afterAll(async () => {
  await prisma.walkInEvent.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("start", () => {
  it("creates ONE BOOKED appointment carrying every snapshot, and flips the entry in the same commit", async () => {
    const t = lane();
    const e = await makeEntry({ serviceIds: [svc30, svc15] });
    await assignEntry({ shopId, entryId: e.id, staffId: chairA, actor: MANAGER, now: t });
    const res = await startEntry({
      shopId,
      entryId: e.id,
      actor: MANAGER,
      now: t,
    });
    expect(res.entry.status).toBe("IN_SERVICE");
    expect(res.entry.appointmentId).toBe(res.appointmentId);

    const appt = await prisma.appointment.findUnique({
      where: { id: res.appointmentId },
    });
    expect(appt!.status).toBe("BOOKED");
    expect(appt!.staffId).toBe(chairA);
    expect(appt!.serviceId).toBe(svc30); // the primary snapshot
    expect(appt!.bookedVia).toBe("walk_in_queue");
    // 30 + 15 minutes of chair time, $60 of ticket, the second service as an
    // add-on snapshot - the shape endsAt/priceAtBooking already understand.
    expect(appt!.endsAt.getTime() - appt!.startsAt.getTime()).toBe(45 * 60_000);
    expect(Number(appt!.priceAtBooking)).toBe(60);
    expect(appt!.addOns).toEqual([{ name: "Beard", durationMin: 15, price: 20 }]);
  });

  it("a WAITING entry can be started directly: manager names the chair, barber claim-and-starts", async () => {
    const t = lane();
    const e1 = await makeEntry();
    const r1 = await startEntry({
      shopId,
      entryId: e1.id,
      actor: MANAGER,
      staffId: chairB,
      now: t,
    });
    expect(r1.entry.assignedStaffId).toBe(chairB);
    expect(r1.entry.status).toBe("IN_SERVICE");

    const e2 = await makeEntry();
    const r2 = await startEntry({
      shopId,
      entryId: e2.id,
      actor: barberOn(chairA),
      now: t,
    });
    expect(r2.entry.assignedStaffId).toBe(chairA);
  });

  it("🔴 an online booking already on that instant wins: SlotTakenError, and NOTHING was written", async () => {
    // The chair is booked over the exact start window.
    const t = lane();
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: chairA,
        serviceId: svc30,
        firstName: "Online",
        status: "BOOKED",
        startsAt: t,
        endsAt: new Date(t.getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
    });
    const e = await makeEntry();
    await assignEntry({ shopId, entryId: e.id, staffId: chairA, actor: MANAGER, now: t });
    const before = await prisma.appointment.count({ where: { shopId } });
    await expect(
      startEntry({ shopId, entryId: e.id, actor: MANAGER, now: t }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    // No appointment created, entry NOT in service - the tx rolled back whole.
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(before);
    const row = await prisma.walkInEntry.findUnique({ where: { id: e.id } });
    expect(row!.status).toBe("ASSIGNED");
    expect(row!.appointmentId).toBeNull();
    // Clean up the blocker for later tests (the shared chair matters).
    await prisma.appointment.deleteMany({ where: { shopId, firstName: "Online" } });
  });

  it("a barber cannot start another chair's claimed customer", async () => {
    const t = lane();
    const e = await makeEntry();
    await claimEntry({ shopId, entryId: e.id, actor: barberOn(chairA), now: t });
    await expect(
      startEntry({ shopId, entryId: e.id, actor: barberOn(chairB), now: t }),
    ).rejects.toBeInstanceOf(WalkInStaleTransitionError);
  });

  it("🔴 two concurrent starts produce exactly one appointment", async () => {
    const t = lane();
    const e = await makeEntry();
    await assignEntry({ shopId, entryId: e.id, staffId: chairB, actor: MANAGER, now: t });
    const results = await Promise.allSettled([
      startEntry({ shopId, entryId: e.id, actor: MANAGER, now: t }),
      startEntry({ shopId, entryId: e.id, actor: MANAGER, now: new Date(t.getTime() + 60_000) }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    const appts = await prisma.appointment.count({
      where: { shopId, walkInEntry: { id: e.id } },
    });
    expect(appts).toBe(1);
  });

  it("🔴 an ENFORCE shop with an unmapped chair still starts - the mirror SKIPS, never refuses", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { acuityOutboundMode: "ENFORCE" },
    });
    const t = lane();
    const e = await makeEntry();
    const res = await startEntry({
      shopId,
      entryId: e.id,
      actor: MANAGER,
      staffId: chairA, // no acuityCalendarId mapped
      now: t,
    });
    expect(res.entry.status).toBe("IN_SERVICE");
    // And no outbox row was left behind claiming a mirror that never happened.
    const outbox = await prisma.acuityOutboundBlock.count({
      where: { shopId, appointmentId: res.appointmentId },
    });
    expect(outbox).toBe(0);
  });
});

describe("complete", () => {
  it("a LINKED client earns exactly one Visit and one punch; repeats change nothing", async () => {
    const t = lane();
    const e = await makeEntry({ client: true });
    const started = await startEntry({
      shopId,
      entryId: e.id,
      actor: MANAGER,
      staffId: chairA,
      now: t,
    });
    const done = await completeEntry({
      shopId,
      entryId: e.id,
      actor: MANAGER,
      now: new Date(t.getTime() + 30 * 60_000),
    });
    expect(done.status).toBe("COMPLETED");

    const appt = await prisma.appointment.findUnique({
      where: { id: started.appointmentId },
      select: { status: true, visitId: true },
    });
    expect(appt!.status).toBe("COMPLETED");
    expect(appt!.visitId).not.toBeNull();

    const visits = await prisma.visit.count({
      where: { shopId, acuityAppointmentId: `booking:${started.appointmentId}` },
    });
    const punches = await prisma.punchLedger.count({
      where: { shopId, visitId: appt!.visitId! },
    });
    expect(visits).toBe(1);
    expect(punches).toBe(1);

    // Repeat the board action AND the checkout-style promotion: still one of
    // everything (the pipeline's own keys are the guarantee).
    const again = await completeEntry({
      shopId,
      entryId: e.id,
      actor: MANAGER,
      now: new Date(t.getTime() + 31 * 60_000),
    });
    expect(again.status).toBe("COMPLETED");
    expect(
      await prisma.visit.count({
        where: { shopId, acuityAppointmentId: `booking:${started.appointmentId}` },
      }),
    ).toBe(1);
    expect(
      await prisma.punchLedger.count({ where: { shopId, visitId: appt!.visitId! } }),
    ).toBe(1);
  });

  it("a CLIENTLESS walk-in completes with no Visit and no loyalty - and still goes terminal once", async () => {
    const t = lane();
    const e = await makeEntry();
    const started = await startEntry({
      shopId,
      entryId: e.id,
      actor: MANAGER,
      staffId: chairB,
      now: t,
    });
    const done = await completeEntry({
      shopId,
      entryId: e.id,
      actor: MANAGER,
      now: t,
    });
    expect(done.status).toBe("COMPLETED");
    const appt = await prisma.appointment.findUnique({
      where: { id: started.appointmentId },
      select: { status: true, visitId: true, priceAtBooking: true },
    });
    expect(appt!.status).toBe("COMPLETED");
    expect(appt!.visitId).toBeNull();
    // Revenue rides the ticket: priceAtBooking is what readChairEvents falls
    // back to when no Payment row exists.
    expect(Number(appt!.priceAtBooking)).toBe(40);
  });

  it("the CHECKOUT path (promoteOneAppointmentInTx) flips the entry too - one pipeline, every door", async () => {
    const t = lane();
    const e = await makeEntry({ client: true });
    const started = await startEntry({
      shopId,
      entryId: e.id,
      actor: MANAGER,
      staffId: chairA,
      now: t,
    });
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { id: true, punchesPerVisit: true },
    });
    const appt = await prisma.appointment.findUnique({
      where: { id: started.appointmentId },
    });
    await runWithShop(shopId, (tx) =>
      promoteOneAppointmentInTx(
        tx,
        shop!,
        {
          id: appt!.id,
          clientId: appt!.clientId,
          startsAt: appt!.startsAt,
          endsAt: appt!.endsAt,
          priceAtBooking: appt!.priceAtBooking,
          serviceName: "Fade",
        },
        t,
      ),
    );
    const row = await prisma.walkInEntry.findUnique({ where: { id: e.id } });
    expect(row!.status).toBe("COMPLETED");
  });

  it("completing an entry that is not in service refuses; a terminal repeat answers the settled state", async () => {
    const e = await makeEntry();
    await expect(
      completeEntry({ shopId, entryId: e.id, actor: MANAGER, now: NOW }),
    ).rejects.toThrow(/invalid_transition/);
    await markLeft({ shopId, entryId: e.id, actor: MANAGER, now: NOW });
    await expect(
      completeEntry({ shopId, entryId: e.id, actor: MANAGER, now: NOW }),
    ).rejects.toThrow(/invalid_transition/);
  });
});
