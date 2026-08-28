import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { expireStaleWalkIns } from "./walkInExpiry.js";

/**
 * The end-of-day sweep: dry-run and live are the same scan, a concurrent
 * mover always beats the sweep, the boundary is the SHOP's midnight, and
 * the whole thing is structurally mute.
 */

let userId: string;
let utcShop: string;
let nyShop: string;
let seq = 0;
let sent: SendMessageInput[] = [];

// 01:00 UTC on Sep 3: past UTC-shop midnight, but still Sep 2 EVENING in
// New York - the same instant expires one shop's line and not the other's.
const NOW = new Date("2026-09-03T01:00:00.000Z");
const YESTERDAY = new Date("2026-09-02T15:00:00.000Z");

async function mkEntry(shopId: string, over: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.walkInEntry.create({
    data: {
      shopId,
      firstName: `E${seq}`,
      source: "STAFF",
      status: "WAITING",
      position: seq * 1024,
      joinedAt: YESTERDAY,
      ...over,
    },
    select: { id: true, status: true },
  });
}

beforeAll(async () => {
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (i) => {
      sent.push(i);
      return { sid: "T", status: "sent" };
    },
  });
  const user = await prisma.user.create({
    data: { email: `we2-${randomToken(6)}@test.local`, name: "WE2" },
    select: { id: true },
  });
  userId = user.id;
  const mk = async (name: string, timezone: string) =>
    (
      await prisma.shop.create({
        data: {
          ownerId: userId,
          name,
          slug: `we2-${randomToken(5)}`.toLowerCase(),
          webhookSecret: randomToken(),
          timezone,
          walkInEnabled: true,
        },
        select: { id: true },
      })
    ).id;
  utcShop = await mk("UTC Cuts", "UTC");
  nyShop = await mk("NY Cuts", "America/New_York");
});

afterEach(async () => {
  sent = [];
  await prisma.walkInEvent.deleteMany({ where: { shopId: { in: [utcShop, nyShop] } } });
  await prisma.walkInEntry.deleteMany({ where: { shopId: { in: [utcShop, nyShop] } } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("expireStaleWalkIns", () => {
  it("dry-run counts what it WOULD retire and writes NOTHING", async () => {
    const e = await mkEntry(utcShop);
    const r = await expireStaleWalkIns(NOW, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.actionable).toBeGreaterThanOrEqual(1);
    expect(r.expired).toBe(0);
    const row = await prisma.walkInEntry.findUnique({ where: { id: e.id } });
    expect(row!.status).toBe("WAITING");
  });

  it("live: flips past-boundary entries with the audit row, honors each SHOP's midnight", async () => {
    const utcEntry = await mkEntry(utcShop); // past UTC midnight -> expires
    const nyEntry = await mkEntry(nyShop); // still Tuesday evening in NY -> stays
    const r = await expireStaleWalkIns(NOW, { dryRun: false });
    expect(r.expired).toBeGreaterThanOrEqual(1);

    const utcRow = await prisma.walkInEntry.findUnique({ where: { id: utcEntry.id } });
    expect(utcRow!.status).toBe("EXPIRED");
    expect(utcRow!.expiredAt).not.toBeNull();
    const nyRow = await prisma.walkInEntry.findUnique({ where: { id: nyEntry.id } });
    expect(nyRow!.status).toBe("WAITING");

    const audit = await prisma.walkInEvent.findMany({
      where: { shopId: utcShop, entryId: utcEntry.id, type: "entry.expired_auto" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe("system");
  });

  it("every ACTIVE status past the boundary retires; terminals are never read", async () => {
    await mkEntry(utcShop, { status: "ASSIGNED", assignedAt: YESTERDAY });
    await mkEntry(utcShop, { status: "READY", assignedAt: YESTERDAY, readyAt: YESTERDAY });
    const done = await mkEntry(utcShop, { status: "COMPLETED", completedAt: YESTERDAY });
    const r = await expireStaleWalkIns(NOW, { dryRun: false });
    expect(r.expired).toBe(2);
    const doneRow = await prisma.walkInEntry.findUnique({ where: { id: done.id } });
    expect(doneRow!.status).toBe("COMPLETED");
  });

  it("a TODAY entry is untouched by today's sweep", async () => {
    const fresh = await mkEntry(utcShop, { joinedAt: NOW });
    await expireStaleWalkIns(NOW, { dryRun: false });
    const row = await prisma.walkInEntry.findUnique({ where: { id: fresh.id } });
    expect(row!.status).toBe("WAITING");
  });

  it("🔴 sends NOTHING, live or dry - the sweep is structurally mute", async () => {
    await mkEntry(utcShop);
    await expireStaleWalkIns(NOW, { dryRun: false });
    await expireStaleWalkIns(NOW, { dryRun: true });
    expect(sent).toHaveLength(0);
  });

  it("an exhausted budget reports partial numbers instead of lying", async () => {
    await mkEntry(utcShop);
    const r = await expireStaleWalkIns(NOW, { dryRun: true, budgetMs: -1 });
    expect(r.budgetExhausted).toBe(true);
    expect(r.scanned).toBe(0);
  });
});
