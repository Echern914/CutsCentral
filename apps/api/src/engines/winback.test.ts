import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addDays, randomToken } from "@chairback/config";
import { forShop, prisma, type Shop } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setExpoSenderForTests } from "../messaging/push.js";
import type { MessageProvider } from "../messaging/provider.js";
import { WINBACK_SEND_LOCAL_HOUR, sweepShopWinback, runWinbackSweep } from "./winback.js";

/**
 * Win-back sweep: opt-in gate, the DEEPER overdue bar (a merely-overdue client is
 * NOT a win-back), write-ahead kind="winback" ledger, dry-run, and the 90-day
 * win-back suppression. Real sends go through a FAKE provider. No live Twilio.
 */

const NOW = new Date("2026-06-01T12:00:00Z");

let sent: { to: string; body: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sent.push(input);
    return { sid: `SM${sent.length}`, status: "queued" };
  },
};

let userId: string;

/**
 * A fresh, isolated shop per test case. The win-back sweep is stateful across
 * the candidate set (lapsed clients accumulate), so sharing one shop would let
 * clients from earlier cases inflate later sweeps. Each case gets its own shop.
 */
async function makeShop(overrides: Record<string, unknown> = {}): Promise<Shop> {
  return prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Winback Shop",
      bookingUrl: "https://winback.test",
      webhookSecret: randomToken(),
      dailySendCap: 5,
      nudgeBufferDays: 7,
      winbackTextsEnabled: true,
      ...overrides,
    },
  });
}

/**
 * A client lapsed by `daysAgo` since last visit, with 2 completed visits and SMS
 * consent. median 30; deeply lapsed (win-back) needs daysAgo > 90.
 */
async function makeLapsedClient(
  shopId: string,
  key: string,
  phone: string,
  daysAgo: number,
) {
  const db = forShop(shopId);
  const client = await db.client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
    create: {
      acuityClientKey: key,
      magicToken: randomToken(),
      firstName: "Lapsed",
      phone,
      smsConsentAt: NOW,
      smsConsentSource: "barber_attest",
      medianIntervalDays: 30,
      lastVisitAt: addDays(NOW, -daysAgo),
    },
    update: {},
  });
  for (let i = 0; i < 2; i++) {
    await db.visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: `${key}-v${i}` } },
      create: {
        clientId: client.id,
        acuityAppointmentId: `${key}-v${i}`,
        status: "COMPLETED",
        scheduledAt: addDays(NOW, -daysAgo - i * 30),
      },
      update: {},
    });
  }
  return client;
}

