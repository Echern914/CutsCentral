import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Undoing a cancel, and clearing a dead row off the day.
 *
 * A cancel does far more than flip a status - it can claw back loyalty, refund
 * through Stripe, tell the waitlist a slot opened and release the Acuity block.
 * Most of that cannot be un-done, so restore is deliberately narrow. These
 * cover each refusal, and the one that actually bites in practice: somebody
 * took the slot while the undo was still on screen.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

async function nativeShop(tag: string): Promise<{
  cookie: string;
  shopId: string;
  staffId: string;
  serviceId: string;
}> {
  const email = `undo-${tag}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Undo Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Undo ${tag}`, bookingUrl: "https://undo.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const shopId = shop.body.id as string;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });
  const staff = await prisma.staff.create({ data: { shopId, name: "Drick" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Mens Haircut", durationMin: 30, price: "40" },
  });
  return { cookie, shopId, staffId: staff.id, serviceId: service.id };
}

/** A BOOKED appointment N hours out. Returns its id. */
async function booking(
  ctx: { shopId: string; staffId: string; serviceId: string },
  hoursOut = 48,
  over: Record<string, unknown> = {},
): Promise<string> {
  const startsAt = new Date(Date.now() + hoursOut * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: ctx.shopId,
      staffId: ctx.staffId,
      serviceId: ctx.serviceId,
      firstName: "Steez",
      lastName: "J",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      priceAtBooking: "40",
      manageToken: randomToken(16),
      ...over,
    },
    select: { id: true },
  });
  return appt.id;
}

const agendaWindow = () =>
  `from=${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}` +
  `&to=${encodeURIComponent(new Date(Date.now() + 30 * 864e5).toISOString())}`;

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

