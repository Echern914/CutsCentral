import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * THE GROUPED CONFIRMATION IS A DURABLE PROMISE, NOT A FIRE-AND-FORGET SEND.
 *
 * 🔴 THE BUG THIS FILE EXISTS FOR. Settlement used to stamp
 * `AppointmentGroup.confirmationSentAt` and then `void` a direct sendEmail().
 * A crash in between - a deploy, an OOM, a frozen instance - lost the
 * confirmation PERMANENTLY: the marker was already set, so nothing retried,
 * and a family holding three real chairs was never told they were booked.
 *
 * Dropping the marker instead would have bought the opposite failure: the
 * settle sweep runs every five minutes, so every replay would put another
 * "you are booked" in front of the same family.
 *
 * Neither needed a new mechanism, and a second notification system is exactly
 * what this must not become. EmailIntent is the durable outbox this codebase
 * already has - the same one the cancellation and affiliate emails ride - and
 * the intent is written in the SAME transaction that claims the marker. The
 * existing worker owns delivery, with the existing bounded retries and the
 * existing provider Idempotency-Key.
 */

const notifyMock = vi.hoisted(() => ({ notifyAppointmentConfirmation: vi.fn() }));
vi.mock("../services/appointmentNotify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/appointmentNotify.js")>();
  return { ...actual, notifyAppointmentConfirmation: notifyMock.notifyAppointmentConfirmation };
});

const {
  GROUP_CONFIRMATION_KIND,
  claimGroupConfirmation,
  deliverGroupConfirmationIntent,
  groupConfirmationKey,
  sendGroupConfirmationOnce,
} = await import("./appointmentGroupSettle.js");
const { runEmailOutbox } = await import("./emailOutbox.js");
const { __setSendEmailForTests } = await import("../messaging/email.js");

let userId = "";
let shopId = "";
let staffId = "";
let serviceId = "";
let groupId = "";
let apptId = "";

const NOW = new Date();
const START = new Date(NOW.getTime() + 4 * 60 * 60 * 1000);

