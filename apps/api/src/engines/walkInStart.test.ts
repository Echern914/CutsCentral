import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { completeEntry, startEntry } from "./walkInStart.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "./bookingWrite.js";
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

/**
 * The mirror only engages for a CONNECTED shop (isMirrorEligible checks
 * `acuityConnected` first). Without this row an ENFORCE test proves nothing:
 * recordMirrorIntent returns null on the very first line and every "the mirror
 * skipped" assertion passes for the wrong reason.
 */
async function connectAcuity(): Promise<void> {
  await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: `acct_${randomToken(4)}`,
      accessToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
}

afterEach(async () => {
  // Reset the mirror mode any ENFORCE test flipped on, and disconnect - both
  // are shop-wide, and a leaked one would silently arm the mirror for its
  // neighbours.
  await prisma.shop.update({
    where: { id: shopId },
    data: { acuityOutboundMode: "OFF" },
  });
  await prisma.acuityConnection.deleteMany({ where: { shopId } });
  // 🔴 And clear the queue. An entry left ASSIGNED does not expire with its
  // test: the capacity plan projects it from whatever `now` the NEXT test
  // passes, so a single leftover silently reserves the first half-hour of
  // every later lane on that chair. (Correct in production - the customer is
  // still waiting - and lethal to test isolation.)
  await prisma.walkInEntry.deleteMany({ where: { shopId } });
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
    await connectAcuity();
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

  it("🔴 the mirror runs on the START's clock, not the wall clock - so this path cannot rot", async () => {
    const chair = (
      await prisma.staff.create({
        data: { shopId, name: "Mirrored", acuityCalendarId: "cal_walk_in_clock" },
      })
    ).id;
    await connectAcuity();
    await prisma.shop.update({
      where: { id: shopId },
      data: { acuityOutboundMode: "ENFORCE" },
    });

    // Both instants sit FAR from the wall clock, on opposite sides of it.
    // recordMirrorIntent records only while the span still occupies the chair
    // AT the instant it is handed (shouldMirrorOnCreate), so a `new Date()`
    // read inside the mirror call would quietly record NOTHING for the
    // past-dated start - the test would still pass, having exercised no mirror
    // code at all. Demanding an identical, fully-populated row at both instants
    // pins that the start's own clock is the only clock in play, and that this
    // path decides the same thing whatever day the suite runs.
    for (const at of [
      new Date(NOW.getTime() - 365 * 24 * 3600_000),
      new Date(NOW.getTime() + 365 * 24 * 3600_000),
    ]) {
      const e = await makeEntry();
      const res = await startEntry({
        shopId,
        entryId: e.id,
        actor: MANAGER,
        staffId: chair,
        now: at,
      });
      const row = await prisma.acuityOutboundBlock.findFirst({
        where: { shopId, appointmentId: res.appointmentId },
        select: { startsAt: true, endsAt: true, state: true },
      });
      expect(row, `no mirror intent recorded for a start at ${at.toISOString()}`).not.toBeNull();
      // And it mirrors THAT span - the injected instant, start to finish.
      expect(row!.startsAt.toISOString()).toBe(at.toISOString());
      expect(row!.endsAt.toISOString()).toBe(
        new Date(at.getTime() + 30 * 60_000).toISOString(),
      );
      expect(row!.state).toBe("PENDING");
    }
  });
});

/**
 * The other half of the capacity invariant: the public booking path and Start
 * Service both go through the ONE guard, under the ONE advisory lock on the
 * chair, so a chair-instant has exactly one owner however the two interleave.
 * (walkInReservation.test.ts covers the capacity plan itself.)
 */
describe("walk-in capacity versus the public booking path", () => {
  /** A public booking, written the way booking.public.ts writes one. */
  function publicBooking(staffId: string, t: Date, now: Date): Promise<string> {
    const endsAt = new Date(t.getTime() + 30 * 60_000);
    return prisma.$transaction(async (tx) => {
      await lockStaffAndAssertSlotFree(tx, {
        walkInCapacity: "enforce",
        serviceDayLimit: null,
        staffId,
        shopId,
        startsAt: t,
        endsAt,
        bufferMin: 0,
        now,
      });
      const a = await tx.appointment.create({
        data: {
          shopId,
          staffId,
          serviceId: svc30,
          firstName: "Online",
          status: "BOOKED",
          startsAt: t,
          endsAt,
          priceAtBooking: 40,
          manageToken: randomToken(),
        },
        select: { id: true },
      });
      return a.id;
    });
  }

  it("🔴 an ASSIGNED walk-in's projected span refuses a public booking outright", async () => {
    const t = lane();
    const e = await makeEntry();
    await assignEntry({ shopId, entryId: e.id, staffId: chairB, actor: MANAGER, now: t });
    await expect(publicBooking(chairB, t, t)).rejects.toBeInstanceOf(SlotTakenError);
    // Nothing written - the person standing in the shop keeps the chair.
    expect(
      await prisma.appointment.count({ where: { shopId, staffId: chairB, startsAt: t } }),
    ).toBe(0);
  });

  it("🔴 a race between the two produces exactly one owner, and the loser writes nothing", async () => {
    // A WAITING entry has no projected span (nobody promised it this chair
    // yet), so neither side is pre-empted and this is a REAL race decided by
    // whichever transaction takes the chair's advisory lock first.
    const t = lane();
    const e = await makeEntry();
    const results = await Promise.allSettled([
      startEntry({ shopId, entryId: e.id, actor: MANAGER, staffId: chairB, now: t }),
      publicBooking(chairB, t, t),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // One chair, one instant, one appointment - whoever won.
    const appts = await prisma.appointment.findMany({
      where: { shopId, staffId: chairB, startsAt: t },
      select: { id: true },
    });
    expect(appts).toHaveLength(1);

    const row = await prisma.walkInEntry.findUnique({ where: { id: e.id } });
    if (results[0]!.status === "fulfilled") {
      expect(row!.status).toBe("IN_SERVICE");
      expect(row!.appointmentId).toBe(appts[0]!.id);
    } else {
      // The start lost: no appointment of its own, and - the part a rolled-back
      // transaction is easy to get wrong - no lifecycle mutation, no mirror
      // intent, and no success event claiming a service that never began.
      expect(row!.status).toBe("WAITING");
      expect(row!.appointmentId).toBeNull();
      expect(row!.startedAt).toBeNull();
      expect(
        await prisma.acuityOutboundBlock.count({ where: { shopId, staffId: chairB } }),
      ).toBe(0);
      expect(
        await prisma.walkInEvent.count({
          where: { shopId, entryId: e.id, type: "entry.service_started" },
        }),
      ).toBe(0);
    }
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
