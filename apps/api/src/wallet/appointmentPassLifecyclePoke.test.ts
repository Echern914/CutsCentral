import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * Every way an appointment FINISHES tells its Wallet pass to re-fetch.
 *
 * The serial is the appointment id, so each booking has its own pass. Cancel
 * and no-show always poked it (cancelAppointment). The completion paths did
 * not: a customer's pass kept showing a live appointment after the cut until
 * its expiry date, because nothing asked the phone to re-fetch. This file pins
 * one poke per completion path - the 15-minute promotion job, "Done", the
 * chair checkout, walk-in completion - plus the undo-cancel, which makes a
 * voided pass live again.
 *
 * The poke is mocked: no APNs, no certificate. What is asserted is that the
 * path CALLS it for the right appointment after it commits. What the pass
 * then SAYS is appointmentPassContent.test.ts.
 */
const wallet = vi.hoisted(() => ({
  poke: vi.fn(async (_appointmentId: string) => "nothing_to_do" as const),
}));
vi.mock("./appointmentPass.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./appointmentPass.js")>()),
  pokeAppointmentPass: wallet.poke,
}));

const { createApp } = await import("../app.js");
const { promoteFulfilledAppointments } = await import(
  "../engines/appointmentPromotion.js"
);
const { completeEntry, startEntry } = await import("../engines/walkInStart.js");
const { createEntryByStaff } = await import("../engines/walkInQueue.js");

const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const email = `passpoke-${randomToken(6)}@test.chairback`.toLowerCase();

let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let userId: string;

/** Yesterday at 09:00 UTC plus a per-test minute, so no two rows collide. */
let seq = 0;
function pastSlot(): Date {
  const d = new Date(Date.now() - DAY_MS);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, ++seq * 40),
  );
}

async function book(
  over: { startsAt?: Date; status?: "BOOKED" | "CANCELED"; canceledAt?: Date } = {},
): Promise<string> {
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `pp-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Pat",
    },
    select: { id: true },
  });
  const startsAt = over.startsAt ?? pastSlot();
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: client.id,
      firstName: "Pat",
      status: over.status ?? "BOOKED",
      canceledAt: over.canceledAt ?? null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 40,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

const status = async (id: string) =>
  (await prisma.appointment.findUnique({ where: { id }, select: { status: true } }))!
    .status;
/**
 * Whether the SHOP finished it - the "Leave a tip" email's signal. Pinned here
 * because this file drives every completion path: the sweep also completes an
 * unmarked no-show, so it must never set this.
 */
const byShop = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { completedByShop: true } }))
    .completedByShop;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Pass Poke", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Pass Poke Cuts", bookingUrl: "https://p.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", walkInEnabled: true },
  });
  userId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    })
  ).id;
});

beforeEach(() => {
  wallet.poke.mockClear();
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("a completion pokes the Wallet pass", () => {
  it("🔴 the 15-minute promotion job", async () => {
    const id = await book();
    await promoteFulfilledAppointments(new Date());
    expect(await status(id)).toBe("COMPLETED");
    expect(wallet.poke).toHaveBeenCalledWith(id);
    expect(await byShop(id)).toBe(false);
  });

  it("🔴 Done (/appointments/:id/complete)", async () => {
    const id = await book();
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/complete`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(await status(id)).toBe("COMPLETED");
    expect(wallet.poke).toHaveBeenCalledWith(id);
    expect(await byShop(id)).toBe(true);
  });

  it("Done on an appointment that is not there pokes nothing", async () => {
    const res = await request(app)
      .post(`/api/booking/appointments/does-not-exist/complete`)
      .set("Cookie", cookie);
    expect(res.status).toBe(404);
    expect(wallet.poke).not.toHaveBeenCalled();
  });

  it("🔴 the chair checkout (/appointments/:id/checkout)", async () => {
    const id = await book();
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/checkout`)
      .set("Cookie", cookie)
      .send({ amount: 40, method: "cash" });
    expect(res.status).toBe(200);
    expect(await status(id)).toBe("COMPLETED");
    expect(wallet.poke).toHaveBeenCalledWith(id);
    expect(await byShop(id)).toBe(true);
  });

  it("🔴 walk-in completion", async () => {
    const manager = { kind: "manager" as const, userId, staffId: null };
    const now = new Date(Date.now() - 2 * DAY_MS);
    const entry = await createEntryByStaff({
      shopId,
      timezone: "UTC",
      actor: manager,
      input: { firstName: "Walk", phone: "+12125557311", serviceIds: [serviceId] },
      now,
    });
    const started = await startEntry({
      shopId,
      entryId: entry.id,
      actor: manager,
      staffId,
      now,
    });
    await completeEntry({
      shopId,
      entryId: entry.id,
      actor: manager,
      now: new Date(now.getTime() + 30 * 60_000),
    });
    expect(await status(started.appointmentId)).toBe("COMPLETED");
    expect(wallet.poke).toHaveBeenCalledWith(started.appointmentId);
    expect(await byShop(started.appointmentId)).toBe(true);
  });

  it("🔴 walk-in completion for a known client (the punch path) marks it finished by the shop", async () => {
    const manager = { kind: "manager" as const, userId, staffId: null };
    const now = new Date(Date.now() - 3 * DAY_MS);
    const entry = await createEntryByStaff({
      shopId,
      timezone: "UTC",
      actor: manager,
      input: { firstName: "Known", phone: "+12125557312", serviceIds: [serviceId] },
      now,
    });
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `pp-${randomToken(8)}`, magicToken: randomToken(), firstName: "Known" },
      select: { id: true },
    });
    await prisma.walkInEntry.update({ where: { id: entry.id }, data: { clientId: client.id } });
    const started = await startEntry({ shopId, entryId: entry.id, actor: manager, staffId, now });
    await completeEntry({ shopId, entryId: entry.id, actor: manager, now: new Date(now.getTime() + 30 * 60_000) });
    const appt = await prisma.appointment.findUniqueOrThrow({
      where: { id: started.appointmentId },
      select: { status: true, clientId: true, completedByShop: true },
    });
    expect(appt).toEqual({ status: "COMPLETED", clientId: client.id, completedByShop: true });
  });
});

describe("an undo-cancel pokes the Wallet pass", () => {
  it("/appointments/:id/restore makes the voided pass re-fetch as booked", async () => {
    const id = await book({
      startsAt: new Date(Date.now() + 3 * DAY_MS),
      status: "CANCELED",
      canceledAt: new Date(Date.now() - 60_000),
    });
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/restore`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(await status(id)).toBe("BOOKED");
    expect(wallet.poke).toHaveBeenCalledWith(id);
  });
});
