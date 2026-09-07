import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Booking over an Acuity block from the dashboard is allowed - but never
 * silently, and never blind. The protocol, end to end:
 *
 *  - the first attempt is REFUSED and the block is NAMED (reason, window, in
 *    the shop's zone) so the barber decides with the facts;
 *  - the refusal carries a `confirmation` digest of exactly those blocks;
 *    replaying it is what authorises the write, and it authorises nothing else;
 *  - a confirmation that no longer describes the conflict (a block added,
 *    renamed, cleared) is refused again with the NEW conflict and a NEW digest;
 *  - a confirmed write leaves an append-only AppointmentOverride row in the
 *    SAME transaction;
 *  - approve and restore have no confirmation step and simply refuse;
 *  - a BARBER seat cannot reach any of it (the router is manager-only), with or
 *    without a valid digest;
 *  - none of it applies to a customer, who is refused like any taken slot and
 *    is never told a block exists.
 *
 * All three write paths - create, reschedule, edit - go through the same rule.
 * The reschedule endpoint has no web caller today; it is covered here so it
 * cannot drift into being the one door that fails open.
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
  it("🔴 is refused, and the refusal NAMES the block instead of a flat 'not available'", async () => {
    // No Custom time, no confirmation: the grid would refuse this, but "that
    // time isn't available" tells the barber nothing he can act on. The block
    // is the only thing in the way, so the block is what he is told about.
    const res = await create({ startsAt: at(12).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external_block");
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
    expect(res.body.confirmable).toBe(true);
    expect(res.body.reason).toMatch(/Blocked in your external calendar: Dentist/);
    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.blocks[0].reason).toBe("Dentist");
    expect(res.body.confirmation).toMatch(/^[0-9a-f]{32}$/);
    // Nothing landed, and nothing was recorded - there was no confirmation.
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at(12) } })).toBe(0);
    expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 with Custom time but no confirmation is refused the same way", async () => {
    const res = await create({ startsAt: at(12, 5).toISOString(), customTime: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external_block");
    expect(res.body.confirmable).toBe(true);
    expect(res.body.confirmation).toMatch(/^[0-9a-f]{32}$/);
    expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 with the confirmation from that refusal it lands, and the override is on record", async () => {
    const refused = await create({ startsAt: at(12).toISOString() });
    expect(refused.status).toBe(409);
    const res = await create({
      startsAt: at(12).toISOString(),
      externalBlockConfirmation: refused.body.confirmation,
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
    await prisma.appointmentOverride.deleteMany({ where: { shopId } });
    await prisma.appointment.deleteMany({ where: { id: res.body.id } });
  });

  it("🔴 a confirmation for ANOTHER day's block does not authorise this one", async () => {
    // A block on a different day, refused there, gives a perfectly valid digest.
    const other = await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12, 8),
        endsAt: at(14, 8),
        reason: "Away",
      },
      select: { id: true },
    });
    try {
      const elsewhere = await create({ startsAt: at(12, 8).toISOString() });
      expect(elsewhere.status).toBe(409);
      const res = await create({
        startsAt: at(12, 5).toISOString(),
        externalBlockConfirmation: elsewhere.body.confirmation,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("external_block");
      expect(res.body.confirmation).not.toBe(elsewhere.body.confirmation);
      expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(0);
    } finally {
      await prisma.externalBlock.delete({ where: { id: other.id } });
    }
  });

  it("🔴 a STALE confirmation cannot authorise a block created afterwards", async () => {
    const refused = await create({ startsAt: at(12, 9).toISOString() }).then(async (r) => {
      // Day 9 has no block yet, so seed one, then take the refusal for it.
      return r;
    });
    expect(refused.status).toBe(201); // free time - clean up and start properly
    await prisma.appointment.deleteMany({ where: { id: refused.body.id } });

    const first = await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12, 9),
        endsAt: at(13, 9),
        reason: "Dentist",
      },
      select: { id: true },
    });
    let second: { id: string } | null = null;
    try {
      const shown = await create({ startsAt: at(12, 9).toISOString() });
      expect(shown.status).toBe(409);
      const stale = shown.body.confirmation as string;

      // While the banner sits on his screen, Acuity syncs ANOTHER block over
      // the same half hour.
      second = await prisma.externalBlock.create({
        data: {
          shopId,
          externalId: `acuity:${randomToken(6)}`,
          startsAt: at(12, 9),
          endsAt: at(12.5, 9),
          reason: "School run",
        },
        select: { id: true },
      });

      const res = await create({
        startsAt: at(12, 9).toISOString(),
        externalBlockConfirmation: stale,
      });
      expect(res.status).toBe(409);
      expect(res.body.reason).toMatch(/School run/);
      expect(res.body.confirmation).not.toBe(stale);
      expect(await prisma.appointment.count({ where: { shopId, startsAt: at(12, 9) } })).toBe(0);
      expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(0);

      // The new confirmation, describing both blocks, does land.
      const ok = await create({
        startsAt: at(12, 9).toISOString(),
        externalBlockConfirmation: res.body.confirmation,
      });
      expect(ok.status).toBe(201);
      expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(2);
      await prisma.appointmentOverride.deleteMany({ where: { shopId } });
      await prisma.appointment.deleteMany({ where: { id: ok.body.id } });
    } finally {
      if (second) await prisma.externalBlock.delete({ where: { id: second.id } });
      await prisma.externalBlock.delete({ where: { id: first.id } });
    }
  });

  it("🔴 a confirmation cannot carry a write past HOURS - only past the block", async () => {
    // 20:00 is outside the 09:00-18:00 rules AND inside no block: the flat
    // refusal stands and there is no confirmation to be had.
    const res = await create({ startsAt: at(20, 5).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
    expect(res.body.confirmation).toBeUndefined();
  });

  it("records nothing when Custom time is used on a span that crosses no block", async () => {
    const before = await prisma.appointmentOverride.count({ where: { shopId } });
    const res = await create({
      startsAt: at(19).toISOString(), // after hours, no block
      customTime: true,
    });
    expect(res.status).toBe(201);
    expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(before);
    await prisma.appointment.deleteMany({ where: { id: res.body.id } });
  });
});

