import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { ingestAppointment } from "../ingest.js";
import { promoteCompletedVisits } from "./statusPromotion.js";
import { promoteFulfilledAppointments } from "./appointmentPromotion.js";
import { editVisit } from "../services/visit.js";
import type { AcuityAppointment } from "../acuity/types.js";

/**
 * #516: WHEN REWARDS START, AND WHAT MAY EARN BEFORE THEN.
 *
 * The switch records when rewards start. A visit that ENDED before that does
 * not earn by itself on any automatic path - the synced-visit completion job,
 * the Acuity resync, native completion - while a visit that ends after it
 * earns exactly as before. A visit logged by hand still earns (a person chose
 * it), and editing an old visit keeps a punch it has without inventing one it
 * never had. The Square resync is pinned in importedHistoryMessages.test.ts.
 */
const app = createApp();
const email = `rstart-${randomToken(6)}@test.local`.toLowerCase();
const DAY = 86_400_000;
let cookie = "";
let shopId = "";
let clientId = "";

async function setRewards(on: boolean) {
  const res = await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ rewardsEnabled: on });
  expect(res.status).toBe(200);
}

async function startedAt(): Promise<Date | null> {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { rewardsStartedAt: true } });
  return shop.rewardsStartedAt;
}

/** The punches a visit carries right now (its live earn, if any). */
async function punchesOn(visitId: string): Promise<number> {
  const earn = await prisma.punchLedger.findUnique({ where: { visitId } });
  return earn && earn.reversedAt === null ? earn.punchesEarned : 0;
}

function acuityAppt(id: string, endedDaysAgo: number): AcuityAppointment {
  const end = new Date(Date.now() - endedDaysAgo * DAY);
  return {
    id,
    firstName: "Early",
    lastName: "Customer",
    phone: "+13025557301",
    datetime: new Date(end.getTime() - 30 * 60_000).toISOString(),
    endTime: end.toISOString(),
    price: "40.00",
    type: "Standard",
    canceled: false,
    noShow: false,
    duration: 30,
  };
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "R", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Start Line", bookingUrl: "https://start.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  // Connected, so the completion job can trust its synced visits.
  await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: `rstart-${randomToken(4)}`, accessToken: "rstart-not-a-token" },
  });
  const client = await prisma.client.create({
    data: { shopId, acuityClientKey: `rstart-${randomToken(6)}`, magicToken: randomToken(), firstName: "Hand" },
  });
  clientId = client.id;
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("the rewards switch records when rewards start", () => {
  it("stamps on, keeps it while on, and moves it on the next switch-on", async () => {
    expect(await startedAt()).toBeNull(); // a new shop starts with rewards off

    const before = Date.now();
    await setRewards(true);
    const first = await startedAt();
    expect(first).not.toBeNull();
    expect(first!.getTime()).toBeGreaterThanOrEqual(before);
    expect(first!.getTime()).toBeLessThanOrEqual(Date.now());

    // Saving "on" again (any settings save that carries it) keeps the start.
    await setRewards(true);
    expect(await startedAt()).toEqual(first);

    await setRewards(false);
    await new Promise((r) => setTimeout(r, 5));
    await setRewards(true);
    expect((await startedAt())!.getTime()).toBeGreaterThan(first!.getTime());
  });
});

describe("a visit that ended before rewards started does not earn by itself", () => {
  beforeAll(async () => {
    // Rewards were switched on two days ago.
    await prisma.shop.update({
      where: { id: shopId },
      data: { rewardsEnabled: true, rewardsStartedAt: new Date(Date.now() - 2 * DAY) },
    });
  });

  it("synced visits: the completion job and the resync punch only the one after the start", async () => {
    const before = acuityAppt("5160001", 3);
    const after = acuityAppt("5160002", 1);
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    await ingestAppointment(shop, "scheduled", before.id, before);
    await ingestAppointment(shop, "scheduled", after.id, after);

    await promoteCompletedVisits(new Date());
    const visits = await prisma.visit.findMany({
      where: { shopId, acuityAppointmentId: { in: [before.id, after.id] } },
      select: { id: true, acuityAppointmentId: true, status: true },
    });
    const byId = new Map(visits.map((v) => [v.acuityAppointmentId, v]));
    expect(byId.get(before.id)?.status).toBe("COMPLETED");
    expect(byId.get(after.id)?.status).toBe("COMPLETED");
    expect(await punchesOn(byId.get(before.id)!.id)).toBe(0);
    expect(await punchesOn(byId.get(after.id)!.id)).toBe(1);

    // The half-hourly resync meets the old one again: still nothing.
    await ingestAppointment(await prisma.shop.findUniqueOrThrow({ where: { id: shopId } }), "scheduled", before.id, before);
    expect(await punchesOn(byId.get(before.id)!.id)).toBe(0);
  });

  it("native bookings: completion punches only the one that ended after the start", async () => {
    const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
    const service = await prisma.service.create({ data: { shopId, name: "Standard", durationMin: 30 } });
    const booked = (endedDaysAgo: number) => {
      const endsAt = new Date(Date.now() - endedDaysAgo * DAY);
      return prisma.appointment.create({
        data: {
          shopId,
          staffId: staff.id,
          serviceId: service.id,
          clientId,
          firstName: "Hand",
          status: "BOOKED",
          startsAt: new Date(endsAt.getTime() - 30 * 60_000),
          endsAt,
          manageToken: randomToken(),
        },
        select: { id: true },
      });
    };
    const early = await booked(3);
    const late = await booked(1);

    await promoteFulfilledAppointments(new Date());
    const rows = await prisma.appointment.findMany({
      where: { id: { in: [early.id, late.id] } },
      select: { id: true, status: true, visitId: true },
    });
    const byId = new Map(rows.map((a) => [a.id, a]));
    expect(byId.get(early.id)?.status).toBe("COMPLETED");
    expect(byId.get(late.id)?.status).toBe("COMPLETED");
    expect(await punchesOn(byId.get(early.id)!.visitId!)).toBe(0);
    expect(await punchesOn(byId.get(late.id)!.visitId!)).toBe(1);
  });

  it("a visit logged by hand still earns, even dated before the start", async () => {
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookie)
      .send({ when: new Date(Date.now() - 5 * DAY).toISOString(), serviceName: "Standard" });
    expect(res.status).toBe(201);
    expect(await punchesOn(res.body.visitId)).toBe(1);
  });

  it("editing an old visit keeps a punch it has, and never invents one it didn't have", async () => {
    await prisma.earnRule.create({ data: { shopId, serviceMatch: "deluxe", punches: 3 } });
    const shop = { id: shopId, punchesPerVisit: 1 };

    // Logged by hand before the start, so it has a punch: re-earned at the new amount.
    const logged = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookie)
      .send({ when: new Date(Date.now() - 6 * DAY).toISOString(), serviceName: "Standard" });
    expect(await punchesOn(logged.body.visitId)).toBe(1);
    expect(await editVisit(shop, clientId, logged.body.visitId, { serviceName: "Deluxe" })).toMatchObject({ ok: true });
    expect(await punchesOn(logged.body.visitId)).toBe(3);

    // Completed before the start without a punch: an edit doesn't give it one.
    const unpunched = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `manual:${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: new Date(Date.now() - 7 * DAY),
        endAt: new Date(Date.now() - 7 * DAY),
        completedAt: new Date(Date.now() - 7 * DAY),
        serviceName: "Standard",
      },
    });
    expect(await editVisit(shop, clientId, unpunched.id, { serviceName: "Deluxe" })).toMatchObject({ ok: true });
    expect(await punchesOn(unpunched.id)).toBe(0);
  });
});
