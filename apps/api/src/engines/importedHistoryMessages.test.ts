import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { ingestAppointment } from "../ingest.js";
import { promoteCompletedVisits } from "./statusPromotion.js";
import { runSyncedVisitReminders } from "./syncedVisitReminders.js";
import { runRebookNudges } from "./rebookNudges.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { __setPushSenderForTests, type PushPayload } from "../messaging/push.js";
import type { AcuityAppointment } from "../acuity/types.js";
import { ingestSquareBooking } from "../square/ingest.js";
import type { SquareClient } from "../square/client.js";
import type { SquareBooking, SquareCustomer } from "../square/types.js";

/**
 * WHAT IMPORTING HISTORY - AND DISCONNECTING - MAY SEND CUSTOMERS.
 *
 * On main (120eadeb) this file first pinned what actually went out: every
 * imported past visit, however old, announced its punch (one push or text per
 * cut); a cut imported 90 minutes after it ended got "book your next one"; and
 * after the shop disconnected Acuity, an appointment ChairBack could no longer
 * check was still reminded by text and email, then completed, punched and
 * announced. Those counts are now the opposite on purpose:
 *
 *   - imported history is never announced, whenever it ended - it keeps its
 *     punches (nothing is taken away), it just sends nothing;
 *   - a synced visit whose platform is disconnected is neither reminded nor
 *     completed; reconnecting settles it without announcing anything stale;
 *   - a live visit - one ChairBack knew about before it ended - still announces
 *     its punch exactly as before, and a real upcoming appointment is still
 *     reminded.
 *
 * One Acuity-connected shop with rewards and loyalty messages on, history
 * arriving through the REAL ingest path (what the connect-time backfill runs),
 * then every scheduled job that reads it.
 */
let sms: SendMessageInput[] = [];
let emails: SendEmailInput[] = [];
let pushes: { endpoint: string; payload: PushPayload }[] = [];
const ENDPOINT = `https://push.test/hist-${randomToken(8)}`;
const mineSms = (to: string) => sms.filter((m) => m.to === to).length;
const mineEmails = (to: string) => emails.filter((m) => m.to === to).length;
const minePushes = () => pushes.filter((p) => p.endpoint === ENDPOINT).length;
const reset = () => {
  sms = [];
  emails = [];
  pushes = [];
};

let userId = "";
let shopId = "";
const PHONE = "+13025557001";
const EMAIL = "hist.customer@example.invalid";

/** A zone where it is mid-day NOW, so quiet hours never decide a result. */
function daytimeZone(now: Date): string {
  for (const tz of ["America/New_York", "Europe/London", "Asia/Tokyo", "Asia/Kolkata", "Pacific/Honolulu", "Australia/Sydney"]) {
    const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
    if (h >= 11 && h <= 17) return tz;
  }
  return "America/New_York";
}

const NOW = new Date();
const H = 3_600_000;

function appt(id: number, startOffsetMs: number, over: Partial<AcuityAppointment> = {}): AcuityAppointment {
  const start = new Date(NOW.getTime() + startOffsetMs);
  return {
    id: String(id),
    firstName: "Hist",
    lastName: "Customer",
    phone: PHONE,
    email: EMAIL,
    datetime: start.toISOString(),
    endTime: new Date(start.getTime() + 30 * 60_000).toISOString(),
    price: "40.00",
    type: "Cut",
    canceled: false,
    noShow: false,
    duration: 30,
    ...over,
  };
}

async function ingest(a: AcuityAppointment) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  await ingestAppointment(shop, "scheduled", a.id, a);
}

