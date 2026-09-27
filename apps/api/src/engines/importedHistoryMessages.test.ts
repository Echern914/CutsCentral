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

/**
 * WHAT IMPORTING HISTORY - AND DISCONNECTING - SENDS CUSTOMERS TODAY.
 *
 * A CHARACTERIZATION, NOT A SPEC: every count below is pinned exactly as the
 * code behaves on main, so the fix that follows can flip them one at a time
 * and the report can say precisely what changed. Nothing here is approved
 * behaviour.
 *
 * One consented customer with the app, one Acuity-connected shop with rewards
 * and loyalty messages on, history arriving through the REAL ingest path (what
 * the connect-time backfill runs), then every scheduled job that reads it.
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
  it("TODAY: pins every message the jobs send once history lands", async () => {
    // History, as the connect-time backfill writes it: three old cuts, one that
    // ended an hour ago, one tomorrow, one next week.
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

    // 1. The 15-minute promotion job: every past visit becomes COMPLETED.
    // The job runs across every shop; count only this one.
    await promoteCompletedVisits(NOW);
    const promoted = await prisma.visit.count({ where: { shopId, clientId: client.id, status: "COMPLETED" } });
    const punches = await prisma.punchLedger.count({ where: { shopId, clientId: client.id, punchesEarned: { gt: 0 } } });
    const afterPromotion = { promoted, punches, sms: mineSms(PHONE), pushes: minePushes(), emails: mineEmails(EMAIL) };
    reset();

    // 2. The synced-visit reminder job.
    await runSyncedVisitReminders(NOW);
    const afterReminders = { sms: mineSms(PHONE), pushes: minePushes(), emails: mineEmails(EMAIL) };
    reset();

    // 3. The post-visit "book your next one" push.
    await runRebookNudges(NOW);
    const afterRebook = { sms: mineSms(PHONE), pushes: minePushes(), emails: mineEmails(EMAIL) };

    console.log("history ->", JSON.stringify({ afterPromotion, afterReminders, afterRebook }));
    // Pinned from the run on main (120eadeb); a fix changes these on purpose.
    // Every past visit - the 400-day-old one included - is completed, earns a
    // punch and announces it: push first (this customer has the app), a text
    // instead when there is no app and they consented. Four old cuts = four
    // "you earned a punch" messages in one sweep.
    expect(afterPromotion.promoted).toBe(4);
    expect(afterPromotion.punches).toBe(4);
    expect(afterPromotion).toMatchObject({ sms: 0, pushes: 4, emails: 0 });
    // Tomorrow's appointment is reminded by text and email - a real booking,
    // so this one is operational, not retrospective.
    expect(afterReminders).toMatchObject({ sms: 1, pushes: 0, emails: 1 });
    // The cut that ended 90 minutes before the import gets "book your next
    // one" - although tomorrow's Acuity appointment is already booked (the
    // check reads ChairBack appointments only).
    expect(afterRebook).toMatchObject({ sms: 0, pushes: 1, emails: 0 });
  });
});

describe("after the shop disconnects Acuity", () => {
  it("TODAY: a visit ChairBack can no longer verify is still reminded, then completed and punched", async () => {
    const soon = appt(7201, 22 * H, { phone: "+13025557002", email: "after.disconnect@example.invalid" });
    await ingest(soon);
    const client = await prisma.client.findUniqueOrThrow({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey: "tel:+13025557002" } },
    });
    await prisma.client.update({
      where: { id: client.id },
      data: { smsConsentAt: new Date(NOW.getTime() - 30 * 24 * H), smsConsentSource: "join_page" },
    });
    // Disconnect. Anything that now happens to this appointment in Acuity -
    // including its cancellation - never reaches ChairBack again.
    await prisma.acuityConnection.deleteMany({ where: { shopId } });
    reset();

    await runSyncedVisitReminders(NOW);
    const reminded = { sms: mineSms("+13025557002"), emails: mineEmails("after.disconnect@example.invalid") };
    reset();

    // The next day, after its end time: the promotion job completes it and
    // earns a punch - for an appointment that may never have happened.
    const nextDay = new Date(NOW.getTime() + 24 * H);
    await promoteCompletedVisits(nextDay);
    const visit = await prisma.visit.findFirstOrThrow({ where: { shopId, acuityAppointmentId: soon.id } });
    const punched = await prisma.punchLedger.count({ where: { shopId, clientId: client.id, punchesEarned: { gt: 0 } } });

    console.log("disconnect ->", JSON.stringify({ reminded, status: visit.status, punched, sms: mineSms("+13025557002") }));
    // Reminded by text and email although nothing can confirm it still exists...
    expect(reminded).toMatchObject({ sms: 1, emails: 1 });
    // ...then completed, punched and announced by text (no app on this one).
    expect(visit.status).toBe("COMPLETED");
    expect(punched).toBe(1);
    expect(mineSms("+13025557002")).toBe(1);
  });
});