describe("POST /api/booking/appointments/:id/restore", () => {
  it("puts a just-cancelled booking back on the calendar", async () => {
    const ctx = await nativeShop("happy");
    const id = await booking(ctx);

    expect(
      (await request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", ctx.cookie))
        .status,
    ).toBe(200);

    const res = await request(app)
      .post(`/api/booking/appointments/${id}/restore`)
      .set("Cookie", ctx.cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await prisma.appointment.findUnique({
      where: { id },
      select: { status: true, canceledAt: true },
    });
    expect(after?.status).toBe("BOOKED");
    // Left set, the row would read as cancelled to everything downstream.
    expect(after?.canceledAt).toBeNull();
  });

  it("refuses when the slot was taken while the undo was on screen", async () => {
    // The realistic race: cancelling tells the waitlist a slot opened.
    const ctx = await nativeShop("taken");
    const id = await booking(ctx);
    const original = await prisma.appointment.findUnique({
      where: { id },
      select: { startsAt: true, endsAt: true },
    });

    await request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", ctx.cookie);

    // Somebody else books the freed time.
    await prisma.appointment.create({
      data: {
        shopId: ctx.shopId,
        staffId: ctx.staffId,
        serviceId: ctx.serviceId,
        firstName: "Faster",
        lastName: "Client",
        status: "BOOKED",
        startsAt: original!.startsAt,
        endsAt: original!.endsAt,
        manageToken: randomToken(16),
      },
    });

    const res = await request(app)
      .post(`/api/booking/appointments/${id}/restore`)
      .set("Cookie", ctx.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");

    const after = await prisma.appointment.findUnique({
      where: { id },
      select: { status: true },
    });
    expect(after?.status).toBe("CANCELED"); // never half-restored
  });

  it("refuses once the window has passed", async () => {
    const ctx = await nativeShop("late");
    const id = await booking(ctx);
    await request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", ctx.cookie);
    await prisma.appointment.update({
      where: { id },
      data: { canceledAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const res = await request(app)
      .post(`/api/booking/appointments/${id}/restore`)
      .set("Cookie", ctx.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("too_late");
  });

  it("refuses a booking that was already promoted to a Visit", async () => {
    // Its loyalty was clawed back on cancel; re-granting would invent punches.
    const ctx = await nativeShop("visit");
    const id = await booking(ctx, -2);
    const client = await prisma.client.create({
      data: {
        shopId: ctx.shopId,
        firstName: "Promoted",
        lastName: "Client",
        magicToken: randomToken(16),
        acuityClientKey: `test:${randomToken(8)}`,
      },
    });
    const visit = await prisma.visit.create({
      data: {
        shopId: ctx.shopId,
        clientId: client.id,
        acuityAppointmentId: `test:${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    await prisma.appointment.update({
      where: { id },
      data: { clientId: client.id, visitId: visit.id },
    });

    await request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", ctx.cookie);
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/restore`)
      .set("Cookie", ctx.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_restorable");
  });

  it("refuses a booking that is not cancelled", async () => {
    const ctx = await nativeShop("live");
    const id = await booking(ctx);
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/restore`)
      .set("Cookie", ctx.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_canceled");
  });

  it("never restores another shop's appointment (tenant isolation)", async () => {
    const a = await nativeShop("iso-a");
    const b = await nativeShop("iso-b");
    const id = await booking(a);
    await request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", a.cookie);

    const res = await request(app)
      .post(`/api/booking/appointments/${id}/restore`)
      .set("Cookie", b.cookie);
    expect(res.status).toBe(404);
    expect(
      (await prisma.appointment.findUnique({ where: { id }, select: { status: true } }))?.status,
    ).toBe("CANCELED");
  });
});

describe("POST /api/booking/appointments/:id/dismiss", () => {
  it("takes a cancelled row off the agenda without deleting it", async () => {
    const ctx = await nativeShop("dismiss");
    const id = await booking(ctx);
    await request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", ctx.cookie);

    const before = await request(app)
      .get(`/api/booking/agenda?${agendaWindow()}`)
      .set("Cookie", ctx.cookie);
    expect(before.body.agenda).toHaveLength(1);

    const res = await request(app)
      .post(`/api/booking/appointments/${id}/dismiss`)
      .set("Cookie", ctx.cookie);
    expect(res.status).toBe(200);

    const after = await request(app)
      .get(`/api/booking/agenda?${agendaWindow()}`)
      .set("Cookie", ctx.cookie);
    expect(after.body.agenda).toHaveLength(0);

    // Presentation only - the history is still there.
    const row = await prisma.appointment.findUnique({
      where: { id },
      select: { status: true, dismissedAt: true },
    });
    expect(row?.status).toBe("CANCELED");
    expect(row?.dismissedAt).not.toBeNull();
  });

  it("refuses to hide a live booking", async () => {
    // Otherwise "remove" becomes a way to lose an appointment you still owe.
    const ctx = await nativeShop("live-dismiss");
    const id = await booking(ctx);
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/dismiss`)
      .set("Cookie", ctx.cookie);
    expect(res.status).toBe(404);

    const after = await request(app)
      .get(`/api/booking/agenda?${agendaWindow()}`)
      .set("Cookie", ctx.cookie);
    expect(after.body.agenda).toHaveLength(1);
  });

  it("un-hides the row when the cancel is undone", async () => {
    const ctx = await nativeShop("undismiss");
    const id = await booking(ctx);
    await request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", ctx.cookie);
    await request(app).post(`/api/booking/appointments/${id}/dismiss`).set("Cookie", ctx.cookie);

    expect(
      (await request(app).post(`/api/booking/appointments/${id}/restore`).set("Cookie", ctx.cookie))
        .status,
    ).toBe(200);

    // Restoring a booking the barber then couldn't see would be the worst of
    // both outcomes.
    const after = await request(app)
      .get(`/api/booking/agenda?${agendaWindow()}`)
      .set("Cookie", ctx.cookie);
    expect(after.body.agenda).toHaveLength(1);
    expect(after.body.agenda[0].status).toBe("upcoming");
  });

  it("never dismisses another shop's appointment (tenant isolation)", async () => {
    const a = await nativeShop("iso-d-a");
    const b = await nativeShop("iso-d-b");
    const id = await booking(a);
    await request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", a.cookie);

    const res = await request(app)
      .post(`/api/booking/appointments/${id}/dismiss`)
      .set("Cookie", b.cookie);
    expect(res.status).toBe(404);
    expect(
      (await prisma.appointment.findUnique({ where: { id }, select: { dismissedAt: true } }))
        ?.dismissedAt,
    ).toBeNull();
  });
});