beforeAll(async () => {
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sms.push(input);
      return { sid: `SM-hist-${sms.length}`, status: "queued" };
    },
  });
  __setSendEmailForTests(async (input) => {
    emails.push(input);
    return { id: `em-${emails.length}`, status: "sent" as const };
  });
  __setPushSenderForTests({
    send: async (sub, payload) => {
      pushes.push({ endpoint: (sub as { endpoint: string }).endpoint, payload: JSON.parse(payload) as PushPayload });
    },
  });
  const user = await prisma.user.create({
    data: { email: `hist-${randomToken(6)}@test.chairback`, name: "H" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "History Cuts",
      slug: `hist-${randomToken(5)}`,
      webhookSecret: randomToken(),
      timezone: daytimeZone(NOW),
      bookingMode: "acuity",
      bookingUrl: "https://hist.as.me/schedule.php",
      compAccess: true,
      rewardsEnabled: true,
      loyaltyTextsEnabled: true,
    },
  });
  shopId = shop.id;
  await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: "hist-acct", accessToken: "hist-not-a-token" },
  });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setSendEmailForTests(undefined);
  __setPushSenderForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("importing a consented app customer's history", () => {
  it("announces nothing about the past, and still reminds the real upcoming appointment", async () => {
    // History, as the connect-time backfill writes it: three old cuts, one that
    // ended 90 minutes ago, one tomorrow, one next week.
    for (const [id, offset] of [
      [7101, -400 * 24 * H],
      [7102, -90 * 24 * H],
      [7103, -2 * 24 * H],
      [7104, -1.5 * H],
      [7105, 20 * H],
      [7106, 5 * 24 * H],
    ] as const) {
      await ingest(appt(id, offset));
    }
    // The customer had already opted in to texts and installed the app.
    const client = await prisma.client.findUniqueOrThrow({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey: `tel:${PHONE}` } },
    });
    await prisma.client.update({
      where: { id: client.id },
      data: { smsConsentAt: new Date(NOW.getTime() - 30 * 24 * H), smsConsentSource: "join_page" },
    });
    await prisma.pushSubscription.create({
      data: { shopId, clientId: client.id, kind: "web", endpoint: ENDPOINT, p256dh: "k", auth: "a" },
    });
    reset();

    // 1. The completion job: every past visit is completed and keeps its punch -
    //    and not one of them is announced (main sent 4 pushes here).
    await promoteCompletedVisits(NOW);
    const promoted = await prisma.visit.count({ where: { shopId, clientId: client.id, status: "COMPLETED" } });
    const punches = await prisma.punchLedger.count({ where: { shopId, clientId: client.id, punchesEarned: { gt: 0 } } });
    expect(promoted).toBe(4);
    expect(punches).toBe(4);
    expect({ sms: mineSms(PHONE), pushes: minePushes(), emails: mineEmails(EMAIL) }).toEqual({
      sms: 0,
      pushes: 0,
      emails: 0,
    });
    reset();

    // 2. Tomorrow's appointment is real and upcoming: still reminded, text + email.
    await runSyncedVisitReminders(NOW);
    expect({ sms: mineSms(PHONE), pushes: minePushes(), emails: mineEmails(EMAIL) }).toEqual({
      sms: 1,
      pushes: 0,
      emails: 1,
    });
    reset();

    // 3. The cut that ended 90 minutes before it was imported: no "book your
    //    next one" (main sent it) - imported, however recently it ended.
    await runRebookNudges(NOW);
    expect(minePushes()).toBe(0);
  });
});

describe("a live visit is still announced", () => {
  it("one ChairBack knew about before it ended earns and announces its punch", async () => {
    const phone = "+13025557003";
    // Booked ahead, so ChairBack learns of it before it happens.
    const live = appt(7301, 0.5 * H, { phone, email: "live.visit@example.invalid" });
    await ingest(live);
    const client = await prisma.client.findUniqueOrThrow({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey: `tel:${phone}` } },
    });
    await prisma.client.update({
      where: { id: client.id },
      data: { smsConsentAt: new Date(NOW.getTime() - 30 * 24 * H), smsConsentSource: "join_page" },
    });
    reset();
    // The job's next pass after the cut ends.
    await promoteCompletedVisits(new Date(NOW.getTime() + 2 * H));
    expect(mineSms(phone)).toBe(1);
  });

  it("but not when it is only completed long after it ended", async () => {
    const phone = "+13025557004";
    const late = appt(7401, 0.5 * H, { phone, email: "late.visit@example.invalid" });
    await ingest(late);
    const client = await prisma.client.findUniqueOrThrow({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey: `tel:${phone}` } },
    });
    await prisma.client.update({
      where: { id: client.id },
      data: { smsConsentAt: new Date(NOW.getTime() - 30 * 24 * H), smsConsentSource: "join_page" },
    });
    reset();
    // Completed two days after the cut (a stalled job): punched, not announced.
    await promoteCompletedVisits(new Date(NOW.getTime() + 49 * H));
    expect(await prisma.punchLedger.count({ where: { shopId, clientId: client.id, punchesEarned: { gt: 0 } } })).toBe(1);
    expect(mineSms(phone)).toBe(0);
  });
});

