import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  holdTableLock,
  raceBehindBarrier,
  winners,
  type HeldBarrier,
} from "../testing/raceBarrier.js";

/**
 * A NO-SHOW OR CANCEL IS NEVER OVERWRITTEN BY A COMPLETION.
 *
 * The 15-minute sweep reads every BOOKED appointment whose end has passed,
 * then promotes them one at a time. Promotion used to upsert the visit, earn,
 * and then set COMPLETED unconditionally - so a No-show tapped in that gap was
 * turned back into Completed, earned a punch, and texted it. And the cancel
 * read the appointment's visit link BEFORE its own compare-and-set, so a
 * promotion committing in between left its punch standing on a no-show.
 *
 * Both orders are pinned here with a real interleaving (testing/raceBarrier):
 *  1. no-show lands while the sweep holds its stale list -> the no-show stands,
 *     nothing is created, nothing earned, nobody texted;
 *  2. a promotion commits while the no-show is waiting at its CAS -> the
 *     no-show wins and takes back what the promotion wrote.
 */

// Side effects that are not the subject: counted or silenced.
const notifyPunchEarned = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/loyaltyNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/loyaltyNotify.js")>()),
  notifyPunchEarned,
}));
vi.mock("../wallet/appointmentPass.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wallet/appointmentPass.js")>()),
  pokeAppointmentPass: vi.fn(async () => {}),
}));
vi.mock("../billing/cardOnFile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/cardOnFile.js")>()),
  releaseCardOnFile: vi.fn(async () => ({ released: false })),
}));
vi.mock("./acuityMirror.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./acuityMirror.js")>()),
  releaseForAppointment: vi.fn(async () => {}),
}));

const { promoteFulfilledAppointments, promoteOneAppointmentInTx, cancelAppointment } = await import(
  "./appointmentPromotion.js"
);

let userId = "";
let shopId = "";
let staffId = "";
let serviceId = "";
const shop = () => ({ id: shopId, punchesPerVisit: 1 });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `apr-${randomToken(6)}@test.local`, passwordHash: "x", name: "APR" },
  });
  userId = user.id;
  shopId = (
    await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Promotion Races",
        slug: `apr-${randomToken(5)}`,
        webhookSecret: randomToken(),
        bookingMode: "native",
        timezone: "UTC",
        rewardsEnabled: true,
        punchesPerVisit: 1,
      },
    })
  ).id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Solo" } })).id;
  serviceId = (await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40 } })).id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

beforeEach(() => notifyPunchEarned.mockClear());

/** A BOOKED appointment that ended an hour ago - due for the sweep. */
async function dueBooking() {
  const client = await prisma.client.create({
    data: { shopId, acuityClientKey: `apr-${randomToken(8)}`, magicToken: randomToken(), firstName: "Sample" },
  });
  const endsAt = new Date(Date.now() - 3_600_000);
  const startsAt = new Date(endsAt.getTime() - 30 * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: client.id,
      firstName: "Sample",
      startsAt,
      endsAt,
      status: "BOOKED",
      manageToken: randomToken(),
    },
  });
  return { apptId: appt.id, clientId: client.id, startsAt, endsAt };
}