beforeAll(async () => {
  __setMessageProviderForTests(fakeProvider);
  const user = await prisma.user.create({
    data: { email: `winback-${randomToken(6)}@test.local`, passwordHash: "x", name: "W" },
  });
  userId = user.id;
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("sweepShopWinback", () => {
  it("a deeply-lapsed client gets a kind=winback send (real run)", async () => {
    const shop = await makeShop();
    await makeLapsedClient(shop.id, "tel:+13025552001", "+13025552001", 120); // > 90
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(1);
    expect(sent.length).toBe(1);
    const nudge = await prisma.nudge.findFirst({ where: { shopId: shop.id, status: "SENT" } });
    expect(nudge?.kind).toBe("winback");
    expect(nudge?.body).toContain("Winback Shop");
    expect(nudge?.body).toContain("missed you");
  });

  it("a shop that switched to ChairBack booking sends its booking page, not the old link", async () => {
    // Switching never clears the saved outside link; the text must not use it.
    const shop = await makeShop({
      bookingMode: "native",
      slug: `wb-switched-${randomToken(5)}`,
      bookingUrl: "https://old-acuity.test/schedule.php",
    });
    await makeLapsedClient(shop.id, "tel:+13025552091", "+13025552091", 120);
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(1);
    expect(sent[0]!.body).toContain(`/book/${shop.slug}`);
    expect(sent[0]!.body).not.toContain("old-acuity.test");
  });

  it("🔴 never tries to win back a client the shop blocked from booking", async () => {
    const shop = await makeShop();
    const client = await makeLapsedClient(shop.id, "tel:+13025552009", "+13025552009", 120);
    await prisma.client.update({ where: { id: client.id }, data: { bookingBlockedAt: NOW } });
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.considered).toBe(0);
    expect(sent.length).toBe(0);
    expect(await prisma.nudge.count({ where: { shopId: shop.id, clientId: client.id } })).toBe(0);
  });

  it("a merely-overdue client (past median+buffer but not the multiple) is NOT swept", async () => {
    const shop = await makeShop();
    // 60 days lapsed: a regular-nudge candidate, but 60 <= 30*3=90, so no win-back.
    await makeLapsedClient(shop.id, "tel:+13025552002", "+13025552002", 60);
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("dry-run records SKIPPED, sends nothing, and returns the preview list", async () => {
    const shop = await makeShop();
    await makeLapsedClient(shop.id, "tel:+13025552003", "+13025552003", 120);
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: true });
    expect(summary.skipped).toBe(1);
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
    const nudge = await prisma.nudge.findFirst({ where: { shopId: shop.id } });
    expect(nudge?.status).toBe("SKIPPED");
    expect(nudge?.kind).toBe("winback");
    // The dry-run returns who it WOULD text in-memory (the dashboard preview
    // reads this directly, not the accumulating SKIPPED rows).
    expect(summary.preview).toHaveLength(1);
    expect(summary.preview?.[0]?.name).toBe("Lapsed");
    expect(summary.preview?.[0]?.daysLapsed).toBe(120);
  });

  it("a REAL run does not populate the preview list", async () => {
    const shop = await makeShop();
    await makeLapsedClient(shop.id, "tel:+13025552007", "+13025552007", 120);
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(1);
    expect(summary.preview).toBeUndefined();
  });

  it("suppresses a client already won back within the 90-day window", async () => {
    const shop = await makeShop();
    await makeLapsedClient(shop.id, "tel:+13025552004", "+13025552004", 120);
    // First win-back send.
    const first = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(first.sent).toBe(1);
    sent = [];
    // 30 days later: still inside the 90-day suppression -> no second send.
    const second = await sweepShopWinback(shop, { now: addDays(NOW, 30), dryRun: false });
    expect(second.sent).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("a recent ordinary nudge does NOT suppress a win-back (separate clocks)", async () => {
    const shop = await makeShop();
    const client = await makeLapsedClient(shop.id, "tel:+13025552005", "+13025552005", 120);
    // A recent kind="nudge" send to the SAME client. Win-back W4 counts only
    // kind="winback" rows, so this must not block the win-back.
    await forShop(shop.id).nudge.create({
      data: { clientId: client.id, channel: "SMS", status: "SENT", kind: "nudge", body: "due" },
    });
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(1);
  });

  it("sends nothing during TCPA quiet hours (real run)", async () => {
    const shop = await makeShop();
    await makeLapsedClient(shop.id, "tel:+13025552006", "+13025552006", 120);
    const quietNow = new Date("2026-06-01T06:00:00Z"); // 02:00 EDT
    const summary = await sweepShopWinback(shop, { now: quietNow, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
  });
});

describe("🔴 never to a client who already booked (engines/upcomingBooking.ts)", () => {
  it("a lapsed client with a ChairBack appointment ahead is not won back", async () => {
    const shop = await makeShop();
    const client = await makeLapsedClient(shop.id, "tel:+13025552301", "+13025552301", 120);
    const staff = await prisma.staff.create({ data: { shopId: shop.id, name: "Sam" } });
    const service = await prisma.service.create({ data: { shopId: shop.id, name: "Cut", durationMin: 30 } });
    await prisma.appointment.create({
      data: {
        shopId: shop.id,
        staffId: staff.id,
        serviceId: service.id,
        clientId: client.id,
        firstName: "Lapsed",
        status: "BOOKED",
        startsAt: addDays(NOW, 3),
        endsAt: new Date(addDays(NOW, 3).getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
    });
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  // 🔴 The completion sweep waits a day after a booking ends (NO_SHOW_WINDOW_MS)
  // so a no-show can still be marked. Until then there is no COMPLETED visit and
  // lastVisitAt is the one before - so yesterday's cut must still count as "on
  // the books", or the client sitting in the chair yesterday gets a win-back.
  async function bookedEndingAt(shopId: string, clientId: string, endsAt: Date) {
    const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
    const service = await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30 } });
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        clientId,
        firstName: "Lapsed",
        status: "BOOKED",
        startsAt: new Date(endsAt.getTime() - 30 * 60_000),
        endsAt,
        manageToken: randomToken(),
      },
    });
  }

  it("🔴 a booking that ended 3 hours ago and is not settled yet still counts - no win-back", async () => {
    const shop = await makeShop();
    const client = await makeLapsedClient(shop.id, "tel:+13025552303", "+13025552303", 120);
    await bookedEndingAt(shop.id, client.id, new Date(NOW.getTime() - 3 * 3_600_000));
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("a BOOKED row past the no-show window is not a booking ahead", async () => {
    const shop = await makeShop();
    const client = await makeLapsedClient(shop.id, "tel:+13025552304", "+13025552304", 120);
    await bookedEndingAt(shop.id, client.id, addDays(NOW, -2));
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(1);
  });

  it("a lapsed client whose Acuity visit ahead was RESCHEDULED is not won back", async () => {
    const shop = await makeShop();
    const client = await makeLapsedClient(shop.id, "tel:+13025552302", "+13025552302", 120);
    await prisma.visit.create({
      data: {
        shopId: shop.id,
        clientId: client.id,
        acuityAppointmentId: "moved-once",
        status: "RESCHEDULED",
        scheduledAt: addDays(NOW, 5),
      },
    });
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
  });
});

describe("runWinbackSweep (shop gate)", () => {
  it("skips a shop with winbackTextsEnabled = false", async () => {
    const offShop = await makeShop({
      name: "Winback Off Shop",
      bookingUrl: "https://off.test",
      winbackTextsEnabled: false, // explicit
    });
    await makeLapsedClient(offShop.id, "tel:+13025552099", "+13025552099", 120);
    const summaries = await runWinbackSweep({ now: NOW, dryRun: false });
    // The off shop must not appear in the summaries at all (filtered by the query).
    expect(summaries.some((s) => s.shopId === offShop.id)).toBe(false);
    const nudges = await prisma.nudge.count({ where: { shopId: offShop.id } });
    expect(nudges).toBe(0);
  });
});

// 🔴 SHOP-LOCAL SENDING HOURS BOUND THE PUSH TOO (see nudge.test.ts): the
// 11:00 UTC cron put every US shop's win-back push at 4 to 8 AM.
describe("🔴 win-backs go out inside shop-local sending hours - push included", () => {
  it("a real run at 2 AM shop time sends no push either; at 11 AM it does", async () => {
    const shop = await makeShop({ timezone: "America/New_York" });
    const client = await makeLapsedClient(shop.id, "tel:+13025552401", "+13025552401", 120);
    await prisma.pushSubscription.create({
      data: { shopId: shop.id, clientId: client.id, kind: "expo", expoPushToken: "ExponentPushToken[wbhours]" },
    });
    const pushed: string[] = [];
    __setExpoSenderForTests({
      async send(token) {
        pushed.push(token);
      },
    });
    try {
      // 06:00 UTC = 02:00 in New York.
      const night = await sweepShopWinback(shop, { now: new Date("2026-06-01T06:00:00Z"), dryRun: false });
      expect(pushed).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(night.sent).toBe(0);
      expect(await prisma.nudge.count({ where: { shopId: shop.id } })).toBe(0);

      // 15:00 UTC = 11:00 in New York.
      const day = await sweepShopWinback(shop, { now: new Date("2026-06-01T15:00:00Z"), dryRun: false });
      expect(pushed).toEqual(["ExponentPushToken[wbhours]"]);
      expect(day.sent).toBe(1);
    } finally {
      __setExpoSenderForTests(undefined);
    }
  });

  it("the hourly tick sweeps each shop at ITS OWN 11 AM", async () => {
    const ny = await makeShop({ name: "WB New York", timezone: "America/New_York" });
    const la = await makeShop({ name: "WB LA", timezone: "America/Los_Angeles" });
    const mine = (summaries: { shopId: string }[]) =>
      summaries.map((s) => s.shopId).filter((id) => id === ny.id || id === la.id);

    // Previews (dryRun), so no other suite's shop in the shared DB is sent to.
    // 15:00 UTC: 11 AM in New York, 8 AM in Los Angeles.
    const at15 = await runWinbackSweep({
      now: new Date("2026-06-01T15:00:00Z"),
      dryRun: true,
      localHour: WINBACK_SEND_LOCAL_HOUR,
    });
    expect(mine(at15)).toEqual([ny.id]);
    // 18:00 UTC: 2 PM in New York, 11 AM in Los Angeles.
    const at18 = await runWinbackSweep({
      now: new Date("2026-06-01T18:00:00Z"),
      dryRun: true,
      localHour: WINBACK_SEND_LOCAL_HOUR,
    });
    expect(mine(at18)).toEqual([la.id]);
  });
});
