import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { holdTableLock } from "../testing/raceBarrier.js";

/**
 * THE SYNCED-VISIT COMPLETION JOB: COMPLETE AND EARN TOGETHER, ONLY WHILE DUE.
 *
 * Acuity never says "completed", so a job completes each visit whose end has
 * passed and earns its punch. It used to:
 *  - set COMPLETED unconditionally from a list read earlier, so a resync that
 *    cancelled the visit in between was overwritten - completed and punched;
 *  - complete in one write and earn in another, with nothing catching a
 *    failure: a failed earn left the visit completed with no punch, never
 *    retried, and aborted every visit after it in the batch.
 */

const notifyPunchEarned = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/loyaltyNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/loyaltyNotify.js")>()),
  notifyPunchEarned,
}));

const { promoteCompletedVisits } = await import("./statusPromotion.js");

let userId = "";
let shopId = "";
let otherShopId = "";

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `spr-${randomToken(6)}@test.local`, passwordHash: "x", name: "SPR" },
  });
  userId = user.id;
  const make = async (name: string) =>
    (
      await prisma.shop.create({
        data: {
          ownerId: userId,
          name,
          slug: `spr-${randomToken(5)}`,
          webhookSecret: randomToken(),
          rewardsEnabled: true,
          punchesPerVisit: 1,
        },
      })
    ).id;
  shopId = await make("Completion Job");
  otherShopId = await make("Elsewhere");
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

beforeEach(() => notifyPunchEarned.mockClear());

async function client(inShop = shopId) {
  return (
    await prisma.client.create({
      data: { shopId: inShop, acuityClientKey: `spr-${randomToken(8)}`, magicToken: randomToken() },
    })
  ).id;
}

/** A SCHEDULED visit that ended `minutesAgo` ago - due for the job. */
async function dueVisit(clientId: string, minutesAgo: number) {
  const endAt = new Date(Date.now() - minutesAgo * 60_000);
  return (
    await prisma.visit.create({
      data: {
        shopId,
        clientId,
        // Not an Acuity/Square key, so no live-connection check applies.
        acuityAppointmentId: `spr:${randomToken(8)}`,
        status: "SCHEDULED",
        scheduledAt: new Date(endAt.getTime() - 30 * 60_000),
        endAt,
        serviceName: "Cut",
        // Booked a day ahead (not imported as history), so a completion is
        // announced - which is what "nobody texted" has to be measured against.
        createdAt: new Date(endAt.getTime() - 86_400_000),
      },
    })
  ).id;
}

const punchesFor = (visitId: string) => prisma.punchLedger.count({ where: { visitId } });

describe("🔴 a visit cancelled after the job read its list", () => {
  it("is left cancelled - not completed, not punched, nobody texted", async () => {
    const c = await client();
    const visitId = await dueVisit(c, 30);

    // The job reads its due visits, then reads Shop: holding Shop parks it
    // there with this visit in its list as SCHEDULED.
    const barrier = await holdTableLock("Shop");
    let settled = false;
    const job = promoteCompletedVisits(new Date(), { shopId }).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);

    // A resync now learns the client cancelled.
    await prisma.visit.update({
      where: { id: visitId },
      data: { status: "CANCELED", canceledAt: new Date() },
    });

    await barrier.release();
    expect(await job).toBe(0);

    const v = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect(v.status).toBe("CANCELED");
    expect(v.completedAt).toBeNull();
    expect(await punchesFor(visitId)).toBe(0);
    expect(notifyPunchEarned).not.toHaveBeenCalled();
  });
});

describe("🔴 one visit failing does not strand it or stop the batch", () => {
  it("a failed earn leaves its visit due for the next run, and the rest still complete", async () => {
    // Fault injection: this visit's client belongs to ANOTHER shop, so its
    // ledger row violates PunchLedger_client_same_shop_fkey - the earn throws.
    // It is the newest, so the job meets it first.
    const broken = await dueVisit(await client(otherShopId), 5);
    const fine = await dueVisit(await client(), 60);

    expect(await promoteCompletedVisits(new Date(), { shopId })).toBe(1);

    // The broken one rolled back whole: still SCHEDULED, so the next run tries
    // it again - not COMPLETED-without-a-punch, which no run ever revisits.
    const b = await prisma.visit.findUniqueOrThrow({ where: { id: broken } });
    expect(b.status).toBe("SCHEDULED");
    expect(b.completedAt).toBeNull();
    expect(await punchesFor(broken)).toBe(0);

    // And the batch carried on past it.
    const f = await prisma.visit.findUniqueOrThrow({ where: { id: fine } });
    expect(f.status).toBe("COMPLETED");
    expect(await punchesFor(fine)).toBe(1);

    // Put right, the next run completes and punches it.
    await prisma.visit.delete({ where: { id: broken } });
  });

  it("an ordinary run completes and punches once; a re-run adds nothing", async () => {
    const visitId = await dueVisit(await client(), 10);
    expect(await promoteCompletedVisits(new Date(), { shopId })).toBe(1);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visitId } })).status).toBe("COMPLETED");
    expect(await punchesFor(visitId)).toBe(1);
    expect(notifyPunchEarned).toHaveBeenCalledTimes(1);
    expect(await promoteCompletedVisits(new Date(), { shopId })).toBe(0);
    expect(await punchesFor(visitId)).toBe(1);
  });
});