async function balance(clientId: string): Promise<number> {
  const agg = await prisma.punchLedger.aggregate({
    where: { shopId, clientId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}

describe("🔴 a no-show is never turned back into a completion", () => {
  it("a no-show marked while the sweep holds its stale list stays a no-show - no visit, no punch, no text", async () => {
    const b = await dueBooking();

    // The sweep reads its BOOKED rows, then reads Shop: holding Shop parks it
    // right there, with this booking already in its list as BOOKED.
    const barrier = await holdTableLock("Shop");
    let settled = false;
    const sweep = promoteFulfilledAppointments(new Date(), { shopId }).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false); // it really is waiting, list in hand

    // The barber taps No-show now.
    expect(await cancelAppointment(shopId, b.apptId, "NO_SHOW")).toBe(true);

    await barrier.release();
    expect(await sweep).toBe(0);

    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: b.apptId } });
    expect(appt.status).toBe("NO_SHOW");
    expect(appt.completedAt).toBeNull();
    expect(appt.visitId).toBeNull();
    expect(await prisma.visit.count({ where: { shopId, clientId: b.clientId } })).toBe(0);
    expect(await prisma.punchLedger.count({ where: { shopId, clientId: b.clientId } })).toBe(0);
    expect(notifyPunchEarned).not.toHaveBeenCalled();
  });

  it("a promotion that commits while a no-show waits at its compare-and-set is taken back by it", async () => {
    const b = await dueBooking();
    const now = new Date();

    // The promotion, open and uncommitted: it has completed the booking and
    // earned, and holds the booking's row.
    const barrier = await holdPromotion({
      id: b.apptId,
      clientId: b.clientId,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      priceAtBooking: null,
      serviceName: "Cut",
    }, now);

    // The no-show reads the booking (still BOOKED, no visit - the promotion
    // has not committed) and queues at its CAS behind the promotion.
    const { results, settledEarly } = await raceBehindBarrier(barrier, [
      () => cancelAppointment(shopId, b.apptId, "NO_SHOW", now),
    ]);
    expect(settledEarly).toBe(0);
    expect(winners(results)).toEqual([true]);

    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: b.apptId } });
    expect(appt.status).toBe("NO_SHOW");
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: appt.visitId! } });
    expect(visit.status).toBe("NO_SHOW");
    expect(visit.noShow).toBe(true);
    // The punch the promotion wrote is reversed, not left standing.
    expect(await balance(b.clientId)).toBe(0);
    const earn = await prisma.punchLedger.findFirst({
      where: { shopId, clientId: b.clientId, note: "visit" },
    });
    expect(earn?.reversedAt).not.toBeNull();
    expect(earn?.visitId).toBeNull();
  });

  it("promoting a booking that is no longer BOOKED writes nothing", async () => {
    const b = await dueBooking();
    await cancelAppointment(shopId, b.apptId, "CANCELED");
    const out = await runWithShop(shopId, (tx) =>
      promoteOneAppointmentInTx(
        tx,
        shop(),
        { id: b.apptId, clientId: b.clientId, startsAt: b.startsAt, endsAt: b.endsAt, priceAtBooking: null, serviceName: "Cut" },
        new Date(),
      ),
    );
    expect(out).toEqual({ promoted: false });
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: b.apptId } });
    expect(appt.status).toBe("CANCELED");
    expect(appt.visitId).toBeNull();
    expect(await prisma.punchLedger.count({ where: { shopId, clientId: b.clientId } })).toBe(0);
  });

  it("an ordinary sweep still completes, earns once and texts once - and a re-run adds nothing", async () => {
    const b = await dueBooking();
    expect(await promoteFulfilledAppointments(new Date(), { shopId })).toBe(1);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: b.apptId } });
    expect(appt.status).toBe("COMPLETED");
    expect(appt.visitId).not.toBeNull();
    expect(await balance(b.clientId)).toBe(1);
    expect(notifyPunchEarned).toHaveBeenCalledTimes(1);

    // Re-run: the row is no longer BOOKED, so it is not even in the list.
    expect(await promoteFulfilledAppointments(new Date(), { shopId })).toBe(0);
    // Promoting an already-COMPLETED booking again (a checkout after Done) is
    // the idempotent no-op it always was.
    const again = await runWithShop(shopId, (tx) =>
      promoteOneAppointmentInTx(
        tx,
        shop(),
        { id: b.apptId, clientId: b.clientId, startsAt: b.startsAt, endsAt: b.endsAt, priceAtBooking: null, serviceName: "Cut" },
        new Date(),
      ),
    );
    expect(again).toEqual({ promoted: true, earn: null });
    expect(await balance(b.clientId)).toBe(1);
  });
});

/**
 * Hold a promotion open: it runs to the end of promoteOneAppointmentInTx and
 * then waits, uncommitted, holding the booking's row, until released.
 */
async function holdPromotion(
  appt: Parameters<typeof promoteOneAppointmentInTx>[2],
  now: Date,
): Promise<HeldBarrier> {
  let release!: () => void;
  let acquired!: () => void;
  let failed!: (err: unknown) => void;
  const gate = new Promise<void>((r) => (release = r));
  const ready = new Promise<void>((r, j) => {
    acquired = r;
    failed = j;
  });
  const held = runWithShop(
    shopId,
    async (tx) => {
      const out = await promoteOneAppointmentInTx(tx, shop(), appt, now);
      expect(out.promoted).toBe(true);
      acquired();
      await gate;
    },
    { timeout: 30_000, maxWait: 30_000 },
  ).catch((err: unknown) => {
    failed(err);
    throw err;
  });
  await ready;
  return {
    async release() {
      release();
      await held;
    },
  };
}
