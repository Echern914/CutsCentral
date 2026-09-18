import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import request from "supertest";

/**
 * THE POLICY ITSELF, EXERCISED THROUGH THE REAL sendToBarber.
 *
 * 🔴 THIS FILE EXISTS BECAUSE THE ROUTE-LEVEL TEST WAS THEATER. walkInConflict
 * Alert.test.ts mocks `sendToBarber` wholesale, so it can only ever prove that
 * the ROUTE asks for a conflict alert - never that the alert layer honours the
 * request. Falsification showed it plainly: re-gating `conflict` behind a
 * barber-silenceable switch left all six of those tests green.
 *
 * So the switch behaviour is pinned HERE, where the real function runs and only
 * the transport underneath it is mocked. What is being asserted is a product
 * decision, not an implementation detail:
 *
 *   MANDATORY IN KIND. There is no `conflictEnabled` column and no toggle. A
 *   barber can silence every other alert - a booking arrived, one cancelled,
 *   the next client is due - because those are business going fine. "A customer
 *   is about to find someone else in their chair" is an integrity failure, and
 *   it is not theirs to turn off.
 *
 *   OPTIONAL IN CHANNEL. It still respects pushEnabled / smsEnabled /
 *   emailEnabled. Mandatory decides whether there is something to say, never by
 *   what route: a barber who turned push off does not get push back because the
 *   news is bad. Which means the alert CAN reach nobody - and that is why the
 *   durable BookingConflict row and the in-response amber panel, neither of
 *   which can be switched off, are the real delivery.
 */
const sendPushToUser = vi.hoisted(() =>
  vi.fn(async (_p: { userId: string; shopId: string; payload: { body: string } }) => ({
    sent: 1,
    pruned: 0,
    failed: 0,
    anyDelivered: true,
  })),
);
vi.mock("../messaging/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../messaging/push.js")>()),
  sendPushToUser,
}));

const { sendToBarber } = await import("./barberNotify.js");
const { createApp } = await import("../app.js");
const app = createApp();

let shopId = "";
let ownerId = "";

const message = {
  title: "Double-booked chair",
  body: "A walk-in was recorded over time that was already booked. Nothing was discarded - check the other booking.",
};

/** Silence every switch a barber is actually allowed to turn off. */
async function silenceEverythingSilenceable(over: Record<string, boolean> = {}) {
  await prisma.barberNotifyPref.upsert({
    where: { userId_shopId: { userId: ownerId, shopId } },
    create: {
      userId: ownerId,
      shopId,
      newBookingEnabled: false,
      cancelEnabled: false,
      nextUpEnabled: false,
      dayAheadEnabled: false,
      smsEnabled: false,
      emailEnabled: false,
      ...over,
    },
    update: {
      newBookingEnabled: false,
      cancelEnabled: false,
      nextUpEnabled: false,
      dayAheadEnabled: false,
      smsEnabled: false,
      emailEnabled: false,
      ...over,
    },
  });
}

beforeAll(async () => {
  const email = `cpolicy-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Policy", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Policy Cuts", bookingUrl: "https://p.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  ownerId = (
    await prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: { ownerId: true },
    })
  ).ownerId;
});

beforeEach(async () => {
  await prisma.barberNotifyPref.deleteMany({ where: { shopId } });
  sendPushToUser.mockClear();
  sendPushToUser.mockResolvedValue({ sent: 1, pruned: 0, failed: 0, anyDelivered: true });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

describe("a conflict alert is mandatory in KIND", () => {
  it("🔴 goes out for a shop that has silenced every other kind", async () => {
    await silenceEverythingSilenceable();
    const res = await sendToBarber({ shopId, userId: ownerId, kind: "conflict", message });
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(true);
  });

  it("CONTROL: the same prefs DO silence a cancel alert", async () => {
    // Without this, the test above proves nothing - a switch mechanism that is
    // broken for every kind would also let `conflict` through.
    await silenceEverythingSilenceable();
    const res = await sendToBarber({ shopId, userId: ownerId, kind: "cancel", message });
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(res.pushed).toBe(false);
  });

  it("CONTROL: and a new-booking alert", async () => {
    await silenceEverythingSilenceable();
    await sendToBarber({ shopId, userId: ownerId, kind: "newBooking", message });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("there is no per-kind switch to find, even on a fully-populated row", async () => {
    // A row with every documented switch set false. If a conflictEnabled column
    // is ever reintroduced and defaulted, this is where it shows up.
    await silenceEverythingSilenceable();
    const row = await prisma.barberNotifyPref.findUniqueOrThrow({
      where: { userId_shopId: { userId: ownerId, shopId } },
    });
    expect(Object.keys(row)).not.toContain("conflictEnabled");
    await sendToBarber({ shopId, userId: ownerId, kind: "conflict", message });
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });
});

describe("...but OPTIONAL in channel", () => {
  it("🔴 respects pushEnabled: mandatory does not mean it picks the route", async () => {
    await silenceEverythingSilenceable({ pushEnabled: false });
    const res = await sendToBarber({ shopId, userId: ownerId, kind: "conflict", message });
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(res.pushed).toBe(false);
    // 🔴 AND THIS IS THE HONEST CONSEQUENCE: push off, no notifyPhone for SMS
    // to reach, email off - the alert reached NOBODY. Nothing threw and nothing
    // retried. It is the durable BookingConflict row and the amber panel -
    // neither switchable - that carry the news in this state. (Production does
    // set DRY_RUN=false, so a shop WITH a notify phone would also get a text;
    // the point is that neither channel is guaranteed.)
    expect(res).toEqual({ pushed: false, texted: false, emailed: false });
  });

  it("a delivery that fails at the transport is reported, not thrown", async () => {
    await silenceEverythingSilenceable();
    sendPushToUser.mockRejectedValue(new Error("APNs down"));
    // sendToBarber must never throw: it is called after a committed receipt,
    // and an exception escaping here is how a notification problem becomes a
    // money problem.
    const res = await sendToBarber({ shopId, userId: ownerId, kind: "conflict", message });
    expect(res.pushed).toBe(false);
  });

  it("reports pushed:false when nobody has a registered device", async () => {
    await silenceEverythingSilenceable();
    sendPushToUser.mockResolvedValue({ sent: 0, pruned: 0, failed: 0, anyDelivered: false });
    const res = await sendToBarber({ shopId, userId: ownerId, kind: "conflict", message });
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(false);
  });
});
