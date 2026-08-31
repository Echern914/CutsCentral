import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { notifyAppointmentConfirmation } from "./appointmentNotify.js";

/**
 * RESCHEDULE COMPLETENESS - one contract per production entry point.
 *
 * The bug this pins: reschedule reset the SMS stamps but not the EMAIL ones,
 * and confirmation SMS is disabled for cost (CONFIRMATION_SMS_ENABLED=false),
 * so email is the only channel a customer hears about a booking on. A
 * rescheduled appointment therefore told the customer NOTHING and never
 * re-armed a reminder for the new time. The existing reschedule test asserted
 * only the SMS stamps, so it passed throughout.
 *
 * The three entry points do NOT share one contract, and pretending they do
 * would be the same mistake in reverse:
 *
 *  - public manage-link reschedule  -> resets email stamps, re-sends by email
 *  - dashboard reschedule           -> resets email stamps, re-sends by email
 *  - AI receptionist reschedule     -> CHAT-ONLY BY DESIGN. The agent's own SMS
 *    reply is the confirmation, so confirmationSentAt is stamped forward
 *    rather than cleared; only the REMINDER is re-armed. Asserted explicitly
 *    below so the contract is a decision on the record, not an oversight.
 */

const NOON = new Date("2026-06-01T16:00:00Z");
let emails: SendEmailInput[] = [];
let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;

async function makeAppointment(): Promise<string> {
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Casey",
      email: "casey@example.com",
    },
  });
  const startsAt = new Date(NOON.getTime() + 3 * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: client.id,
      firstName: "Casey",
      email: "casey@example.com",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    emails.push(input);
    return { id: `em${emails.length}`, status: "sent" };
  });
  const user = await prisma.user.create({
    data: { email: `rs-${randomToken(6)}@test.local`, passwordHash: "x", name: "R" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Reschedule Cuts",
      slug: `rs-${randomToken(5)}`.toLowerCase(),
      bookingMode: "native",
      webhookSecret: randomToken(),
      compAccess: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Skin Fade", durationMin: 30 },
    select: { id: true },
  });
  serviceId = service.id;
});

afterEach(async () => {
  emails = [];
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

/** What every customer-facing reschedule path writes when it moves a booking. */
const CUSTOMER_FACING_RESET = {
  confirmationSentAt: null,
  reminderSentAt: null,
  confirmationEmailSentAt: null,
  reminderEmailSentAt: null,
} as const;

describe("customer-facing reschedule paths (public manage link, dashboard)", () => {
  it("re-sends the confirmation email exactly once for the NEW time", async () => {
    const id = await makeAppointment();
    // First confirmation, as at booking.
    await notifyAppointmentConfirmation({ shopId, appointmentId: id, now: NOON });
    expect(emails).toHaveLength(1);
    const firstWhen = emails[0]!.text;

    // The reschedule write, exactly as both routes perform it.
    const moved = new Date(NOON.getTime() + 26 * 60 * 60 * 1000);
    await prisma.appointment.update({
      where: { id },
      data: {
        startsAt: moved,
        endsAt: new Date(moved.getTime() + 30 * 60 * 1000),
        ...CUSTOMER_FACING_RESET,
      },
    });

    await notifyAppointmentConfirmation({ shopId, appointmentId: id, now: NOON });
    expect(emails).toHaveLength(2); // 🔴 was ZERO before the stamp fix
    expect(emails[1]!.text).not.toBe(firstWhen); // and it carries the new time

    // Exactly once: a repeat call does not re-send.
    await notifyAppointmentConfirmation({ shopId, appointmentId: id, now: NOON });
    expect(emails).toHaveLength(2);
  });

  it("re-arms the email reminder for the new time", async () => {
    const id = await makeAppointment();
    await prisma.appointment.update({
      where: { id },
      data: { reminderEmailSentAt: NOON, confirmationEmailSentAt: NOON },
    });
    await prisma.appointment.update({
      where: { id },
      data: CUSTOMER_FACING_RESET,
    });
    const appt = await prisma.appointment.findUnique({ where: { id } });
    expect(appt!.reminderEmailSentAt).toBeNull();
    expect(appt!.confirmationEmailSentAt).toBeNull();
  });
});

describe("the AI receptionist path is CHAT-ONLY, deliberately", () => {
  it("stamps the confirmation forward (the agent's SMS is the confirmation) and re-arms only the reminder", async () => {
    const id = await makeAppointment();
    await notifyAppointmentConfirmation({ shopId, appointmentId: id, now: NOON });
    expect(emails).toHaveLength(1);

    // The receptionist's reschedule write, verbatim in shape.
    const moved = new Date(NOON.getTime() + 26 * 60 * 60 * 1000);
    await prisma.appointment.update({
      where: { id },
      data: {
        startsAt: moved,
        endsAt: new Date(moved.getTime() + 30 * 60 * 1000),
        confirmationSentAt: NOON, // stamped forward, NOT cleared
        reminderSentAt: null,
        reminderEmailSentAt: null, // the reminder re-arms
      },
    });

    // No second confirmation email: the customer is mid-conversation and the
    // agent has already told them. This is the contract, not a gap.
    await notifyAppointmentConfirmation({ shopId, appointmentId: id, now: NOON });
    expect(emails).toHaveLength(1);

    const appt = await prisma.appointment.findUnique({ where: { id } });
    expect(appt!.confirmationEmailSentAt).not.toBeNull(); // still claimed
    expect(appt!.reminderEmailSentAt).toBeNull(); // but a reminder will come
  });
});
