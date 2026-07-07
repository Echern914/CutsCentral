import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { forShop, prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import type { MessageProvider } from "../messaging/provider.js";
import {
  notifyAppointmentConfirmation,
  notifyAppointmentReminder,
} from "./appointmentNotify.js";

/**
 * The EMAIL leg of native booking notifications. The point of email: it delivers
 * even while SMS is dark (no 10DLC / no client consent), because a booking email
 * is transactional and doesn't need SMS consent or quiet hours. SMS and email are
 * independent channels with independent idempotency stamps, so a customer can get
 * BOTH (like Acuity).
 */

// Weekday midday in the shop's default tz (America/New_York) — inside SMS quiet
// hours so the SMS leg is allowed when consent is present.
const NOON = new Date("2026-06-01T16:00:00Z"); // 12:00 EDT

let sms: { to: string; body: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sms.push(input);
    return { sid: `SM${sms.length}`, status: "queued" };
  },
};

let emails: SendEmailInput[] = [];

let userId: string;

/** A shop with comp access (so billing never gates), in the default tz. */
async function makeShop(): Promise<{ id: string; name: string }> {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Native Cuts",
      bookingMode: "native",
      webhookSecret: randomToken(),
      compAccess: true,
    },
    select: { id: true, name: true },
  });
  return shop;
}

/**
 * Build a native appointment (staff + service + client + Appointment) and return
 * the appointment id. `consented`/`phone`/`email` shape which channel can fire.
 */
async function makeAppointment(
  shopId: string,
  opts: { consented?: boolean; phone?: string | null; email?: string | null } = {},
): Promise<string> {
  // Raw prisma for creation (the tenant wrapper has no appointment.create; RLS is
  // off for the owner connection the app uses). Reads still exercise forShop.
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Haircut", durationMin: 30 },
  });
  const phone = opts.phone === undefined ? "+13025550000" : opts.phone;
  const email = opts.email === undefined ? "casey@example.com" : opts.email;
  const consented = opts.consented ?? false;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Casey",
      phone,
      email,
      smsConsentAt: consented ? NOON : null,
      smsConsentSource: consented ? "booking" : null,
    },
  });
  const startsAt = new Date(NOON.getTime() + 3 * 60 * 60 * 1000); // 3h out
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.id,
      serviceId: service.id,
      clientId: client.id,
      firstName: "Casey",
      phone,
      email,
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
  __setMessageProviderForTests(fakeProvider);
  __setSendEmailForTests(async (input) => {
    emails.push(input);
    return { id: `em${emails.length}`, status: "sent" };
  });
  const user = await prisma.user.create({
    data: { email: `appt-${randomToken(6)}@test.local`, passwordHash: "x", name: "A" },
  });
  userId = user.id;
});

afterEach(async () => {
  sms = [];
  emails = [];
  await prisma.nudge.deleteMany({ where: { shop: { ownerId: userId } } });
  await prisma.appointment.deleteMany({ where: { shop: { ownerId: userId } } });
  await prisma.client.deleteMany({ where: { shop: { ownerId: userId } } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("appointment confirmation email", () => {
  it("emails even with NO sms consent (the SMS-dark unlock)", async () => {
    const shop = await makeShop();
    const appointmentId = await makeAppointment(shop.id, { consented: false });

    await notifyAppointmentConfirmation({ shopId: shop.id, appointmentId, now: NOON });

    // SMS skipped (no consent), but email went out.
    expect(sms.length).toBe(0);
    expect(emails.length).toBe(1);
    expect(emails[0]!.to).toBe("casey@example.com");
    expect(emails[0]!.subject).toContain("Native Cuts");
    expect(emails[0]!.html).toContain("Haircut");

    // Email stamp set; SMS stamp still null (so 10DLC could still text later).
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { confirmationEmailSentAt: true, confirmationSentAt: true },
    });
    expect(appt?.confirmationEmailSentAt).not.toBeNull();
    expect(appt?.confirmationSentAt).toBeNull();
  });

  it("sends BOTH sms and email when the client is consented", async () => {
    const shop = await makeShop();
    const appointmentId = await makeAppointment(shop.id, { consented: true });

    await notifyAppointmentConfirmation({ shopId: shop.id, appointmentId, now: NOON });

    expect(sms.length).toBe(1);
    expect(emails.length).toBe(1);
  });

  it("is idempotent — a second call does not re-email", async () => {
    const shop = await makeShop();
    const appointmentId = await makeAppointment(shop.id, { consented: false });

    await notifyAppointmentConfirmation({ shopId: shop.id, appointmentId, now: NOON });
    await notifyAppointmentConfirmation({ shopId: shop.id, appointmentId, now: NOON });

    expect(emails.length).toBe(1);
  });

  it("skips email when there is no address on the appointment or client", async () => {
    const shop = await makeShop();
    const appointmentId = await makeAppointment(shop.id, {
      consented: false,
      email: null,
    });

    await notifyAppointmentConfirmation({ shopId: shop.id, appointmentId, now: NOON });

    expect(emails.length).toBe(0);
  });
});

describe("appointment reminder email", () => {
  it("reminds by email with no sms consent, and stamps only the email field", async () => {
    const shop = await makeShop();
    const appointmentId = await makeAppointment(shop.id, { consented: false });

    const ok = await notifyAppointmentReminder({ shopId: shop.id, appointmentId, now: NOON });

    expect(ok).toBe(true);
    expect(sms.length).toBe(0);
    expect(emails.length).toBe(1);
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { reminderEmailSentAt: true, reminderSentAt: true },
    });
    expect(appt?.reminderEmailSentAt).not.toBeNull();
    expect(appt?.reminderSentAt).toBeNull();
  });

  it("does not remind a canceled appointment", async () => {
    const shop = await makeShop();
    const appointmentId = await makeAppointment(shop.id, { consented: false });
    await forShop(shop.id).appointment.update({
      where: { id: appointmentId },
      data: { status: "CANCELED" },
    });

    const ok = await notifyAppointmentReminder({ shopId: shop.id, appointmentId, now: NOON });

    expect(ok).toBe(false);
    expect(emails.length).toBe(0);
  });
});
