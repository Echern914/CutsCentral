import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { forShop, prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests, type PushSender } from "../messaging/push.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import type { MessageProvider } from "../messaging/provider.js";
import { notifySlotOpened } from "./slotOpened.js";

/**
 * "A slot just opened" auto-notify. The barber is ALWAYS alerted when the
 * waitlist is on (their own number/device); waitlisted CUSTOMERS are nudged only
 * when the per-shop slotOpenedTextsEnabled toggle is on. Uses a fake SMS provider,
 * fake push sender, and injected email sender.
 *
 * Availability: the shop has staff with weekly hours covering the freed slot's
 * time (Mon–Sun 00:00–23:59), so isSlotBookable returns true for any future slot.
 */

const NOON = new Date("2026-06-01T16:00:00Z"); // a Monday, 12:00 EDT

let sms: { to: string; body: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sms.push(input);
    return { sid: `SM${sms.length}`, status: "queued" };
  },
};

// Push transport isn't asserted here (covered by barberPush/loyaltyNotify); the
// fake just keeps sends offline. payload is the serialized JSON body (a string).
const fakePush: PushSender = {
  async send() {
    /* no-op */
  },
};

let emails: SendEmailInput[] = [];

let userId: string;

// This suite exercises the real SEND path (barber SMS + customer email), which
// the engine gates on DRY_RUN. Run with DRY_RUN off so sends reach the injected
// fakes instead of the dry-run log. Restored in afterAll.
const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

async function makeShop(opts: {
  waitlistEnabled?: boolean;
  slotOpenedTextsEnabled?: boolean;
  notifyPhone?: string | null;
  bookingMode?: "link" | "acuity" | "native" | "square";
}): Promise<{ id: string; ownerId: string; slug: string | null }> {
  return prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Slot Cuts",
      slug: `slot-${randomToken(5)}`,
      bookingMode: opts.bookingMode ?? "native",
      webhookSecret: randomToken(),
      compAccess: true,
      waitlistEnabled: opts.waitlistEnabled ?? true,
      slotOpenedTextsEnabled: opts.slotOpenedTextsEnabled ?? false,
      notifyPhone: opts.notifyPhone === undefined ? "+13025550111" : opts.notifyPhone,
    },
    select: { id: true, ownerId: true, slug: true },
  });
}

/** Staff + service + a canceled appointment 2 days out. Returns ids. */
async function makeCanceledAppointment(
  shopId: string,
): Promise<{ appointmentId: string; staffId: string; serviceId: string }> {
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Haircut", durationMin: 30 },
  });
  // Full-week availability so the freed slot passes isSlotBookable.
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId: staff.id, weekday, startMin: 0, endMin: 1439 },
    });
  }
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: service.id, staffId: staff.id },
  });
  const startsAt = new Date(NOON.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days out
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.id,
      serviceId: service.id,
      firstName: "Gone",
      status: "CANCELED",
      canceledAt: NOON,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return { appointmentId: appt.id, staffId: staff.id, serviceId: service.id };
}

async function addWaitlister(
  shopId: string,
  opts: { serviceId?: string | null; staffId?: string | null; email?: string | null } = {},
): Promise<string> {
  const entry = await prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: "Wanda",
      phone: `+1302555${Math.floor(1000 + Math.random() * 8999)}`,
      email: opts.email === undefined ? "wanda@example.com" : opts.email,
      serviceId: opts.serviceId ?? null,
      staffId: opts.staffId ?? null,
      status: "WAITING",
    },
    select: { id: true },
  });
  return entry.id;
}

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests(fakePush);
  __setSendEmailForTests(async (input) => {
    emails.push(input);
    return { id: `em${emails.length}`, status: "sent" };
  });
  const user = await prisma.user.create({
    data: { email: `slot-${randomToken(6)}@test.local`, passwordHash: "x", name: "S" },
  });
  userId = user.id;
});

