import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Booking over an Acuity block from the dashboard is allowed - but never
 * silently. The product decision, pinned:
 *
 *  - without the explicit confirm the write is refused and the block is NAMED
 *    (reason, window) so the barber decides with the facts;
 *  - with `customTime` + `overrideExternalBlock` it goes through and leaves an
 *    append-only AppointmentOverride row in the same transaction;
 *  - approve and restore have no override and simply refuse, naming the block;
 *  - a BARBER seat cannot reach any of it (the router is manager-only);
 *  - none of it applies to a customer, who is refused like any taken slot.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

/** `dayOffset` days out at `h` UTC (the shop is pinned to UTC); 12.5 = 12:30. */
const at = (h: number, dayOffset = 5) => {
  const d = new Date(Date.now() + dayOffset * 86_400_000);
  d.setUTCHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  return d;
};

async function signUp(label: string) {
  const email = `blkov-${label}-${randomToken(6)}@test.local`;
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId:
      (res.body.id as string | undefined) ??
      (await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } })).id,
  };
}

beforeAll(async () => {
  const owner = await signUp("owner");
  cookie = owner.cookie;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: "Override Cuts",
      bookingUrl: "https://ov.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  slug = shopRes.body.slug;
  await prisma.shop.update({
    where: { id: shopId },
    data: { timezone: "UTC", bookingMode: "native", publicPageEnabled: true },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 9 * 60, endMin: 18 * 60 },
    });
  }
  // The barber blocked 12:00-14:00 in Acuity, five days out.
  await prisma.externalBlock.create({
    data: {
      shopId,
      externalId: `acuity:${randomToken(6)}`,
      startsAt: at(12),
      endsAt: at(14),
      reason: "Dentist",
    },
  });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

const create = (body: Record<string, unknown>, as = cookie) =>
  request(app)
    .post("/api/booking/appointments")
    .set("Cookie", as)
    .send({ staffId, serviceId, firstName: "Reg", ...body });

describe("creating over an external block", () => {
  it("without Custom time is refused as the grid would refuse it", async () => {
    const res = await create({ startsAt: at(12).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
  });

  it("🔴 with Custom time but no confirmation is refused, and the block is NAMED", async () => {
    const res = await create({ startsAt: at(12, 5).toISOString(), customTime: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external_block");
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
    expect(res.body.confirmable).toBe(true);
    expect(res.body.reason).toMatch(/Blocked in your external calendar: Dentist/);
    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.blocks[0].reason).toBe("Dentist");
    // Nothing landed, and nothing was recorded - there was no override.
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at(12) } })).toBe(0);
    expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 with the explicit confirmation lands AND leaves an audit row in the same transaction", async () => {
    const res = await create({
      startsAt: at(12).toISOString(),
      customTime: true,
      overrideExternalBlock: true,
    });
    expect(res.status).toBe(201);
    const rows = await prisma.appointmentOverride.findMany({ where: { shopId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appointmentId: res.body.id,
      staffId,
      kind: "external_block",
      source: "dashboard_create",
      blockReason: "Dentist",
    });
    expect(rows[0]!.actorUserId).toBeTruthy();
    expect(rows[0]!.blockedFrom.toISOString()).toBe(at(12).toISOString());
    expect(rows[0]!.blockedTo.toISOString()).toBe(at(14).toISOString());
  });

  it("the confirmation flag alone, without Custom time, changes nothing", async () => {
    // overrideExternalBlock is only meaningful with customTime; on its own the
    // ordinary availability gate still refuses.
    const res = await create({ startsAt: at(13).toISOString(), overrideExternalBlock: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
  });

  it("records nothing when Custom time is used on a span that crosses no block", async () => {
    const before = await prisma.appointmentOverride.count({ where: { shopId } });
    const res = await create({
      startsAt: at(19).toISOString(), // after hours, no block
      customTime: true,
      overrideExternalBlock: true,
    });
    expect(res.status).toBe(201);
    expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(before);
  });
});

describe("paths with no override step enforce the block", () => {
  it("approve refuses a request that now sits on a block, naming it", async () => {
    // A customer's request from before the block existed, on a shop that
    // approves requests by hand.
    const pending = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Req",
        status: "PENDING",
        startsAt: at(13, 6),
        endsAt: at(13.5, 6),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12, 6),
        endsAt: at(14, 6),
        reason: "Away",
      },
    });
    const res = await request(app)
      .post(`/api/booking/appointments/${pending.id}/approve`)
      .set("Cookie", cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external_block");
    expect(res.body.confirmable).toBe(false);
    expect(res.body.reason).toMatch(/Away/);
    const row = await prisma.appointment.findUnique({ where: { id: pending.id }, select: { status: true } });
    expect(row!.status).toBe("PENDING");
  });

  it("restore refuses to un-cancel into a block, naming it", async () => {
    const canceled = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Undo",
        status: "CANCELED",
        canceledAt: new Date(),
        startsAt: at(12.5, 6),
        endsAt: at(13, 6),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const res = await request(app)
      .post(`/api/booking/appointments/${canceled.id}/restore`)
      .set("Cookie", cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external_block");
    expect(res.body.confirmable).toBe(false);
  });

  it("editing an appointment INTO a block without the confirmation is refused, naming it", async () => {
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Move",
        status: "BOOKED",
        startsAt: at(10, 6),
        endsAt: at(10.5, 6),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const res = await request(app)
      .patch(`/api/booking/appointments/${appt.id}`)
      .set("Cookie", cookie)
      .send({ startsAt: at(12.5, 6).toISOString(), customTime: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external_block");
    expect(res.body.confirmable).toBe(true);
    // Confirmed: it moves, and the move is on record.
    const ok = await request(app)
      .patch(`/api/booking/appointments/${appt.id}`)
      .set("Cookie", cookie)
      .send({ startsAt: at(12.5, 6).toISOString(), customTime: true, overrideExternalBlock: true });
    expect(ok.status).toBe(200);
    const rows = await prisma.appointmentOverride.findMany({
      where: { shopId, appointmentId: appt.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("dashboard_edit");
  });
});

describe("who may override", () => {
  it("a BARBER seat cannot reach the dashboard write at all", async () => {
    const seat = await signUp("barber");
    await prisma.shopMember.create({
      data: { shopId, userId: seat.userId, role: "BARBER", staffId },
    });
    const res = await create(
      { startsAt: at(12, 7).toISOString(), customTime: true, overrideExternalBlock: true },
      seat.cookie,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_role");
  });

  it("a CUSTOMER is refused like any taken slot - the block is never named to them", async () => {
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: at(12.5, 5).toISOString(),
        firstName: "Cust",
        lastName: "Omer",
        email: "customer@example.com",
        // A crafted POST cannot borrow the dashboard's flags.
        customTime: true,
        overrideExternalBlock: true,
      });
    // The public schema is strict: unknown fields are a 400 before anything
    // else; and without them the write itself answers a plain refusal.
    expect([400, 409]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("Dentist");
    expect(res.body.error).not.toBe("external_block");
  });
});