describe("after the shop disconnects Acuity", () => {
  it("a visit ChairBack can no longer check is neither reminded nor completed", async () => {
    const phone = "+13025557002";
    const soon = appt(7201, 22 * H, { phone, email: "after.disconnect@example.invalid" });
    await ingest(soon);
    const client = await prisma.client.findUniqueOrThrow({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey: `tel:${phone}` } },
    });
    await prisma.client.update({
      where: { id: client.id },
      data: { smsConsentAt: new Date(NOW.getTime() - 30 * 24 * H), smsConsentSource: "join_page" },
    });
    // Disconnect. Anything that now happens to this appointment in Acuity -
    // including its cancellation - never reaches ChairBack again.
    await prisma.acuityConnection.deleteMany({ where: { shopId } });
    reset();

    // No reminder (main sent a text and an email).
    await runSyncedVisitReminders(NOW);
    expect({ sms: mineSms(phone), emails: mineEmails("after.disconnect@example.invalid") }).toEqual({
      sms: 0,
      emails: 0,
    });

    // Its time passes: left as last synced - not completed, not punched (main
    // completed it, punched it and texted the customer).
    await promoteCompletedVisits(new Date(NOW.getTime() + 24 * H));
    const visit = await prisma.visit.findFirstOrThrow({ where: { shopId, acuityAppointmentId: soon.id } });
    expect(visit.status).toBe("SCHEDULED");
    expect(await prisma.punchLedger.count({ where: { shopId, clientId: client.id } })).toBe(0);
    expect(mineSms(phone)).toBe(0);

    // The shop reconnects days later: the visit is settled, and nothing stale
    // is announced about it.
    await prisma.acuityConnection.create({
      data: { shopId, acuityAccountId: "hist-acct", accessToken: "hist-not-a-token" },
    });
    await promoteCompletedVisits(new Date(NOW.getTime() + 72 * H));
    const settled = await prisma.visit.findFirstOrThrow({ where: { shopId, acuityAppointmentId: soon.id } });
    expect(settled.status).toBe("COMPLETED");
    expect(await prisma.punchLedger.count({ where: { shopId, clientId: client.id, punchesEarned: { gt: 0 } } })).toBe(1);
    expect(mineSms(phone)).toBe(0);
  });
});

/** A Square booking already in hand - the shape the resync sweep passes in. */
function squareBooking(id: string, startOffsetMs: number, customerId: string): SquareBooking {
  return {
    id,
    status: "ACCEPTED",
    start_at: new Date(NOW.getTime() + startOffsetMs).toISOString(),
    location_id: "hist-loc",
    customer_id: customerId,
    appointment_segments: [{ duration_minutes: 30 }],
  };
}

/** Sweep-style deps, so ingest never calls Square: the customer is cached. */
function squareDeps(customer: SquareCustomer) {
  const client: SquareClient = {
    getBooking: async () => {
      throw new Error("the sweep passes the booking in");
    },
    listBookings: async () => ({ bookings: [], cursor: null }),
    getCustomer: async () => customer,
  };
  return { client, customers: new Map([[customer.id, customer]]) };
}

async function consentByPhone(forShop: string, phone: string) {
  const client = await prisma.client.findUniqueOrThrow({
    where: { shopId_acuityClientKey: { shopId: forShop, acuityClientKey: `tel:${phone}` } },
  });
  await prisma.client.update({
    where: { id: client.id },
    data: { smsConsentAt: new Date(NOW.getTime() - 30 * 24 * H), smsConsentSource: "join_page" },
  });
  return client;
}

async function syncedShop(name: string, rewardsEnabled: boolean) {
  return prisma.shop.create({
    data: {
      ownerId: userId,
      name,
      slug: `hist-${randomToken(5)}`,
      webhookSecret: randomToken(),
      timezone: daytimeZone(NOW),
      bookingMode: "square",
      bookingUrl: "https://hist.square.site",
      compAccess: true,
      rewardsEnabled,
      loyaltyTextsEnabled: true,
    },
  });
}