afterEach(async () => {
  sms = [];
  emails = [];
  await prisma.nudge.deleteMany({ where: { shop: { ownerId: userId } } });
  await prisma.pushSubscription.deleteMany({ where: { shop: { ownerId: userId } } });
  await prisma.waitlistEntry.deleteMany({ where: { shop: { ownerId: userId } } });
  await prisma.appointment.deleteMany({ where: { shop: { ownerId: userId } } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  __setSendEmailForTests(undefined);
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("notifySlotOpened — barber alert", () => {
  it("texts the barber, counting matching waitlisters", async () => {
    const shop = await makeShop({ slotOpenedTextsEnabled: false });
    const { appointmentId, serviceId } = await makeCanceledAppointment(shop.id);
    await addWaitlister(shop.id, { serviceId }); // 1 matcher

    await notifySlotOpened({ shopId: shop.id, appointmentId, now: NOON });

    // Barber alert fired (the push transport itself is covered by barberPush /
    // loyaltyNotify tests; here we assert the SMS leg content).
    expect(sms.length).toBe(1);
    expect(sms[0]!.to).toBe("+13025550111");
    expect(sms[0]!.body).toContain("slot just opened");
    expect(sms[0]!.body).toContain("1 person");
    // Customer toggle OFF → no customer email.
    expect(emails.length).toBe(0);
  });

  it("still alerts the barber with zero waitlisters", async () => {
    const shop = await makeShop({ slotOpenedTextsEnabled: false });
    const { appointmentId } = await makeCanceledAppointment(shop.id);

    await notifySlotOpened({ shopId: shop.id, appointmentId, now: NOON });

    expect(sms.length).toBe(1);
    expect(sms[0]!.body).toContain("0 people");
  });

  it("does nothing when the waitlist is disabled", async () => {
    const shop = await makeShop({ waitlistEnabled: false });
    const { appointmentId, serviceId } = await makeCanceledAppointment(shop.id);
    await addWaitlister(shop.id, { serviceId });

    await notifySlotOpened({ shopId: shop.id, appointmentId, now: NOON });

    expect(sms.length).toBe(0);
    expect(emails.length).toBe(0);
  });

  it("does nothing for a non-native shop", async () => {
    const shop = await makeShop({ bookingMode: "acuity" });
    const { appointmentId } = await makeCanceledAppointment(shop.id);

    await notifySlotOpened({ shopId: shop.id, appointmentId, now: NOON });

    expect(sms.length).toBe(0);
  });
});

describe("notifySlotOpened — customer nudge (toggle on)", () => {
  it("emails a matching waitlister and stamps notifiedAt", async () => {
    const shop = await makeShop({ slotOpenedTextsEnabled: true });
    const { appointmentId, serviceId } = await makeCanceledAppointment(shop.id);
    const entryId = await addWaitlister(shop.id, { serviceId });

    await notifySlotOpened({ shopId: shop.id, appointmentId, now: NOON });

    expect(emails.length).toBe(1);
    expect(emails[0]!.to).toBe("wanda@example.com");
    expect(emails[0]!.subject).toContain("Slot Cuts");
    const entry = await prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: { notifiedAt: true },
    });
    expect(entry?.notifiedAt).not.toBeNull();
  });

  it("matches a standing (any-service, any-provider) waitlister", async () => {
    const shop = await makeShop({ slotOpenedTextsEnabled: true });
    const { appointmentId } = await makeCanceledAppointment(shop.id);
    await addWaitlister(shop.id, { serviceId: null, staffId: null });

    await notifySlotOpened({ shopId: shop.id, appointmentId, now: NOON });

    expect(emails.length).toBe(1);
  });

  it("does NOT re-notify a waitlister within the suppression window", async () => {
    const shop = await makeShop({ slotOpenedTextsEnabled: true });
    const { appointmentId, serviceId } = await makeCanceledAppointment(shop.id);
    const entryId = await addWaitlister(shop.id, { serviceId });
    // Already notified 1h ago (inside the 6h suppression window).
    await forShop(shop.id).waitlistEntry.update({
      where: { id: entryId },
      data: { notifiedAt: new Date(NOON.getTime() - 60 * 60 * 1000) },
    });

    await notifySlotOpened({ shopId: shop.id, appointmentId, now: NOON });

    expect(emails.length).toBe(0); // suppressed
  });

  it("skips a waitlister that doesn't match the freed service", async () => {
    const shop = await makeShop({ slotOpenedTextsEnabled: true });
    const { appointmentId } = await makeCanceledAppointment(shop.id);
    // A DIFFERENT, specific service id that isn't the freed one and isn't null.
    await addWaitlister(shop.id, { serviceId: "some-other-service-id" });

    await notifySlotOpened({ shopId: shop.id, appointmentId, now: NOON });

    expect(emails.length).toBe(0);
  });
});