describe("rescheduling over an external block", () => {
  /** A booking at 10:00 on `day`, to be moved onto the blocked afternoon. */
  async function bookingAt(day: number) {
    return prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Move",
        status: "BOOKED",
        startsAt: at(10, day),
        endsAt: at(10.5, day),
        manageToken: randomToken(),
      },
      select: { id: true, startsAt: true },
    });
  }

  it("🔴 refuses, names the block, changes nothing - then moves on the confirmation", async () => {
    const appt = await bookingAt(10);
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12, 10),
        endsAt: at(14, 10),
        reason: "Dentist",
      },
    });
    const refused = await request(app)
      .post(`/api/booking/appointments/${appt.id}/reschedule`)
      .set("Cookie", cookie)
      .send({ startsAt: at(12.5, 10).toISOString() });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("external_block");
    expect(refused.body.confirmable).toBe(true);
    expect(refused.body.reason).toMatch(/Dentist/);
    expect(refused.body.confirmation).toMatch(/^[0-9a-f]{32}$/);
    // Zero mutation: it is still at 10:00.
    const unchanged = await prisma.appointment.findUniqueOrThrow({
      where: { id: appt.id },
      select: { startsAt: true },
    });
    expect(unchanged.startsAt.toISOString()).toBe(at(10, 10).toISOString());

    const ok = await request(app)
      .post(`/api/booking/appointments/${appt.id}/reschedule`)
      .set("Cookie", cookie)
      .send({
        startsAt: at(12.5, 10).toISOString(),
        externalBlockConfirmation: refused.body.confirmation,
      });
    expect(ok.status).toBe(200);
    const moved = await prisma.appointment.findUniqueOrThrow({
      where: { id: appt.id },
      select: { startsAt: true },
    });
    expect(moved.startsAt.toISOString()).toBe(at(12.5, 10).toISOString());
    const rows = await prisma.appointmentOverride.findMany({
      where: { shopId, appointmentId: appt.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("dashboard_reschedule");
  });

  it("🔴 refuses an invented confirmation - the digest has to match the block", async () => {
    const appt = await bookingAt(11);
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12, 11),
        endsAt: at(14, 11),
        reason: "Away",
      },
    });
    const res = await request(app)
      .post(`/api/booking/appointments/${appt.id}/reschedule`)
      .set("Cookie", cookie)
      .send({ startsAt: at(12.5, 11).toISOString(), externalBlockConfirmation: "0".repeat(32) });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external_block");
    const unchanged = await prisma.appointment.findUniqueOrThrow({
      where: { id: appt.id },
      select: { startsAt: true },
    });
    expect(unchanged.startsAt.toISOString()).toBe(at(10, 11).toISOString());
  });
});

