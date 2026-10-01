import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addDays, randomToken } from "@chairback/config";
import { forShop, prisma, type Shop } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { MessageProvider } from "../messaging/provider.js";
import { sweepShop } from "./nudge.js";

/**
 * Nudge sweep: write-ahead ledger, real send via a FAKE provider, per-shop cap,
 * dry-run, and tenant isolation. No live Twilio.
 */

const NOW = new Date("2026-06-01T12:00:00Z");

let sent: { to: string; body: string; from?: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sent.push(input);
    return { sid: `SM${sent.length}`, status: "queued" };
  },
};

let userId: string;
let shop: Shop;

async function makeOverdueClient(
  shopId: string,
  key: string,
  phone: string,
  lastSeenDaysAgo = 60,
) {
  const db = forShop(shopId);
  const client = await db.client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
    create: {
      acuityClientKey: key,
      magicToken: randomToken(),
      firstName: "Over",
      phone,
      smsConsentAt: NOW, // consented, so the consent gate (R7) lets sends through
      smsConsentSource: "barber_attest",
      // overdue: median 30, last visit 60 days ago, buffer 7 -> 60 > 37
      medianIntervalDays: 30,
      lastVisitAt: addDays(NOW, -lastSeenDaysAgo),
    },
    update: {},
  });
  // 2 completed visits so R1 passes.
  for (let i = 0; i < 2; i++) {
    await db.visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: `${key}-v${i}` } },
      create: {
        clientId: client.id,
        acuityAppointmentId: `${key}-v${i}`,
        status: "COMPLETED",
        scheduledAt: addDays(NOW, -lastSeenDaysAgo - i * 30),
      },
      update: {},
    });
  }
  return client;
}

beforeAll(async () => {
  __setMessageProviderForTests(fakeProvider);
  const user = await prisma.user.create({
    data: { email: `nudge-${randomToken(6)}@test.local`, passwordHash: "x", name: "N" },
  });
  userId = user.id;
  shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Nudge Shop",
      bookingUrl: "https://nudge.test",
      webhookSecret: randomToken(),
      dailySendCap: 2,
      nudgeBufferDays: 7,
    },
  });
});

