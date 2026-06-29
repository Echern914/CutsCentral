import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addDays, randomToken } from "@chairback/config";
import { forShop, prisma, type Shop } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { MessageProvider } from "../messaging/provider.js";
import { sweepShopWinback, runWinbackSweep } from "./winback.js";

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

  it("a merely-overdue client (past median+buffer but not the multiple) is NOT swept", async () => {
    const shop = await makeShop();
    // 60 days lapsed: a regular-nudge candidate, but 60 <= 30*3=90, so no win-back.
    await makeLapsedClient(shop.id, "tel:+13025552002", "+13025552002", 60);
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("dry-run records SKIPPED and sends nothing", async () => {
    const shop = await makeShop();
    await makeLapsedClient(shop.id, "tel:+13025552003", "+13025552003", 120);
    const summary = await sweepShopWinback(shop, { now: NOW, dryRun: true });
    expect(summary.skipped).toBe(1);
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
    const nudge = await prisma.nudge.findFirst({ where: { shopId: shop.id } });
    expect(nudge?.status).toBe("SKIPPED");
    expect(nudge?.kind).toBe("winback");
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
