import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { runSyncedVisitReminders } from "./syncedVisitReminders.js";

/**
 * Reminders for SYNCED bookings (Acuity / Square).
 *
 * A shop that keeps its own calendar has Visit rows and no Appointment row, so
 * the native reminder job could never see it and those shops got no reminders
 * at all. The behaviour that matters most here is the EXCLUSION: a Visit
 * promoted from a native booking must NOT be reminded from this job, or the
 * client is texted twice for one haircut.
 *
 * The suite runs with DRY_RUN on, so the provider records rather than sends;
 * what is asserted is which rows get STAMPED, which is the idempotency contract.
 */
const email = `syncrem-${randomToken(6)}@test.local`.toLowerCase();
let shopId: string;
let clientId: string;
let userId: string;

/**
 * A PINNED clock, not the wall clock. The sweep takes `now` precisely so tests
 * can be deterministic, and the first version of this file didn't use it - so
 * the whole suite went red whenever it ran between 21:00 and 08:00 UTC: the
 * SMS gate correctly said quiet_hours, DEFERRED the send (that is the feature),
 * nothing was stamped, and the "reminds and stamps" assertion saw 0. Noon UTC
 * puts every relative time this file uses (now .. now+6h) inside the 08-21
 * allowed window, on any machine, at any hour of the night.
 */
const NOW = (() => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d;
})();

/** N hours from the pinned now - what the 24h window is measured against. */
const inHours = (h: number) => new Date(NOW.getTime() + h * 60 * 60 * 1000);

async function makeVisit(opts: {
  at: Date;
  status?: "SCHEDULED" | "CANCELED" | "COMPLETED";
  withAppointment?: boolean;
}): Promise<string> {
  let appointmentId: string | undefined;
  if (opts.withAppointment) {
    const staff = await prisma.staff.create({
      data: { shopId, name: "Barber" },
      select: { id: true },
    });
    const service = await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: 30 },
      select: { id: true },
    });
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        clientId,
        firstName: "Nat",
        startsAt: opts.at,
        endsAt: new Date(opts.at.getTime() + 30 * 60 * 1000),
        status: "BOOKED",
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    appointmentId = appt.id;
  }
  const v = await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acu-${randomToken(8)}`,
      status: opts.status ?? "SCHEDULED",
      scheduledAt: opts.at,
      endAt: new Date(opts.at.getTime() + 30 * 60 * 1000),
      serviceName: "Acuity Fade",
      ...(appointmentId ? { appointment: { connect: { id: appointmentId } } } : {}),
    },
    select: { id: true },
  });
  return v.id;
}

const stamps = (id: string) =>
  prisma.visit.findUniqueOrThrow({
    where: { id },
    select: { reminderSentAt: true, reminderEmailSentAt: true },
  });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email, passwordHash: "x", name: "Sync Rem" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      name: "Synced Reminders",
      slug: `syncrem-${randomToken(6)}`,
      ownerId: user.id,
      timezone: "UTC",
      webhookSecret: randomToken(),
      // Comped so hasActiveAccess passes without a Stripe subscription.
      compAccess: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `syncrem-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Sync",
      phone: "+15555550123",
      // Consent stamped: without it every SMS is correctly skipped and the test
      // would pass for the wrong reason.
      smsConsentAt: new Date(),
    },
    select: { id: true },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("synced visit reminders", () => {
  it("reminds a synced booking inside the 24h window and stamps it once", async () => {
    const id = await makeVisit({ at: inHours(3) });
    expect(await runSyncedVisitReminders(NOW)).toBeGreaterThan(0);
    const first = await stamps(id);
    expect(first.reminderSentAt).not.toBeNull();

    // Idempotent: a second sweep must not re-stamp (i.e. not re-send).
    await runSyncedVisitReminders(NOW);
    const second = await stamps(id);
    expect(second.reminderSentAt?.getTime()).toBe(first.reminderSentAt?.getTime());
  });

  it("NEVER reminds a Visit promoted from a native booking - that would double-text", async () => {
    // The native reminder job already covers this row via its Appointment.
    const id = await makeVisit({ at: inHours(4), withAppointment: true });
    await runSyncedVisitReminders(NOW);
    expect((await stamps(id)).reminderSentAt).toBeNull();
  });

  it("ignores visits outside the window and ones that are not SCHEDULED", async () => {
    const tooFar = await makeVisit({ at: inHours(30) });
    const past = await makeVisit({ at: inHours(-2) });
    const canceled = await makeVisit({ at: inHours(5), status: "CANCELED" });
    await runSyncedVisitReminders(NOW);
    expect((await stamps(tooFar)).reminderSentAt).toBeNull();
    expect((await stamps(past)).reminderSentAt).toBeNull();
    expect((await stamps(canceled)).reminderSentAt).toBeNull();
  });

  it("skips SMS with no consent, leaving the row unstamped for a later fix", async () => {
    const noConsent = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `noconsent-${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "Quiet",
        phone: "+15555550124",
        smsConsentAt: null,
      },
      select: { id: true },
    });
    const v = await prisma.visit.create({
      data: {
        shopId,
        clientId: noConsent.id,
        acuityAppointmentId: `acu-${randomToken(8)}`,
        status: "SCHEDULED",
        scheduledAt: inHours(6),
        serviceName: "Fade",
      },
      select: { id: true },
    });
    await runSyncedVisitReminders(NOW);
    expect((await stamps(v.id)).reminderSentAt).toBeNull();
  });
});
