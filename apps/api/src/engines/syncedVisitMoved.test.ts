import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma, type Shop } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { ingestAppointment } from "../ingest.js";
import { ingestSquareBooking } from "../square/ingest.js";
import type { SquareClient } from "../square/client.js";
import type { SquareBooking } from "../square/types.js";
import type { AcuityAppointment } from "../acuity/types.js";
import { runSyncedVisitReminders } from "./syncedVisitReminders.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import type { MessageProvider } from "../messaging/provider.js";

/**
 * 🔴 A SYNCED VISIT MOVED AFTER ITS REMINDER IS REMINDED AGAIN.
 *
 * The synced reminder sweep only picks rows whose reminder stamps are null.
 * Acuity and Square ingest moved `scheduledAt` but never cleared them, so a
 * client whose appointment was moved after the day-before reminder went out
 * heard nothing about the NEW time - while a ChairBack booking moved the same
 * way was reminded (the native reschedule paths clear the stamps).
 *
 * And the other half, which matters as much: the half-hourly resync re-ingests
 * every appointment in its window, so an UNCHANGED time must never re-arm.
 */

/** Noon UTC, today: every time used here sits inside the 08-21 send window. */
const NOW = (() => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d;
})();
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000);

let texts: { to: string; body: string }[] = [];
let emails: SendEmailInput[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    texts.push({ to: input.to, body: input.body });
    return { sid: `SM${texts.length}`, status: "queued" };
  },
};

let ownerId: string;
let shop: Shop;

beforeAll(async () => {
  __setMessageProviderForTests(fakeProvider);
  __setSendEmailForTests(async (input) => {
    emails.push(input);
    return { id: `em-${emails.length}`, status: "sent" as const };
  });
  const user = await prisma.user.create({
    data: { email: `moved-${randomToken(6)}@test.local`, passwordHash: "x", name: "Moved" },
    select: { id: true },
  });
  ownerId = user.id;
  shop = await prisma.shop.create({
    data: {
      name: "Moved Cuts",
      ownerId,
      bookingUrl: "https://moved.test",
      webhookSecret: randomToken(16),
      timezone: "UTC",
      compAccess: true,
    },
  });
  // Live connections: a synced visit whose platform is disconnected is never
  // reminded (syncedVisitTrust.ts), which would pass these tests for the
  // wrong reason.
  await prisma.acuityConnection.create({
    data: { shopId: shop.id, acuityAccountId: `acct-${randomToken(4)}`, accessToken: "enc" },
  });
  await prisma.squareConnection.create({
    data: {
      shopId: shop.id,
      squareMerchantId: `m-${randomToken(4)}`,
      accessToken: "enc",
      refreshToken: "enc",
      tokenExpiresAt: inHours(24 * 20),
    },
  });
});

afterEach(() => {
  texts = [];
  emails = [];
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

const stamps = (shopId: string, sourceId: string) =>
  prisma.visit.findUniqueOrThrow({
    where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: sourceId } },
    select: { status: true, scheduledAt: true, reminderSentAt: true, reminderEmailSentAt: true, clientId: true },
  });

/** Ingest leaves SMS consent alone (Square never grants it); grant it here. */
async function consent(clientId: string) {
  await prisma.client.update({ where: { id: clientId }, data: { smsConsentAt: NOW } });
}

describe("Acuity: a visit moved after its reminder", () => {
  it("🔴 is reminded again for the new time - and an unchanged resync never re-arms it", async () => {
    const id = String(Math.floor(1e9 + Math.random() * 9e8)); // Acuity ids are bare digits
    const phone = `+1302555${Math.floor(1000 + Math.random() * 8999)}`;
    const email = `acu-${randomToken(5)}@example.com`.toLowerCase();
    const appt = (at: Date): AcuityAppointment =>
      ({
        id,
        firstName: "Casey",
        lastName: "Moved",
        email,
        phone,
        datetime: at.toISOString(),
        type: "Skin Fade",
      }) as AcuityAppointment;

    await ingestAppointment(shop, "scheduled", id, appt(inHours(3)));
    await consent((await stamps(shop.id, id)).clientId);

    // The day-before reminder goes out for 3 PM.
    await runSyncedVisitReminders(NOW);
    expect(texts.filter((t) => t.to === phone)).toHaveLength(1);
    expect(emails.filter((e) => e.to === email)).toHaveLength(1);
    const reminded = await stamps(shop.id, id);
    expect(reminded.reminderSentAt).not.toBeNull();
    expect(reminded.reminderEmailSentAt).not.toBeNull();

    // The half-hourly resync re-reads it, unchanged: nothing re-arms.
    await ingestAppointment(shop, "scheduled", id, appt(inHours(3)));
    const unchanged = await stamps(shop.id, id);
    expect(unchanged.reminderSentAt).not.toBeNull();
    expect(unchanged.reminderEmailSentAt).not.toBeNull();
    texts = [];
    emails = [];
    await runSyncedVisitReminders(NOW);
    expect(texts.filter((t) => t.to === phone)).toHaveLength(0);
    expect(emails.filter((e) => e.to === email)).toHaveLength(0);

    // The barber moves it to 5 PM in Acuity (the webhook), and the next
    // resync pass settles it back to SCHEDULED.
    await ingestAppointment(shop, "rescheduled", id, appt(inHours(5)));
    const moved = await stamps(shop.id, id);
    expect(moved.scheduledAt.toISOString()).toBe(inHours(5).toISOString());
    expect(moved.reminderSentAt).toBeNull();
    expect(moved.reminderEmailSentAt).toBeNull();
    await ingestAppointment(shop, "scheduled", id, appt(inHours(5)));

    await runSyncedVisitReminders(NOW);
    expect(texts.filter((t) => t.to === phone)).toHaveLength(1);
    expect(emails.filter((e) => e.to === email)).toHaveLength(1);
    const after = await stamps(shop.id, id);
    expect(after.reminderSentAt).not.toBeNull();
    expect(after.reminderEmailSentAt).not.toBeNull();
  });
});

