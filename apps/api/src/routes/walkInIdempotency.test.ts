import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * SERIALISATION IS NOT IDEMPOTENCY, and money is what the difference costs.
 *
 * The advisory lock makes two concurrent walk-in writes take turns. It does not
 * make them ONE write — and it must not, because two genuine cuts seconds apart
 * are two receipts with two payments. Both live shops do exactly that (seven
 * seconds apart at one, fifteen at the other).
 *
 * What must collapse is one submission RETRIED: a timeout, a double tap, a
 * flaky connection. The only thing that can tell those apart is an identifier
 * the client mints once and reuses — not the customer, not the amount, not the
 * service, not "within N seconds", every one of which guesses, and a wrong
 * guess either bills a customer twice or deletes a cut that really happened.
 *
 * 🔴 THE ALERT IS DEDUPLICATED BY THE SAME FACT. A retry re-detects the same
 * collision; the unique index means nothing new is written, and the alert is
 * gated on rows CREATED rather than rows detected, so the manager is told once.
 */
// Typed parameters on purpose: Railway typechecks .test.ts too, and an
// untyped vi.fn() gives `mock.calls` an empty tuple, so reading calls[0][0]
// is a build error rather than a test failure.
const sendToBarber = vi.hoisted(() =>
  vi.fn(async (_params: { kind: string }) => ({
    pushed: true,
    texted: false,
    emailed: false,
  })),
);
vi.mock("../services/barberNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/barberNotify.js")>()),
  sendToBarber,
}));

const { createApp } = await import("../app.js");
const { raceBehindAdvisoryLock } = await import("../testing/raceBarrier.js");

const app = createApp();
const password = "supersecret123";
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;

const walkIn = (body: Record<string, unknown>) =>
  request(app)
    .post("/api/booking/appointments/walk-in")
    .set("Cookie", cookie)
    .send({ amount: 30, staffId, ...body });

const receipts = () =>
  prisma.appointment.count({ where: { shopId, firstName: "Walk-in" } });

beforeAll(async () => {
  const email = `walkidem-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Idem", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Idem Cuts", bookingUrl: "https://i.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", cookie)
        .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 })
    ).status,
  ).toBe(200);
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] });
  expect(svc.status).toBe(201);
  serviceId = svc.body.id;
});

beforeEach(async () => {
  await prisma.bookingConflict.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  sendToBarber.mockClear();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

/** A BOOKED appointment straddling now, so the next walk-in collides. */
async function bookAcross() {
  const now = Date.now();
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Booked",
      status: "BOOKED",
      startsAt: new Date(now - 5 * 60_000),
      endsAt: new Date(now + 25 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

describe("one submission, however many times it is sent", () => {
  it("1. TWO SIMULTANEOUS RETRIES of one submission create ONE receipt", async () => {
    const operationId = `op-${randomToken(12)}`;
    // Both racers queue on the guard's own advisory key, so they genuinely
    // contend: settledEarly === 0 is what a missing lock would fail.
    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `appt:${staffId}`,
      [() => walkIn({ operationId }), () => walkIn({ operationId })],
    );
    expect(settledEarly).toBe(0);
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<request.Response> =>
        r.status === "fulfilled" && r.value.status === 201,
    );
    // Both callers are told it worked - a retry must never report failure, or
    // the barber taps Save again and genuinely double-records.
    expect(ok).toHaveLength(2);
    // ...and they are told about the SAME receipt.
    expect(new Set(ok.map((r) => r.value.body.id)).size).toBe(1);
    expect(await receipts()).toBe(1);
  });

  it("2. TWO SIMULTANEOUS LEGITIMATE receipts create TWO receipts", async () => {
    // Different ids: two real cuts, two payments. Collapsing these would be
    // the expensive failure in the other direction.
    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `appt:${staffId}`,
      [
        () => walkIn({ operationId: `op-${randomToken(12)}` }),
        () => walkIn({ operationId: `op-${randomToken(12)}` }),
      ],
    );
    expect(settledEarly).toBe(0);
    expect(
      results.filter(
        (r): r is PromiseFulfilledResult<request.Response> =>
          r.status === "fulfilled" && r.value.status === 201,
      ),
    ).toHaveLength(2);
    expect(await receipts()).toBe(2);
  });

  it("3. a RETRIED CONFLICTING receipt: one receipt, one conflict row, one alert", async () => {
    const booked = await bookAcross();
    const operationId = `op-${randomToken(12)}`;

    const first = await walkIn({ operationId });
    expect(first.status).toBe(201);
    expect(first.body.conflict.withAppointmentIds).toContain(booked.id);

    const retry = await walkIn({ operationId });
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);

    expect(await receipts()).toBe(1);
    expect(await prisma.bookingConflict.count({ where: { shopId } })).toBe(1);
    // 🔴 Told once. The retry detects the same collision and creates nothing.
    await vi.waitFor(() => expect(sendToBarber).toHaveBeenCalledTimes(1));
    expect(sendToBarber.mock.calls[0]![0].kind).toBe("conflict");
  });

  it("4. the answer is STABLE when the first commit is never seen by the client", async () => {
    // The timeout case: the write landed, the caller never heard. It retries
    // with the same id and must get the same answer, conflict included.
    const booked = await bookAcross();
    const operationId = `op-${randomToken(12)}`;

    const first = await walkIn({ operationId });
    expect(first.status).toBe(201);

    const replay = await walkIn({ operationId });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.conflict.withAppointmentIds).toEqual(
      first.body.conflict.withAppointmentIds,
    );
    expect(replay.body.conflict.withAppointmentIds).toContain(booked.id);
    expect(await receipts()).toBe(1);
  });
});

describe("compatibility with a client that sends no id", () => {
  it("🔴 nothing is deduplicated by inference — two sends are two receipts", async () => {
    // An older client cannot be guessed at. Two identical requests seconds
    // apart are two cuts unless something SAYS they are one.
    expect((await walkIn({})).status).toBe(201);
    expect((await walkIn({})).status).toBe(201);
    expect(await receipts()).toBe(2);
  });

  it("a conflict is still recorded and alerted without an id", async () => {
    await bookAcross();
    expect((await walkIn({})).status).toBe(201);
    expect(await prisma.bookingConflict.count({ where: { shopId } })).toBe(1);
    await vi.waitFor(() => expect(sendToBarber).toHaveBeenCalledTimes(1));
  });
});
