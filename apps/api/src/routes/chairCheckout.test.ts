import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * POST /api/booking/appointments/:id/checkout — the chair-side "Start checkout".
 *
 * What actually matters here is money arithmetic, not the happy path:
 *   - checking out COMPLETES the cut through the one promotion path, so a
 *     Visit + punch appear exactly as if the barber had tapped Done. There is
 *     no second loyalty ledger.
 *   - a double tap must not turn one $60 cut into a $120 day. The second
 *     checkout 409s and the recorded figure is untouched.
 *   - the amount is the barber's final word: a tip or a discount is kept
 *     verbatim, not silently reset to the ticket price.
 *   - a cut nobody can be paid for (canceled) has no chair moment.
 */
const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

/** Yesterday at a given UTC hour — a cut that already happened. */
function past(hour: number, minute = 0): Date {
  const d = new Date(Date.now() - DAY_MS);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute),
  );
}

async function makeShop(label: string) {
  const email = `checkout-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Checkout", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://c.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC" },
  });
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  return { cookie, shopId, staffId: staff.id, serviceId: service.id };
}

type Shop = Awaited<ReturnType<typeof makeShop>>;

let seq = 0;
async function book(
  s: Shop,
  opts: { price?: number; status?: "BOOKED" | "COMPLETED" | "CANCELED" } = {},
): Promise<{ id: string; clientId: string }> {
  const client = await prisma.client.create({
    data: {
      shopId: s.shopId,
      acuityClientKey: `co-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Jose",
      lastName: "Romero",
    },
    select: { id: true },
  });
  const startsAt = new Date(past(9).getTime() + ++seq * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      clientId: client.id,
      firstName: "Jose",
      lastName: "Romero",
      status: opts.status ?? "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: opts.price ?? 60,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return { id: appt.id, clientId: client.id };
}

const url = (id: string) => `/api/booking/appointments/${id}/checkout`;
const paid = (id: string) =>
  prisma.appointment.findUnique({
    where: { id },
    select: { paidAmount: true, paidMethod: true, paidAt: true, status: true, visitId: true },
  });

let S: Shop;

beforeAll(async () => {
  S = await makeShop("Checkout Cuts");
});

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

describe("chair-side checkout", () => {
  it("records the money and completes the cut through the one promotion path", async () => {
    const { id, clientId } = await book(S);
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, method: "cash" });
    expect(res.status).toBe(200);

    const row = await paid(id);
    expect(Number(row!.paidAmount)).toBe(60);
    expect(row!.paidMethod).toBe("cash");
    expect(row!.paidAt).not.toBeNull();

    // Completed exactly as "Done" would: a promoted Visit, keyed booking:{id}.
    expect(row!.visitId).not.toBeNull();
    const visit = await prisma.visit.findUnique({
      where: { id: row!.visitId! },
      select: { status: true, clientId: true, acuityAppointmentId: true },
    });
    expect(visit!.status).toBe("COMPLETED");
    expect(visit!.clientId).toBe(clientId);
    expect(visit!.acuityAppointmentId).toBe(`booking:${id}`);
  });

  it("keeps the barber's own figure — a tip is not reset to the ticket", async () => {
    const { id } = await book(S, { price: 60 });
    // $60 cut, $75 handed over. The extra $15 is the barber's and must survive.
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 75.5, method: "cash" });
    expect(res.status).toBe(200);
    expect(Number((await paid(id))!.paidAmount)).toBe(75.5);

    // And the other direction: a regular gets $10 off.
    const cheap = await book(S, { price: 60 });
    await request(app)
      .post(url(cheap.id))
      .set("Cookie", S.cookie)
      .send({ amount: 50, method: "direct" });
    expect(Number((await paid(cheap.id))!.paidAmount)).toBe(50);
  });

  it("a double tap does not charge the day twice", async () => {
    const { id } = await book(S);
    const first = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, method: "cash" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, method: "card" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("paid_already");

    // The FIRST record stands, untouched — method included.
    const row = await paid(id);
    expect(Number(row!.paidAmount)).toBe(60);
    expect(row!.paidMethod).toBe("cash");
  });

  it("can collect on a cut already marked done", async () => {
    // "Done" first, money after — the barber tapped Done walking to the desk.
    const { id } = await book(S);
    expect(
      (await request(app).post(`/api/booking/appointments/${id}/complete`).set("Cookie", S.cookie))
        .status,
    ).toBe(200);

    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, method: "cash" });
    expect(res.status).toBe(200);
    expect(Number((await paid(id))!.paidAmount)).toBe(60);
  });

  it("refuses a canceled cut, a bad body, and another shop's appointment", async () => {
    const canceled = await book(S, { status: "CANCELED" });
    const no = await request(app)
      .post(url(canceled.id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, method: "cash" });
    expect(no.status).toBe(404);

    const { id } = await book(S);
    const bad = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, method: "bitcoin" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_input");
    // Nothing recorded by the rejected call.
    expect((await paid(id))!.paidAt).toBeNull();

    const other = await makeShop("Other Cuts");
    const theirs = await book(other);
    const cross = await request(app)
      .post(url(theirs.id))
      .set("Cookie", S.cookie) // OUR session, THEIR appointment
      .send({ amount: 60, method: "cash" });
    expect(cross.status).toBe(404);
    expect((await paid(theirs.id))!.paidAt).toBeNull();
  });
});
