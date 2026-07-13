import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  __setPushSenderForTests,
  type PushPayload,
} from "../messaging/push.js";
import {
  APPOINTMENT_NUDGE_KIND,
  NudgeLimitError,
  sendAppointmentNudge,
} from "./appointmentNudge.js";

/**
 * The barber "come early" nudge engine: max-2-per-appointment enforced at the
 * DB layer under an advisory lock (survives a concurrent race), the audit row
 * lifecycle PENDING -> SENT/FAILED, and push-only delivery.
 */

let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string; // has a push device
let quietClientId: string; // no push device

let pushes: PushPayload[] = [];

async function seedAppt(opts?: {
  clientId?: string | null;
  status?: "BOOKED" | "CANCELED";
  startsInMin?: number;
}): Promise<string> {
  const startsAt = new Date(Date.now() + (opts?.startsInMin ?? 120) * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: opts?.clientId === undefined ? clientId : opts.clientId,
      firstName: "Marcus",
      status: opts?.status ?? "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

beforeAll(async () => {
  __setPushSenderForTests({
    send: async (_sub, payload) => {
      pushes.push(JSON.parse(payload) as PushPayload);
    },
  });

  const user = await prisma.user.create({
    data: { email: `nudge-${randomToken(6)}@test.chairback`, name: "N" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Nudge Cuts",
      slug: `nudge-${randomToken(5)}`,
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
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30 },
    select: { id: true },
  });
  serviceId = service.id;

  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `nudge-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Marcus",
    },
    select: { id: true },
  });
  clientId = client.id;
  await prisma.pushSubscription.create({
    data: {
      shopId,
      clientId,
      kind: "web",
      endpoint: `https://push.test/${randomToken(8)}`,
      p256dh: "k",
      auth: "a",
    },
  });

  const quiet = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `nudge-q-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Quiet",
    },
    select: { id: true },
  });
  quietClientId = quiet.id;
});

beforeEach(() => {
  pushes = [];
});

afterAll(async () => {
  __setPushSenderForTests(undefined);
  // Remove this suite's appointments: the "past" BOOKED row would otherwise be
  // picked up by promoteFulfilledAppointments in a LATER suite's idempotency
  // assertion (its endsAt ≈ this suite's wall-clock run time, which can fall
  // between that test's fixed midday `now` and its real-now re-run).
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

describe("sendAppointmentNudge", () => {
  it("sends up to 2 nudges then rejects the 3rd, logging SENT audit rows", async () => {
    const apptId = await seedAppt();

    const r1 = await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "Chair's open" });
    expect(r1).toEqual({ ok: true, delivered: true });
    const r2 = await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "Still open" });
    expect(r2.ok).toBe(true);

    await expect(
      sendAppointmentNudge({ shopId, appointmentId: apptId, body: "Third" }),
    ).rejects.toThrow(NudgeLimitError);

    const rows = await prisma.nudge.findMany({
      where: { appointmentId: apptId, kind: APPOINTMENT_NUDGE_KIND },
      select: { status: true, channel: true, sentAt: true, body: true },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("SENT");
      expect(row.channel).toBe("WEB_PUSH");
      expect(row.sentAt).not.toBeNull();
    }
    expect(pushes).toHaveLength(2);
    // The push deep-links to the manage page so the reply buttons are one tap.
    expect(pushes[0]!.url).toContain("/book/manage/");
  });

  it("cannot be raced past the cap (two concurrent sends, one slot left)", async () => {
    const apptId = await seedAppt();
    await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "One" });

    const results = await Promise.allSettled([
      sendAppointmentNudge({ shopId, appointmentId: apptId, body: "A" }),
      sendAppointmentNudge({ shopId, appointmentId: apptId, body: "B" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof NudgeLimitError,
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const count = await prisma.nudge.count({
      where: { appointmentId: apptId, kind: APPOINTMENT_NUDGE_KIND },
    });
    expect(count).toBe(2);
  });

  it("marks the audit row FAILED when the client has no push device", async () => {
    const apptId = await seedAppt({ clientId: quietClientId });
    const r = await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "Hello?" });
    expect(r).toEqual({ ok: true, delivered: false });

    const row = await prisma.nudge.findFirst({
      where: { appointmentId: apptId, kind: APPOINTMENT_NUDGE_KIND },
      select: { status: true, failedReason: true },
    });
    expect(row!.status).toBe("FAILED");
    expect(row!.failedReason).toBe("no_push_device");
    expect(pushes).toHaveLength(0);
  });

  it("FAILED (undelivered) attempts do not consume the cap", async () => {
    // Two nudges into the void (client has no device), then the client gets a
    // device: the barber can still send both real nudges.
    const apptId = await seedAppt({ clientId: quietClientId });
    await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "one" });
    await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "two" });

    await prisma.pushSubscription.create({
      data: {
        shopId,
        clientId: quietClientId,
        kind: "web",
        endpoint: `https://push.test/${randomToken(8)}`,
        p256dh: "k",
        auth: "a",
      },
    });
    const r3 = await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "three" });
    expect(r3).toEqual({ ok: true, delivered: true });
    const r4 = await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "four" });
    expect(r4.ok).toBe(true);
    // Two DELIVERED nudges now cap it.
    await expect(
      sendAppointmentNudge({ shopId, appointmentId: apptId, body: "five" }),
    ).rejects.toThrow(NudgeLimitError);
  });

  it("refuses canceled, past, and clientless appointments", async () => {
    const canceled = await seedAppt({ status: "CANCELED" });
    const past = await seedAppt({ startsInMin: -30 });
    const noClient = await seedAppt({ clientId: null });
    for (const apptId of [canceled, past, noClient]) {
      const r = await sendAppointmentNudge({ shopId, appointmentId: apptId, body: "x" });
      expect(r.ok).toBe(false);
    }
    expect(pushes).toHaveLength(0);
  });
});