describe("turning rewards on after the history is in", () => {
  it("the next resync awards past visits their punches - and announces none of them", async () => {
    // Connected with rewards OFF: the history is completed but earns nothing.
    const shop = await syncedShop("Rewards Later Cuts", false);
    await prisma.acuityConnection.create({
      data: { shopId: shop.id, acuityAccountId: "hist-acct-2", accessToken: "hist-not-a-token" },
    });
    await prisma.squareConnection.create({
      data: {
        shopId: shop.id,
        squareMerchantId: `hist-merchant-${randomToken(4)}`,
        accessToken: "hist-not-a-token",
        refreshToken: "hist-not-a-token",
        tokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * H),
      },
    });
    const acuityPhone = "+13025557005";
    const squarePhone = "+13025557006";
    const customer: SquareCustomer = {
      id: "hist-sq-cust",
      given_name: "Sq",
      family_name: "Customer",
      phone_number: squarePhone,
      email_address: "hist.square@example.invalid",
    };
    const past = appt(7501, -10 * 24 * H, { phone: acuityPhone, email: "hist.later@example.invalid" });
    const pastSquare = squareBooking("hist-bk-1", -10 * 24 * H, customer.id);
    const resync = async () => {
      const fresh = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
      await ingestAppointment(fresh, "scheduled", past.id, past);
      await ingestSquareBooking(fresh, pastSquare.id, pastSquare, squareDeps(customer));
    };
    await resync();
    const clients = [await consentByPhone(shop.id, acuityPhone), await consentByPhone(shop.id, squarePhone)];
    const endpoints = clients.map((c) => `https://push.test/hist-later-${c.id}`);
    for (const [i, c] of clients.entries()) {
      await prisma.pushSubscription.create({
        data: { shopId: shop.id, clientId: c.id, kind: "web", endpoint: endpoints[i]!, p256dh: "k", auth: "a" },
      });
    }
    await promoteCompletedVisits(NOW);
    const earned = () =>
      prisma.punchLedger.count({ where: { shopId: shop.id, punchesEarned: { gt: 0 } } });
    expect(await prisma.visit.count({ where: { shopId: shop.id, status: "COMPLETED" } })).toBe(2);
    expect(await earned()).toBe(0);

    // The owner turns rewards on; the half-hourly resync meets both again.
    await prisma.shop.update({ where: { id: shop.id }, data: { rewardsEnabled: true } });
    reset();
    await resync();

    // Both punches land (nothing is withheld), and nobody hears about a cut
    // from ten days ago (main announced each one by push).
    expect(await earned()).toBe(2);
    expect({
      sms: mineSms(acuityPhone) + mineSms(squarePhone),
      pushes: pushes.filter((p) => endpoints.includes(p.endpoint)).length,
    }).toEqual({ sms: 0, pushes: 0 });
  });
});

describe("after a seller revokes ChairBack from inside Square", () => {
  it("a Square visit ChairBack can no longer check is neither reminded nor completed", async () => {
    const shop = await syncedShop("Revoked Cuts", true);
    const connection = await prisma.squareConnection.create({
      data: {
        shopId: shop.id,
        squareMerchantId: `hist-merchant-${randomToken(4)}`,
        accessToken: "hist-not-a-token",
        refreshToken: "hist-not-a-token",
        tokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * H),
      },
    });
    const phone = "+13025557007";
    const email = "hist.revoked@example.invalid";
    const customer: SquareCustomer = { id: "hist-sq-rev", given_name: "Rev", phone_number: phone, email_address: email };
    const soon = squareBooking("hist-bk-2", 22 * H, customer.id);
    await ingestSquareBooking(shop, soon.id, soon, squareDeps(customer));
    const client = await consentByPhone(shop.id, phone);
    // oauth.authorization.revoked: the row stays, marked; Square tells us nothing more.
    await prisma.squareConnection.update({ where: { id: connection.id }, data: { revokedAt: NOW } });
    reset();

    await runSyncedVisitReminders(NOW);
    expect({ sms: mineSms(phone), emails: mineEmails(email) }).toEqual({ sms: 0, emails: 0 });

    await promoteCompletedVisits(new Date(NOW.getTime() + 24 * H));
    const visit = await prisma.visit.findFirstOrThrow({
      where: { shopId: shop.id, acuityAppointmentId: `square:${soon.id}` },
    });
    expect(visit.status).toBe("SCHEDULED");
    expect(await prisma.punchLedger.count({ where: { shopId: shop.id, clientId: client.id } })).toBe(0);
    expect(mineSms(phone)).toBe(0);
  });
});