describe("editing an appointment onto an external block", () => {
  it("🔴 refuses with the block by name, leaves the booking untouched, then moves on confirmation", async () => {
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Move",
        status: "BOOKED",
        startsAt: at(10, 6),
        endsAt: at(10.5, 6),
        notes: "regular",
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

    // The sheet has no Custom time switch: this is exactly what it sends.
    const refused = await request(app)
      .patch(`/api/booking/appointments/${appt.id}`)
      .set("Cookie", cookie)
      .send({ startsAt: at(12.5, 6).toISOString(), notes: "moved him" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("external_block");
    expect(refused.body.code).toBe("SLOT_UNAVAILABLE");
    expect(refused.body.confirmable).toBe(true);
    expect(refused.body.reason).toMatch(/Blocked in your external calendar: Away/);
    expect(refused.body.blocks[0].startsAt).toBe(at(12, 6).toISOString());
    expect(refused.body.confirmation).toMatch(/^[0-9a-f]{32}$/);

    // 🔴 ZERO MUTATION: not the time, and not the other field in the same
    // patch. The guard is the first statement in the transaction.
    const before = await prisma.appointment.findUniqueOrThrow({
      where: { id: appt.id },
      select: { startsAt: true, notes: true },
    });
    expect(before.startsAt.toISOString()).toBe(at(10, 6).toISOString());
    expect(before.notes).toBe("regular");

    const ok = await request(app)
      .patch(`/api/booking/appointments/${appt.id}`)
      .set("Cookie", cookie)
      .send({
        startsAt: at(12.5, 6).toISOString(),
        notes: "moved him",
        externalBlockConfirmation: refused.body.confirmation,
      });
    expect(ok.status).toBe(200);
    const after = await prisma.appointment.findUniqueOrThrow({
      where: { id: appt.id },
      select: { startsAt: true, notes: true },
    });
    expect(after.startsAt.toISOString()).toBe(at(12.5, 6).toISOString());
    expect(after.notes).toBe("moved him");
    const rows = await prisma.appointmentOverride.findMany({
      where: { shopId, appointmentId: appt.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("dashboard_edit");
    expect(rows[0]!.blockReason).toBe("Away");
  });

  it("🔴 a valid confirmation cannot move a booking onto ANOTHER booking", async () => {
    // 🔴 12:15-12:45, deliberately NOT starting at the target minute. Aimed at
    // 12:30 exactly, the partial unique index on (staffId, startsAt) refuses
    // the write on its own and the test passes whether or not the overlap
    // re-check inside the advisory lock exists. Overlapping at a different
    // start is a conflict ONLY that re-check can see.
    const taken = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Sitting",
        status: "BOOKED",
        startsAt: at(12.25, 12),
        endsAt: at(12.75, 12),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const mover = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Mover",
        status: "BOOKED",
        startsAt: at(10, 12),
        endsAt: at(10.5, 12),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12, 12),
        endsAt: at(14, 12),
        reason: "Away",
      },
    });
    // A real, current confirmation for that block - taken from a free minute
    // inside it so the refusal is about the block and nothing else.
    const shown = await request(app)
      .patch(`/api/booking/appointments/${mover.id}`)
      .set("Cookie", cookie)
      .send({ startsAt: at(13.5, 12).toISOString() });
    expect(shown.status).toBe(409);
    expect(shown.body.error).toBe("external_block");

    // Now aim it at the occupied half hour, carrying that confirmation.
    const res = await request(app)
      .patch(`/api/booking/appointments/${mover.id}`)
      .set("Cookie", cookie)
      .send({
        startsAt: at(12.5, 12).toISOString(),
        externalBlockConfirmation: shown.body.confirmation,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
    expect(res.body.error).not.toBe("external_block");
    const unmoved = await prisma.appointment.findUniqueOrThrow({
      where: { id: mover.id },
      select: { startsAt: true },
    });
    expect(unmoved.startsAt.toISOString()).toBe(at(10, 12).toISOString());
    expect(taken.id).toBeTruthy();
  });

  it("a move to a time that is merely outside hours still refuses flatly", async () => {
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Late",
        status: "BOOKED",
        startsAt: at(10, 13),
        endsAt: at(10.5, 13),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const res = await request(app)
      .patch(`/api/booking/appointments/${appt.id}`)
      .set("Cookie", cookie)
      .send({ startsAt: at(21, 13).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
    expect(res.body.confirmation).toBeUndefined();
  });
});

describe("paths with no confirmation step enforce the block", () => {
  it("approve refuses a request that now sits on a block, naming it and offering NO confirmation", async () => {
    // A customer's request from before the block existed, on a shop that
    // approves requests by hand.
    const pending = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Req",
        status: "PENDING",
        startsAt: at(13, 7),
        endsAt: at(13.5, 7),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12, 7),
        endsAt: at(14, 7),
        reason: "Away",
      },
    });
    const res = await request(app)
      .post(`/api/booking/appointments/${pending.id}/approve`)
      .set("Cookie", cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external_block");
    expect(res.body.confirmable).toBe(false);
    expect(res.body.confirmation).toBeUndefined();
    expect(res.body.reason).toMatch(/Away/);
    const row = await prisma.appointment.findUnique({
      where: { id: pending.id },
      select: { status: true },
    });
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
        startsAt: at(12.5, 7),
        endsAt: at(13, 7),
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
    expect(res.body.confirmation).toBeUndefined();
  });
});

describe("who may confirm", () => {
  it("🔴 a BARBER seat cannot reach the dashboard write, valid confirmation or not", async () => {
    const shown = await create({ startsAt: at(12, 5).toISOString() });
    expect(shown.status).toBe(409);
    const seat = await signUp("barber");
    await prisma.shopMember.create({
      data: { shopId, userId: seat.userId, role: "BARBER", staffId },
    });
    // Earlier cases in this file left their own confirmed overrides on record;
    // what matters here is that the barber seat adds none.
    const before = await prisma.appointmentOverride.count({ where: { shopId } });
    for (const body of [
      { startsAt: at(12, 5).toISOString() },
      { startsAt: at(12, 5).toISOString(), externalBlockConfirmation: shown.body.confirmation },
    ]) {
      const res = await create(body, seat.cookie);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden_role");
    }
    expect(await prisma.appointmentOverride.count({ where: { shopId } })).toBe(before);
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
        // A crafted POST cannot borrow the dashboard's fields.
        customTime: true,
        externalBlockConfirmation: "0".repeat(32),
      });
    // The public schema is strict: unknown fields are a 400 before anything
    // else; and without them the write itself answers a plain refusal.
    expect([400, 409]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("Dentist");
    expect(res.body.error).not.toBe("external_block");
    expect(res.body.confirmation).toBeUndefined();
  });
});