afterEach(async () => {
  sent = [];
  // reset nudges between cases
  await prisma.nudge.deleteMany({ where: { shopId: shop.id } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("sweepShop", () => {
  it("dry-run records SKIPPED and sends nothing", async () => {
    await makeOverdueClient(shop.id, "tel:+13025551001", "+13025551001");
    const summary = await sweepShop(shop, { now: NOW, dryRun: true });
    expect(summary.skipped).toBe(1);
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
    const nudge = await prisma.nudge.findFirst({ where: { shopId: shop.id } });
    expect(nudge?.status).toBe("SKIPPED");
    expect(nudge?.body).toContain("Nudge Shop");
    // 🔴 The STORED body is credential-free: the rewards link the customer
    // receives is struck to [link] at rest (messaging/auditBody.ts) - the
    // Nudge table must never be a corpus of live bearer URLs again.
    expect(nudge?.body).toContain("[link]");
    expect(nudge?.body).not.toContain("/r/");
    expect(nudge?.body).not.toMatch(/https?:\/\//);
  });

  it("real run writes PENDING->SENT and sends via the provider", async () => {
    const summary = await sweepShop(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBe(summary.sent);
    const sentNudges = await prisma.nudge.findMany({
      where: { shopId: shop.id, status: "SENT" },
    });
    expect(sentNudges.length).toBe(summary.sent);
    expect(sentNudges[0]?.messageSid).toMatch(/^SM/);
    // The CUSTOMER still gets the real link - only the stored copy is struck.
    expect(sent[0]!.body).toContain("/r/");
    expect(sentNudges[0]?.body).not.toContain("/r/");
    // No twilioNumber on this shop -> from is undefined (shared platform line).
    expect(sent[0]!.from).toBeUndefined();
  });

  it("a shop that switched to ChairBack booking sends its booking page, not the old link", async () => {
    // Switching never clears the saved outside link; the rebook text must not
    // send the customer back to the system the shop left.
    const switched = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Switched Cuts",
        slug: `nudge-switched-${randomToken(5)}`,
        bookingMode: "native",
        bookingUrl: "https://old-acuity.test/schedule.php",
        webhookSecret: randomToken(),
        dailySendCap: 5,
        nudgeBufferDays: 7,
      },
    });
    try {
      await makeOverdueClient(switched.id, "tel:+13025553001", "+13025553001");
      const summary = await sweepShop(switched, { now: NOW, dryRun: false });
      expect(summary.sent).toBe(1);
      expect(sent[0]!.body).toContain(`/book/${switched.slug}`);
      expect(sent[0]!.body).not.toContain("old-acuity.test");
    } finally {
      await prisma.shop.delete({ where: { id: switched.id } });
    }
  });

  it("a ChairBack-booking shop that never saved a link keeps the one-link text it always sent", async () => {
    // Nothing was wrong with these texts. A second link would lengthen every
    // one this shop sends - the two-link body's "•" is not GSM-7 - so the
    // link rule leaves them exactly as they were (bookingLinks.ts).
    const plain = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Plain Cuts",
        slug: `nudge-plain-${randomToken(5)}`,
        bookingMode: "native",
        bookingUrl: null,
        webhookSecret: randomToken(),
        dailySendCap: 5,
        nudgeBufferDays: 7,
      },
    });
    try {
      await makeOverdueClient(plain.id, "tel:+13025553002", "+13025553002");
      const summary = await sweepShop(plain, { now: NOW, dryRun: false });
      expect(summary.sent).toBe(1);
      expect(sent[0]!.body).toContain("/r/");
      expect(sent[0]!.body).not.toContain("/book/");
      expect(sent[0]!.body).not.toContain("•");
    } finally {
      await prisma.shop.delete({ where: { id: plain.id } });
    }
  });

  it("sends nudges FROM the shop's own number when it has one", async () => {
    const own = "+15550101010";
    const numShop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Own Number Cuts",
        bookingUrl: "https://ownnum.test",
        webhookSecret: randomToken(),
        dailySendCap: 5,
        nudgeBufferDays: 7,
        twilioNumber: own,
      },
    });
    await makeOverdueClient(numShop.id, "tel:+13025552001", "+13025552001");
    const summary = await sweepShop(numShop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(1);
    expect(sent[0]!.from).toBe(own);
    await prisma.shop.delete({ where: { id: numShop.id } });
  });

  it("respects the per-shop daily cap", async () => {
    // Cap is 2; add a 3rd overdue client -> only 2 should send.
    await makeOverdueClient(shop.id, "tel:+13025551002", "+13025551002");
    await makeOverdueClient(shop.id, "tel:+13025551003", "+13025551003");
    const summary = await sweepShop(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(2);
    expect(sent.length).toBe(2);
  });

  it("does NOT count loyalty texts against the daily cap", async () => {
    // Fresh isolated shop so leftover nudges from other cases can't skew the
    // budget math. Cap 1: exactly one marketing send is allowed.
    const capShop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Cap Shop",
        bookingUrl: "https://cap.test",
        webhookSecret: randomToken(),
        dailySendCap: 1,
        nudgeBufferDays: 7,
      },
    });
    // One overdue marketing candidate.
    await makeOverdueClient(capShop.id, "tel:+13025551011", "+13025551011");
    // A transactional loyalty send to a DIFFERENT client, already on the books
    // today. If it counted against the cap of 1, the candidate would be skipped
    // (budget 0). It must not. (On a different client so it can't trip the
    // candidate's own R4 "no nudge in 21d" suppression - we're isolating the
    // cap behavior, not R4.)
    const other = await makeOverdueClient(capShop.id, "tel:+13025551012", "+13025551012");
    await forShop(capShop.id).nudge.create({
      data: {
        clientId: other.id,
        channel: "SMS",
        status: "SENT",
        kind: "loyalty",
        body: "earned a punch",
      },
    });
    const summary = await sweepShop(capShop, { now: NOW, dryRun: false });
    // Cap 1, and `other` already has a SENT (loyalty) row so R4 suppresses it;
    // only the fresh candidate is eligible. It sends because loyalty didn't
    // consume the budget.
    expect(summary.sent).toBe(1);
    expect(sent.length).toBe(1);
  });

  it("excludes a client with no recorded SMS consent (R7)", async () => {
    // Fresh, isolated shop so the assertion is order-independent: the ONLY
    // candidate-shaped client here is one with no consent on file.
    const freshShop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Consent Gate Shop",
        bookingUrl: "https://consent.test",
        webhookSecret: randomToken(),
        nudgeBufferDays: 7,
      },
    });
    const db = forShop(freshShop.id);
    const key = "tel:+13025551099";
    const noConsent = await db.client.upsert({
      where: { shopId_acuityClientKey: { shopId: freshShop.id, acuityClientKey: key } },
      create: {
        acuityClientKey: key,
        magicToken: randomToken(),
        firstName: "NoConsent",
        phone: "+13025551099",
        medianIntervalDays: 30,
        lastVisitAt: addDays(NOW, -60), // overdue
        // smsConsentAt deliberately omitted -> null
      },
      update: {},
    });
    for (let i = 0; i < 2; i++) {
      await db.visit.upsert({
        where: {
          shopId_acuityAppointmentId: {
            shopId: freshShop.id,
            acuityAppointmentId: `${key}-v${i}`,
          },
        },
        create: {
          clientId: noConsent.id,
          acuityAppointmentId: `${key}-v${i}`,
          status: "COMPLETED",
          scheduledAt: addDays(NOW, -60 - i * 30),
        },
        update: {},
      });
    }
    const summary = await sweepShop(freshShop, { now: NOW, dryRun: true });
    // The consentless client is filtered out by the candidate pre-filter, so
    // the sweep considers nobody and sends/skips nothing.
    expect(summary.considered).toBe(0);
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
    const nudgedThisClient = await prisma.nudge.findFirst({
      where: { shopId: freshShop.id, clientId: noConsent.id },
    });
    expect(nudgedThisClient).toBeNull();

    // Sanity: granting consent makes the SAME client a candidate.
    await db.client.update({
      where: { id: noConsent.id },
      data: { smsConsentAt: NOW, smsConsentSource: "barber_attest" },
    });
    const after = await sweepShop(freshShop, { now: NOW, dryRun: true });
    expect(after.considered).toBe(1);
  });

  it("🔴 never nudges a client the shop blocked from booking - \"time to book\" they can't act on", async () => {
    // Isolated shop, one overdue, consented client: the only thing that
    // decides whether they are swept is the block.
    const blockShop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Block Gate Shop",
        bookingUrl: "https://block.test",
        webhookSecret: randomToken(),
        nudgeBufferDays: 7,
      },
    });
    const client = await makeOverdueClient(blockShop.id, "tel:+13025551098", "+13025551098");
    await prisma.client.update({ where: { id: client.id }, data: { bookingBlockedAt: NOW } });

    const summary = await sweepShop(blockShop, { now: NOW, dryRun: true });
    expect(summary.considered).toBe(0);
    expect(await prisma.nudge.count({ where: { shopId: blockShop.id, clientId: client.id } })).toBe(0);

    // Sanity: unblocked, the SAME client is a candidate again.
    await prisma.client.update({ where: { id: client.id }, data: { bookingBlockedAt: null } });
    expect((await sweepShop(blockShop, { now: NOW, dryRun: true })).considered).toBe(1);
  });

  it("sends nothing during TCPA quiet hours (real run)", async () => {
    await makeOverdueClient(shop.id, "tel:+13025551001", "+13025551001");
    // 06:00 UTC = 02:00 America/New_York (EDT) -> deep in quiet hours.
    const quietNow = new Date("2026-06-01T06:00:00Z");
    const summary = await sweepShop(shop, { now: quietNow, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
    // No write-ahead nudge rows either: the shop is skipped before candidates.
    const nudges = await prisma.nudge.count({ where: { shopId: shop.id } });
    expect(nudges).toBe(0);
  });

  it("dry-run preview is exempt from quiet hours (still simulates)", async () => {
    await makeOverdueClient(shop.id, "tel:+13025551001", "+13025551001");
    const quietNow = new Date("2026-06-01T06:00:00Z"); // 02:00 EDT
    const summary = await sweepShop(shop, { now: quietNow, dryRun: true });
    // Unlike a real run (which is skipped wholesale in quiet hours), the dry-run
    // still walks candidates and records them as SKIPPED previews. At least the
    // 1001 client added here is overdue, so the preview is non-empty.
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("suppresses a client already nudged within 21 days", async () => {
    // First real send.
    await sweepShop(shop, { now: NOW, dryRun: false });
    const firstCount = await prisma.nudge.count({ where: { shopId: shop.id, status: "SENT" } });
    expect(firstCount).toBeGreaterThanOrEqual(1);
    sent = [];
    // Same day again -> all suppressed by R4 (PENDING/SENT within 21d).
    const summary = await sweepShop(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
  });
});

describe("🔴 never to a client who already booked (engines/upcomingBooking.ts)", () => {
  async function ownShop() {
    return prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Booked Nudge Shop",
        bookingUrl: "https://nudge.test",
        webhookSecret: randomToken(),
        dailySendCap: 5,
        nudgeBufferDays: 7,
      },
    });
  }

  it("an overdue client with a ChairBack appointment ahead gets no nudge", async () => {
    const own = await ownShop();
    const client = await makeOverdueClient(own.id, "tel:+13025551401", "+13025551401");
    const staff = await prisma.staff.create({ data: { shopId: own.id, name: "Sam" } });
    const service = await prisma.service.create({ data: { shopId: own.id, name: "Cut", durationMin: 30 } });
    await prisma.appointment.create({
      data: {
        shopId: own.id,
        staffId: staff.id,
        serviceId: service.id,
        clientId: client.id,
        firstName: "Over",
        status: "BOOKED",
        startsAt: addDays(NOW, 2),
        endsAt: new Date(addDays(NOW, 2).getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
    });
    const summary = await sweepShop(own, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("an overdue client whose synced visit ahead was RESCHEDULED gets no nudge", async () => {
    const own = await ownShop();
    const client = await makeOverdueClient(own.id, "tel:+13025551402", "+13025551402");
    await prisma.visit.create({
      data: {
        shopId: own.id,
        clientId: client.id,
        acuityAppointmentId: "moved-once",
        status: "RESCHEDULED",
        scheduledAt: addDays(NOW, 4),
      },
    });
    const summary = await sweepShop(own, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
  });

  it("an overdue client with nothing ahead is still nudged (the control)", async () => {
    const own = await ownShop();
    await makeOverdueClient(own.id, "tel:+13025551403", "+13025551403");
    const summary = await sweepShop(own, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(1);
  });
});

// 🔴 A client who stopped coming is win-back's (a switch the shop turns on),
// not a "time for a cut" every 21 days for ever. This is the case a completed
// import of years-old history creates in bulk.
describe("🔴 never to a client who is gone (eligibility.ts, R2's far edge)", () => {
  async function ownShop() {
    return prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Gone Nudge Shop",
        bookingUrl: "https://nudge.test",
        webhookSecret: randomToken(),
        dailySendCap: 5,
        nudgeBufferDays: 7,
      },
    });
  }

  it("a 30-day client last seen two years ago gets no nudge, while one 60 days out does", async () => {
    const own = await ownShop();
    await makeOverdueClient(own.id, "tel:+13025551501", "+13025551501", 730);
    await makeOverdueClient(own.id, "tel:+13025551502", "+13025551502", 60);
    const summary = await sweepShop(own, { now: NOW, dryRun: false });
    expect(summary.considered).toBe(2);
    expect(summary.sent).toBe(1);
    expect(sent.map((s) => s.to)).toEqual(["+13025551502"]);
    // Nothing written for the gone client either - not even a skipped row.
    const rows = await prisma.nudge.findMany({ where: { shopId: own.id }, select: { client: { select: { phone: true } } } });
    expect(rows.map((r) => r.client.phone)).toEqual(["+13025551502"]);
  });
});