describe("Acuity, texting switched off (production today)", () => {
  it("🔴 the EMAIL reminder is re-armed and sent again for the new time; nothing is texted", async () => {
    const id = String(Math.floor(1e9 + Math.random() * 9e8));
    const phone = `+1302555${Math.floor(1000 + Math.random() * 8999)}`;
    const email = `acuoff-${randomToken(5)}@example.com`.toLowerCase();
    const appt = (at: Date): AcuityAppointment =>
      ({ id, firstName: "Off", lastName: "Moved", email, phone, datetime: at.toISOString(), type: "Cut" }) as AcuityAppointment;

    process.env.SMS_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      await ingestAppointment(shop, "scheduled", id, appt(inHours(4)));
      await consent((await stamps(shop.id, id)).clientId);
      await runSyncedVisitReminders(NOW);
      expect(emails.filter((e) => e.to === email)).toHaveLength(1);

      await ingestAppointment(shop, "scheduled", id, appt(inHours(7)));
      expect((await stamps(shop.id, id)).reminderEmailSentAt).toBeNull();
      await runSyncedVisitReminders(NOW);
      expect(emails.filter((e) => e.to === email)).toHaveLength(2);
      expect(texts.filter((t) => t.to === phone)).toHaveLength(0);
    } finally {
      process.env.SMS_ENABLED = "true";
      __resetEnvCacheForTests();
    }
  });
});

describe("Square: a booking moved after its reminder", () => {
  it("🔴 is reminded again for the new time - and an unchanged resync never re-arms it", async () => {
    const bookingId = `bk_${randomToken(6)}`;
    const sourceId = `square:${bookingId}`;
    const phone = `+1302555${Math.floor(1000 + Math.random() * 8999)}`;
    const email = `sq-${randomToken(5)}@example.com`.toLowerCase();
    // A fake authed client: the booking is passed prefetched, so only the
    // customer lookup reaches it. No network.
    const client = {
      getCustomer: async () => ({
        id: "cust_moved",
        given_name: "Sam",
        family_name: "Moved",
        phone_number: phone,
        email_address: email,
      }),
    } as unknown as SquareClient;
    const booking = (at: Date): SquareBooking => ({
      id: bookingId,
      status: "ACCEPTED",
      start_at: at.toISOString(),
      location_id: "loc_1",
      customer_id: "cust_moved",
      appointment_segments: [{ duration_minutes: 30 }],
    });

    await ingestSquareBooking(shop, bookingId, booking(inHours(2)), { client });
    await consent((await stamps(shop.id, sourceId)).clientId);

    await runSyncedVisitReminders(NOW);
    expect(texts.filter((t) => t.to === phone)).toHaveLength(1);
    expect(emails.filter((e) => e.to === email)).toHaveLength(1);

    // Re-read unchanged by the resync: still reminded, nothing re-sent.
    await ingestSquareBooking(shop, bookingId, booking(inHours(2)), { client });
    texts = [];
    emails = [];
    await runSyncedVisitReminders(NOW);
    expect(texts.filter((t) => t.to === phone)).toHaveLength(0);
    expect(emails.filter((e) => e.to === email)).toHaveLength(0);

    // Moved to later in Square.
    await ingestSquareBooking(shop, bookingId, booking(inHours(6)), { client });
    const moved = await stamps(shop.id, sourceId);
    expect(moved.status).toBe("SCHEDULED");
    expect(moved.reminderSentAt).toBeNull();
    expect(moved.reminderEmailSentAt).toBeNull();

    await runSyncedVisitReminders(NOW);
    expect(texts.filter((t) => t.to === phone)).toHaveLength(1);
    expect(emails.filter((e) => e.to === email)).toHaveLength(1);
  });
});
