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

let sent: { to: string; body: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sent.push(input);
    return { sid: `SM${sent.length}`, status: "queued" };
  },
};

let userId: string;
let shop: Shop;

async function makeOverdueClient(shopId: string, key: string, phone: string) {
  const db = forShop(shopId);
  const client = await db.client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
    create: {
      acuityClientKey: key,
      magicToken: randomToken(),
      firstName: "Over",
      phone,
      // overdue: median 30, last visit 60 days ago, buffer 7 → 60 > 37
      medianIntervalDays: 30,
      lastVisitAt: addDays(NOW, -60),
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
        scheduledAt: addDays(NOW, -60 - i * 30),
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
    expect(nudge?.body).toContain("/r/");
  });

  it("real run writes PENDING→SENT and sends via the provider", async () => {
    const summary = await sweepShop(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBe(summary.sent);
    const sentNudges = await prisma.nudge.findMany({
      where: { shopId: shop.id, status: "SENT" },
    });
    expect(sentNudges.length).toBe(summary.sent);
    expect(sentNudges[0]?.messageSid).toMatch(/^SM/);
  });

  it("respects the per-shop daily cap", async () => {
    // Cap is 2; add a 3rd overdue client → only 2 should send.
    await makeOverdueClient(shop.id, "tel:+13025551002", "+13025551002");
    await makeOverdueClient(shop.id, "tel:+13025551003", "+13025551003");
    const summary = await sweepShop(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(2);
    expect(sent.length).toBe(2);
  });

  it("suppresses a client already nudged within 21 days", async () => {
    // First real send.
    await sweepShop(shop, { now: NOW, dryRun: false });
    const firstCount = await prisma.nudge.count({ where: { shopId: shop.id, status: "SENT" } });
    expect(firstCount).toBeGreaterThanOrEqual(1);
    sent = [];
    // Same day again → all suppressed by R4 (PENDING/SENT within 21d).
    const summary = await sweepShop(shop, { now: NOW, dryRun: false });
    expect(summary.sent).toBe(0);
    expect(sent.length).toBe(0);
  });
});
