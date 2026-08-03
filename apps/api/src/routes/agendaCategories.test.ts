import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Day-gauge buckets on GET /api/booking/agenda: the "Haircuts 10/12" counter on
 * the barber's calendar. Every row must carry the categoryId it counts toward,
 * and `categories` must list each bucket with its DISPLAY-ONLY dailyTarget.
 *
 * The two rules worth defending here, because getting either wrong silently
 * corrupts the number the barber reads:
 *   1. a grouped service counts toward its GROUP, never toward itself, so the
 *      per-bucket counts sum to the total (10/12 + 2/4 = 12/16),
 *   2. dailyTarget is NOT a cap - booking past it must still succeed.
 * Synced shops have no service relation on Visit, so their bucket is matched
 * from the service NAME; that folding is covered too.
 */
const app = createApp();
const password = "supersecret123";

async function signupAndShop(
  email: string,
  shopName: string,
): Promise<{ cookie: string; shopId: string }> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Gauge Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://gauge.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie, shopId: shop.body.id as string };
}

const WINDOW = {
  from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  to: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

function getAgenda(cookie: string) {
  return request(app)
    .get(
      `/api/booking/agenda?from=${encodeURIComponent(WINDOW.from)}&to=${encodeURIComponent(WINDOW.to)}`,
    )
    .set("Cookie", cookie);
}

const emails: string[] = [];

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("GET /api/booking/agenda - day-gauge categories", () => {
  it("buckets a grouped service under its GROUP, so per-bucket counts sum to the total", async () => {
    const email = `gauge-native-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, shopId } = await signupAndShop(email, "Gauge Native Cuts");
    await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });

    const staff = await prisma.staff.create({ data: { shopId, name: "Drick" } });
    const haircuts = await prisma.serviceGroup.create({
      data: { shopId, name: "Haircuts", dailyTarget: 12 },
    });
    const retwists = await prisma.serviceGroup.create({
      data: { shopId, name: "Retwists", dailyTarget: 4 },
    });
    // TWO services inside Haircuts: the group total must count both, which is
    // the whole reason the bucket is the group and not the service.
    const mens = await prisma.service.create({
      data: {
        shopId,
        name: "Mens Haircut",
        durationMin: 30,
        serviceGroupId: haircuts.id,
      },
    });
    const kids = await prisma.service.create({
      data: {
        shopId,
        name: "Kids Haircut",
        durationMin: 30,
        serviceGroupId: haircuts.id,
      },
    });
    const retwist = await prisma.service.create({
      data: {
        shopId,
        name: "Retwist",
        durationMin: 90,
        serviceGroupId: retwists.id,
      },
    });
    // Ungrouped, with its own target - it becomes a bucket in its own right.
    const beard = await prisma.service.create({
      data: { shopId, name: "Beard Trim", durationMin: 15, dailyTarget: 3 },
    });

    let at = Date.now() + 2 * 60 * 60 * 1000;
    async function book(serviceId: string, status = "BOOKED") {
      const start = new Date(at);
      at += 2 * 60 * 60 * 1000;
      await prisma.appointment.create({
        data: {
          shopId,
          staffId: staff.id,
          serviceId,
          firstName: "Client",
          lastName: randomToken(4),
          status: status as "BOOKED",
          startsAt: start,
          endsAt: new Date(start.getTime() + 30 * 60 * 1000),
          manageToken: randomToken(16),
        },
      });
    }
    await book(mens.id);
    await book(mens.id);
    await book(kids.id); // 3 in Haircuts, across two member services
    await book(retwist.id); // 1 in Retwists
    await book(beard.id); // 1 ungrouped

    const res = await getAgenda(cookie);
    expect(res.status).toBe(200);

    const categories = res.body.categories as {
      id: string;
      name: string;
      target: number | null;
    }[];
    expect(categories).toEqual(
      expect.arrayContaining([
        { id: haircuts.id, name: "Haircuts", target: 12 },
        { id: retwists.id, name: "Retwists", target: 4 },
        { id: beard.id, name: "Beard Trim", target: 3 },
      ]),
    );
    // A GROUPED service must NOT also appear as its own bucket, or the barber
    // would see the same booking counted twice.
    const ids = categories.map((c) => c.id);
    expect(ids).not.toContain(mens.id);
    expect(ids).not.toContain(kids.id);
    expect(ids).not.toContain(retwist.id);

    const rows = res.body.agenda as { categoryId: string | null }[];
    const countOf = (id: string) => rows.filter((r) => r.categoryId === id).length;
    expect(countOf(haircuts.id)).toBe(3);
    expect(countOf(retwists.id)).toBe(1);
    expect(countOf(beard.id)).toBe(1);
    // Every booking landed in exactly one bucket: the buckets sum to the total.
    expect(countOf(haircuts.id) + countOf(retwists.id) + countOf(beard.id)).toBe(
      rows.length,
    );
  });

  it("leaves blocked time uncategorized (it isn't a booking)", async () => {
    const email = `gauge-block-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, shopId } = await signupAndShop(email, "Gauge Block Cuts");
    await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });

    const staff = await prisma.staff.create({ data: { shopId, name: "Drick" } });
    const start = new Date(Date.now() + 3 * 60 * 60 * 1000);
    await prisma.availabilityException.create({
      data: {
        shopId,
        staffId: staff.id,
        isBlock: true,
        startsAt: start,
        endsAt: new Date(start.getTime() + 3 * 60 * 60 * 1000),
        reason: "Blocked Time",
      },
    });

    const res = await getAgenda(cookie);
    expect(res.status).toBe(200);
    const block = (res.body.agenda as { source: string; categoryId: string | null }[]).find(
      (r) => r.source === "block",
    );
    expect(block).toBeDefined();
    expect(block!.categoryId).toBeNull();
  });

  it("buckets a synced Visit by folded service name, and leaves an unknown name out", async () => {
    const email = `gauge-synced-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, shopId } = await signupAndShop(email, "Gauge Synced Cuts");
    // Left in the default (synced) booking mode: rows come from Visit.

    const haircuts = await prisma.serviceGroup.create({
      data: { shopId, name: "Haircuts", dailyTarget: 12 },
    });
    await prisma.service.create({
      data: {
        shopId,
        name: "Mens Haircut",
        durationMin: 30,
        serviceGroupId: haircuts.id,
      },
    });

    const client = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: "Emel", lastName: "Rodriguez" });
    expect(client.status).toBe(201);
    const clientId = client.body.id as string;

    let at = Date.now() + 2 * 60 * 60 * 1000;
    async function visit(serviceName: string) {
      const scheduledAt = new Date(at);
      at += 2 * 60 * 60 * 1000;
      await prisma.visit.create({
        data: {
          shopId,
          clientId,
          acuityAppointmentId: `test:${randomToken(8)}`,
          status: "SCHEDULED",
          scheduledAt,
          endAt: new Date(scheduledAt.getTime() + 30 * 60 * 1000),
          serviceName,
        },
      });
    }
    // Acuity names carry emoji, case and punctuation the shop's own name lacks -
    // all of it is folded away before matching.
    await visit("Mens Haircut");
    await visit("  ⭐ MENS HAIRCUT! ⭐ ");
    // No service by this name: uncategorized rather than guessed into a bucket.
    await visit("After/Before Hours Haircut $60");

    const res = await getAgenda(cookie);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("visit");

    const rows = res.body.agenda as { serviceName: string; categoryId: string | null }[];
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.categoryId === haircuts.id)).toHaveLength(2);
    const unmatched = rows.find((r) => r.serviceName.startsWith("After/Before"));
    expect(unmatched!.categoryId).toBeNull();
  });

  it("dailyTarget is DISPLAY ONLY: booking past it still succeeds", async () => {
    const email = `gauge-nocap-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, shopId } = await signupAndShop(email, "Gauge NoCap Cuts");
    await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });

    const staff = await prisma.staff.create({ data: { shopId, name: "Drick" } });
    const group = await prisma.serviceGroup.create({
      // Target of 1, and deliberately NO maxPerDay: the target must not behave
      // like the cap. This is the failure mode that would cost a barber money.
      data: { shopId, name: "Haircuts", dailyTarget: 1, maxPerDay: null },
    });
    const service = await prisma.service.create({
      data: {
        shopId,
        name: "Mens Haircut",
        durationMin: 30,
        serviceGroupId: group.id,
      },
    });
    // The dashboard create requires the staff to actually offer the service.
    await prisma.serviceStaff.create({
      data: { shopId, serviceId: service.id, staffId: staff.id },
    });

    const day = new Date(Date.now() + 24 * 60 * 60 * 1000);
    for (const hour of [0, 1]) {
      const startsAt = new Date(day.getTime() + hour * 60 * 60 * 1000);
      const created = await request(app)
        .post("/api/booking/appointments")
        .set("Cookie", cookie)
        .send({
          staffId: staff.id,
          serviceId: service.id,
          firstName: "Walk",
          lastName: `In${hour}`,
          startsAt: startsAt.toISOString(),
          // The barber's own calendar can place a time outside computed
          // availability; the target must not be what stops it.
          customTime: true,
        });
      expect(created.status).toBe(201);
    }

    const res = await getAgenda(cookie);
    const booked = (res.body.agenda as { categoryId: string | null }[]).filter(
      (r) => r.categoryId === group.id,
    );
    // 2 booked against a target of 1 - the gauge will read 2/1, by design.
    expect(booked).toHaveLength(2);
    expect(
      (res.body.categories as { id: string; target: number | null }[]).find(
        (c) => c.id === group.id,
      )!.target,
    ).toBe(1);
  });
});
