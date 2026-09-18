import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * THE ALERT IS THE BONUS. THE RECEIPT AND THE ROW ARE THE PRODUCT.
 *
 * A double-booked chair produces three things, and they are not equally
 * reliable - so the code must never let the least reliable one endanger the
 * other two:
 *
 *   1. the RECEIPT      - committed, in a transaction. Money.
 *   2. the CONFLICT ROW - committed in the SAME transaction. Evidence.
 *   3. the ALERT        - fire-and-forget, AFTER commit, best-effort.
 *
 * 🔴 (3) CAN FAIL AND MUST NOT MATTER. Push needs a registered subscription,
 * barber-alert SMS sits behind DRY_RUN (default true, so it sends nothing in
 * production today) and email defaults off - so a conflict alert genuinely can
 * reach nobody. That is understood rather than hidden: the two deliveries that
 * cannot be switched off are the amber panel in the response, on the screen of
 * the person who just did it, and the durable row, which waits as long as it
 * takes. This file pins that a failing alert costs neither.
 *
 * 🔴 AND IT IS DEDUPLICATED BY CREATION, NOT DETECTION. A retry re-detects the
 * same collision. The unique index means nothing new is written, and the alert
 * is gated on rows CREATED, so the manager is told exactly once.
 */
const sendToBarber = vi.hoisted(() =>
  vi.fn(async (_params: { kind: string; message: { body: string } }) => ({
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
const app = createApp();

let cookie = "";
let shopId = "";
let ownerId = "";
let staffId = "";
let serviceId = "";

const walkIn = (body: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/booking/appointments/walk-in")
    .set("Cookie", cookie)
    .send({ amount: 30, staffId, ...body });

const receipts = () =>
  prisma.appointment.count({ where: { shopId, firstName: "Walk-in" } });
const conflicts = () => prisma.bookingConflict.count({ where: { shopId } });

/** Waits for the post-commit, fire-and-forget alert attempt to have happened. */
const alertSettled = (times = 1) =>
  vi.waitFor(() => expect(sendToBarber).toHaveBeenCalledTimes(times), {
    timeout: 5000,
    interval: 25,
  });

/** Long enough for a SECOND alert to have shown up, if one were coming. */
const settle = () => new Promise((r) => setTimeout(r, 300));

beforeAll(async () => {
  const email = `alertpol-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Alert", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Alert Cuts", bookingUrl: "https://al.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  ownerId = (
    await prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: { ownerId: true },
    })
  ).ownerId;
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Chair" });
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
  await prisma.barberNotifyPref.deleteMany({ where: { shopId } });
  sendToBarber.mockClear();
  sendToBarber.mockResolvedValue({ pushed: true, texted: false, emailed: false });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

/** A BOOKED appointment straddling now, so the next walk-in collides with it. */
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

describe("the manager alert for a double-booked chair", () => {
  it("1. ONE new conflict produces exactly ONE alert", async () => {
    await bookAcross();
    const res = await walkIn();
    expect(res.status).toBe(201);
    expect(res.body.conflict).toBeTruthy();

    await alertSettled(1);
    await settle();
    expect(sendToBarber).toHaveBeenCalledTimes(1);
    expect(sendToBarber.mock.calls[0]![0].kind).toBe("conflict");
    expect(await conflicts()).toBe(1);
  });

  it("2. a RETRY of that submission produces NO second alert", async () => {
    await bookAcross();
    const operationId = `op-${randomToken(12)}`;

    const first = await walkIn({ operationId });
    expect(first.status).toBe(201);
    await alertSettled(1);

    // The same submission again - a double tap, a timeout, a flaky connection.
    const retry = await walkIn({ operationId });
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    // It STILL reports the conflict in the answer: the warning must not vanish
    // just because this is the second time they asked.
    expect(retry.body.conflict).toBeTruthy();

    // ...but the manager is not told twice. Gated on rows CREATED (0 on the
    // replay), never on rows detected.
    await settle();
    expect(sendToBarber).toHaveBeenCalledTimes(1);
    expect(await receipts()).toBe(1);
    expect(await conflicts()).toBe(1);
  });

  it("3. 🔴 a FAILING alert loses no receipt and duplicates none", async () => {
    await bookAcross();
    // Every channel down: the provider throws rather than returning a result.
    sendToBarber.mockRejectedValue(new Error("push provider unreachable"));

    const res = await walkIn({ operationId: `op-${randomToken(12)}` });
    // The barber is still told it worked, and still warned - the notification
    // is downstream of the answer, not part of it.
    expect(res.status).toBe(201);
    expect(res.body.conflict).toBeTruthy();

    await alertSettled(1);
    await settle();

    // The money is on the books exactly once. A rejected alert must never
    // unwind a committed transaction, and must never be retried in a way that
    // writes a second receipt.
    expect(await receipts()).toBe(1);
  });

  it("4. 🔴 a FAILING alert leaves the conflict DURABLE for later", async () => {
    const booked = await bookAcross();
    sendToBarber.mockRejectedValue(new Error("push provider unreachable"));

    const res = await walkIn({ operationId: `op-${randomToken(12)}` });
    expect(res.status).toBe(201);
    await alertSettled(1);
    await settle();

    // The whole reason the row exists: nobody got the push, so the evidence
    // has to still be here tomorrow for a human to work from.
    const rows = await prisma.bookingConflict.findMany({ where: { shopId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conflictingId).toBe(booked.id);
    expect(rows[0]!.conflictingKind).toBe("appointment");
    expect(rows[0]!.resolvedAt).toBeNull();
    expect(rows[0]!.source).toBe("walk_in_quick_log");
  });

  it("5. 🔴 MANDATORY: sent even for a shop that silenced every other kind", async () => {
    // A conflict is operational integrity, not communication. There is no
    // conflictEnabled column and no toggle, on purpose: turning off new-booking
    // and cancel alerts must not silence "a customer is about to find someone
    // else in their chair".
    await prisma.barberNotifyPref.create({
      data: {
        userId: ownerId,
        shopId,
        newBookingEnabled: false,
        cancelEnabled: false,
        nextUpEnabled: false,
        dayAheadEnabled: false,
      },
    });

    await bookAcross();
    expect((await walkIn()).status).toBe(201);
    await alertSettled(1);
    expect(sendToBarber.mock.calls[0]![0].kind).toBe("conflict");
  });

  it("6. the alert body claims NOTHING about money", async () => {
    await bookAcross();
    expect((await walkIn()).status).toBe(201);
    await alertSettled(1);

    // Same rule as the amber panel: the walk-in stores a barber-typed amount
    // ChairBack never authorised or captured, so an alert that says "payment"
    // is claiming something it cannot stand behind.
    const body = sendToBarber.mock.calls[0]![0].message.body;
    expect(body).not.toMatch(/payment|money|paid|charged/i);
    expect(body).toMatch(/nothing was discarded/i);
    // ...and no customer detail leaves the shop in a push notification.
    expect(body).not.toMatch(/\d{3}[-.\s]?\d{4}/);
  });
});