beforeAll(async () => {
  // 🔴 WITHOUT THIS EVERY INTENT SETTLES `SUPPRESSED`. emailDispatchMode() is
  // "unconfigured" in the suite, and the deliverer correctly refuses to spend
  // an attempt on a channel that cannot reach anybody - so the delivery tests
  // would pass while exercising none of the delivery path. An injected sender
  // counts as live, exactly as it does for every other email suite here.
  __setSendEmailForTests(async () => ({ id: "em_group", status: "sent" }));
  const user = await prisma.user.create({
    data: { email: `gconf-${randomToken(6)}@test.local`, passwordHash: "x", name: "G" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Group Confirm Cuts",
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 20, price: 30 },
    select: { id: true },
  });
  serviceId = svc.id;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

let slot = 0;

beforeEach(async () => {
  notifyMock.notifyAppointmentConfirmation.mockReset();
  notifyMock.notifyAppointmentConfirmation.mockResolvedValue(undefined);
  await prisma.emailIntent.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentGroup.deleteMany({ where: { shopId } });

  const group = await prisma.appointmentGroup.create({
    data: {
      shopId,
      staffId,
      firstName: "Eric",
      email: "eric@test.chairback",
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  groupId = group.id;
  const startsAt = new Date(START.getTime() + slot * 60 * 60 * 1000);
  slot += 1;
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      groupId,
      firstName: "Eric",
      email: "eric@test.chairback",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 20 * 60 * 1000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  apptId = appt.id;
});

afterEach(async () => {
  await prisma.emailIntent.deleteMany({ where: { shopId } });
});

const intents = () =>
  prisma.emailIntent.findMany({
    where: { shopId, kind: GROUP_CONFIRMATION_KIND },
    select: { id: true, status: true, idempotencyKey: true, attempts: true },
  });

const markDelivered = () =>
  prisma.appointment.update({
    where: { id: apptId },
    data: { confirmationEmailSentAt: new Date() },
  });

describe("the promise is as durable as the marker", () => {
  it("writes the intent in the same transaction that claims the group", async () => {
    expect(await sendGroupConfirmationOnce(shopId, groupId)).toBe(true);

    const rows = await intents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe(groupConfirmationKey(groupId));
    expect(rows[0]!.status).toBe("PENDING");

    const g = await prisma.appointmentGroup.findUniqueOrThrow({ where: { id: groupId } });
    expect(g.confirmationSentAt).not.toBeNull();
  });

  it("🔴 SENDS NOTHING ITSELF - a crash here can no longer lose it", async () => {
    await sendGroupConfirmationOnce(shopId, groupId);

    // The settlement's job is to make a durable promise, not to reach a
    // provider. Nothing has been dispatched at this point, and that is the
    // fix: the row on disk is what survives the process dying.
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
    expect((await intents())[0]!.status).toBe("PENDING");
  });

  it("a second claim neither re-marks nor duplicates the intent", async () => {
    expect(await sendGroupConfirmationOnce(shopId, groupId)).toBe(true);
    expect(await sendGroupConfirmationOnce(shopId, groupId)).toBe(false);
    expect(await claimGroupConfirmation(shopId, groupId)).toBe(false);

    expect(await intents()).toHaveLength(1);
  });
});

describe("the worker delivers it", () => {
  it("drains through the existing email outbox, not a path of its own", async () => {
    await sendGroupConfirmationOnce(shopId, groupId);
    // The notifier is what actually renders and sends; stamping the
    // appointment is how a confirmed send is recorded.
    notifyMock.notifyAppointmentConfirmation.mockImplementation(async () => {
      await markDelivered();
    });

    const res = await runEmailOutbox();

    expect(res.sent).toBeGreaterThanOrEqual(1);
    expect(notifyMock.notifyAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect((await intents())[0]!.status).toBe("SENT");
  });

  it("🔴 a crash between settlement and delivery is recovered, not lost", async () => {
    await sendGroupConfirmationOnce(shopId, groupId);

    // The process dies before the provider is reached: nothing stamped, the
    // intent still PENDING. Under the old code the marker was already set and
    // this confirmation was gone for good.
    expect((await intents())[0]!.status).toBe("PENDING");

    notifyMock.notifyAppointmentConfirmation.mockImplementation(async () => {
      await markDelivered();
    });
    await runEmailOutbox();

    expect((await intents())[0]!.status).toBe("SENT");
    expect(notifyMock.notifyAppointmentConfirmation).toHaveBeenCalledTimes(1);
  });

  it("🔴 a replay after a confirmed send does not send twice", async () => {
    await sendGroupConfirmationOnce(shopId, groupId);
    await markDelivered();

    // The durable stamp is the second idempotency layer: the deliverer sees
    // the send already happened and settles without touching a provider.
    const res = await runEmailOutbox();

    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
    expect((await intents())[0]!.status).toBe("SENT");
    expect(res.sent).toBeGreaterThanOrEqual(1);
  });

  it("retries when the send did not confirm, rather than giving up", async () => {
    await sendGroupConfirmationOnce(shopId, groupId);
    // Notifier runs but never stamps - the send did not land.
    await runEmailOutbox();

    const row = (await intents())[0]!;
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
  });

  it("stops trying once the party is no longer active", async () => {
    await sendGroupConfirmationOnce(shopId, groupId);
    await prisma.appointmentGroup.update({
      where: { id: groupId },
      data: { status: "CANCELED" },
    });

    await runEmailOutbox();

    // SUPERSEDED, not FAILED: there is no longer a booking to confirm, and
    // that is not a delivery failure.
    expect((await intents())[0]!.status).toBe("SUPERSEDED");
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it("does not burn the attempt budget when there is no address", async () => {
    await prisma.appointment.update({
      where: { id: apptId },
      data: { email: null },
    });
    await sendGroupConfirmationOnce(shopId, groupId);

    await runEmailOutbox();

    const row = (await intents())[0]!;
    expect(row.status).toBe("SUPPRESSED");
    expect(row.attempts).toBe(0);
  });
});

describe("one delivery path, not two", () => {
  it("routes the group kind through the shared outbox deliverer", async () => {
    // 🔴 THE POINT OF THE WHOLE CHANGE. If this kind ever stopped being
    // dispatched by runEmailOutbox, the confirmation would be durable and
    // never delivered - a worse failure than the one being fixed, because it
    // would look correct on disk.
    await sendGroupConfirmationOnce(shopId, groupId);
    notifyMock.notifyAppointmentConfirmation.mockImplementation(async () => {
      await markDelivered();
    });

    const res = await runEmailOutbox();

    expect(res.claimed).toBeGreaterThanOrEqual(1);
    expect((await intents())[0]!.status).toBe("SENT");
  });

  it("carries the group key, which is what Resend collapses on", async () => {
    await sendGroupConfirmationOnce(shopId, groupId);
    const row = (await intents())[0]!;
    // Stable per group: a retry after an ambiguous accept presents the same
    // key, so the provider - not this process - prevents the second copy.
    expect(row.idempotencyKey).toBe(`${GROUP_CONFIRMATION_KIND}:${groupId}`);
  });

  it("deliverGroupConfirmationIntent refuses a claim it does not hold", async () => {
    await sendGroupConfirmationOnce(shopId, groupId);
    const row = (await intents())[0]!;

    const outcome = await deliverGroupConfirmationIntent({
      intentId: row.id,
      claimToken: "not-the-holder",
    });

    expect(outcome).toBe("stale_claim");
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
  });
});
