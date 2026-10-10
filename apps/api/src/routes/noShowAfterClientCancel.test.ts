import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { raceBehindBarrier, winners, type HeldBarrier } from "../testing/raceBarrier.js";

/**
 * 🔴 MARK NO-SHOW MUST NOT OVERWRITE A CLIENT'S OWN CANCEL.
 *
 * POST /appointments/:id/no-show reads the booking, sees BOOKED, then asks
 * cancelAppointment to make it NO_SHOW. Without `onlyFrom`, that write's
 * compare-and-set was "anything but NO_SHOW" - so a client cancelling from
 * their link in between (read BOOKED, client's cancel commits, no-show
 * writes) flipped their CANCELED booking to NO_SHOW, and a kept card was
 * charged the no-show fee for a visit they had properly cancelled.
 *
 * The interleaving is forced, not hoped for: the barrier holds the row the
 * no-show's write must go through, proves the no-show is waiting there, then
 * commits the client's cancel (the same BOOKED -> CANCELED transition the
 * manage page makes) and lets go.
 */

const settleCardOnFile = vi.hoisted(() => vi.fn(async () => ({ action: "none" as const })));
vi.mock("../services/cardOnFileSettle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/cardOnFileSettle.js")>()),
  settleCardOnFile,
}));

const { createApp } = await import("../app.js");
const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;

beforeAll(async () => {
  const email = `noshow-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "No Show", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "No Show Cuts", bookingUrl: "https://ns.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    // A shop that DOES charge a no-show fee to a kept card.
    data: { bookingMode: "native", timezone: "UTC", chargeCardOnFileFees: true },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Solo" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
});

beforeEach(() => {
  settleCardOnFile.mockClear();
});

afterAll(async () => {
  if (shopId) await prisma.emailIntent.deleteMany({ where: { shopId } });
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  await prisma.shop.deleteMany({ where: { ownerId: { in: users.map((u) => u.id) } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

/** A booking about to start, with a card kept on file for a no-show fee. */
async function bookedWithKeptCard(minutesFromNow: number): Promise<string> {
  const startsAt = new Date(Date.now() + minutesFromNow * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Sample",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 40,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  await prisma.cardOnFile.create({
    data: {
      id: `cof_${randomToken(10)}`,
      shopId,
      appointmentId: appt.id,
      stripeCustomerId: `cus_${randomToken(10)}`,
      stripeSetupIntentId: `seti_${randomToken(12)}`,
      stripePaymentMethodId: `pm_${randomToken(12)}`,
      status: "saved",
    },
  });
  return appt.id;
}

/**
 * The client's cancel, holding the very row the no-show's compare-and-set
 * writes through. On release it commits BOOKED -> CANCELED - the transition
 * the manage page's cancel makes - and only then lets the row go.
 */
async function clientCancelHoldingTheRow(id: string): Promise<HeldBarrier> {
  let open!: () => void;
  let acquired!: () => void;
  let failed!: (err: unknown) => void;
  const gate = new Promise<void>((r) => (open = r));
  const ready = new Promise<void>((r, j) => {
    acquired = r;
    failed = j;
  });
  const held = prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Appointment" WHERE id = ${id} FOR UPDATE`;
        acquired();
        await gate;
        await tx.appointment.updateMany({
          where: { id, status: "BOOKED" },
          data: { status: "CANCELED", canceledAt: new Date(), cancellationRevision: { increment: 1 } },
        });
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    .catch((err: unknown) => {
      failed(err);
      throw err;
    });
  await ready;
  return {
    async release() {
      open();
      await held;
    },
  };
}

const markNoShow = (id: string) =>
  request(app).post(`/api/booking/appointments/${id}/no-show`).set("Cookie", cookie).send({});

describe("🔴 Mark no-show against a client's own cancel", () => {
  it("a client's cancel that commits while Mark no-show waits at its write: stays CANCELED, no no-show fee", async () => {
    const id = await bookedWithKeptCard(5);
    const barrier = await clientCancelHoldingTheRow(id);
    const { results, settledEarly } = await raceBehindBarrier(barrier, [() => markNoShow(id)]);
    // The no-show had read BOOKED and was parked at its write - the real window.
    expect(settledEarly).toBe(0);
    const [res] = winners(results);
    expect(res!.status).toBe(409);
    expect(res!.body).toMatchObject({ ok: false, error: "not_booked" });

    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id },
      select: { status: true, canceledAt: true },
    });
    expect(row.status).toBe("CANCELED");
    expect(row.canceledAt).not.toBeNull();
    // No fee: the card-on-file settlement (the no-show charge) is never asked.
    expect(settleCardOnFile).not.toHaveBeenCalled();
    expect((await prisma.cardOnFile.findUniqueOrThrow({ where: { appointmentId: id } })).status).toBe("saved");
  });

  it("an ordinary no-show still marks it and settles the kept card", async () => {
    const id = await bookedWithKeptCard(-10);
    const res = await markNoShow(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id } })).status).toBe("NO_SHOW");
    expect(settleCardOnFile).toHaveBeenCalledTimes(1);
    expect(settleCardOnFile).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: id, outcome: "NO_SHOW" }));
  });

  it("a booking the client already cancelled is refused outright", async () => {
    const id = await bookedWithKeptCard(5);
    await prisma.appointment.update({ where: { id }, data: { status: "CANCELED", canceledAt: new Date() } });
    const res = await markNoShow(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_booked");
    expect(settleCardOnFile).not.toHaveBeenCalled();
  });
});
