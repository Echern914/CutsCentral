import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { applyEmailEvent } from "../services/emailDelivery.js";
import { queueBroadcast } from "./broadcast.js";
import { runBroadcastWorker } from "./broadcastWorker.js";

/**
 * 🔴 A BLAST IS FROZEN WHEN IT IS QUEUED, AND SENT LATER. WHAT HAPPENS IN
 * BETWEEN STILL COUNTS.
 *
 * Pressing send freezes the audience. The worker then drains it fifty at a
 * time, with backoffs of up to an hour - so a customer can unsubscribe from the
 * shop's last email, bounce, or lose their permission after the freeze and
 * before their copy of this one leaves. Each of these tests changes one of
 * those facts in that window and checks the email does not go out, and that
 * the skip is recorded in the freeze's own words.
 */

const app = createApp();
let shopId: string;
let ownerId: string;
let outbox: SendEmailInput[] = [];
/** Runs as each email is handed to the provider - the moment it leaves. */
let onSend: ((input: SendEmailInput) => Promise<void>) | null = null;

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    outbox.push(input);
    await onSend?.(input);
    return { id: `msg-${outbox.length}-${randomToken(6)}`, status: "sent" as const };
  });
  const user = await prisma.user.create({
    data: { email: `recheck-${randomToken(6)}@test.local`.toLowerCase(), passwordHash: "x", name: "R" },
    select: { id: true },
  });
  ownerId = user.id;
  const shop = await prisma.shop.create({
    data: {
      name: "Recheck Cuts",
      ownerId,
      slug: `recheck-cuts-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      bookingUrl: "https://r.test",
      webhookSecret: randomToken(16),
      addressStreet: "5 Sample St",
      addressCity: "Newark",
      addressRegion: "NJ",
      addressPostal: "07102",
    },
    select: { id: true },
  });
  shopId = shop.id;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
});

beforeEach(async () => {
  outbox = [];
  onSend = null;
  await prisma.broadcast.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.shopEmailQuota.deleteMany({ where: { shopId } });
  await prisma.emailDelivery.deleteMany({ where: { shopId } });
});

async function makeClient(over: { email?: string; archived?: boolean } = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      magicToken: randomToken(),
      firstName: "Client",
      email: over.email ?? `c${randomToken(6)}@example.com`.toLowerCase(),
      emailMarketingConsentAt: new Date("2026-01-01T00:00:00Z"),
      loyaltyTier: "GOLD",
      ...(over.archived ? { archivedAt: new Date() } : {}),
    },
    select: { id: true },
  });
}

/** Queue an email blast to everyone: the audience is frozen when this returns. */
async function queued(): Promise<string> {
  const b = await prisma.broadcast.create({
    data: {
      shopId,
      createdByUserId: ownerId,
      channel: "email",
      audienceTiers: [],
      subject: "Friday",
      body: "Two chairs open.",
      status: "DRAFT",
    },
    select: { id: true },
  });
  const outcome = await queueBroadcast({ shopId, broadcastId: b.id });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return b.id;
}

const sendRow = (broadcastId: string, clientId: string) =>
  prisma.broadcastSend.findFirst({
    where: { broadcastId, clientId },
    select: { status: true, reason: true },
  });

describe("🔴 what changed after the freeze stops the email", () => {
  it("an unsubscribe clicked in the shop's LAST email stops the one already queued", async () => {
    const c = await makeClient();
    await queued();
    await runBroadcastWorker({ shopId });
    expect(outbox).toHaveLength(1);
    const link = outbox[0]!.unsubscribeUrl!;

    // The next promotion is queued - its audience frozen with them in it -
    // and THEN they click unsubscribe in the first one.
    const next = await queued();
    expect((await sendRow(next, c.id))!.status).toBe("PENDING");
    expect((await request(app).post(new URL(link).pathname)).status).toBe(200);

    outbox = [];
    await runBroadcastWorker({ shopId });

    expect(outbox).toHaveLength(0);
    expect(await sendRow(next, c.id)).toEqual({ status: "SKIPPED", reason: "unsubscribed" });
    // The barber's report counts it as a skip, not as a send.
    const done = await prisma.broadcast.findUnique({
      where: { id: next },
      select: { sentCount: true, skippedCount: true },
    });
    expect(done).toEqual({ sentCount: 0, skippedCount: 1 });
  });

  it("a bounce recorded after the freeze stops it, as undeliverable - not as an unsubscribe", async () => {
    const c = await makeClient();
    await queued();
    await runBroadcastWorker({ shopId });
    const first = await prisma.broadcastSend.findFirst({
      where: { clientId: c.id, status: "SENT" },
      select: { messageId: true },
    });

    const next = await queued();
    expect(
      await applyEmailEvent({ messageId: first!.messageId!, event: "email.bounced", svixId: randomToken(8) }),
    ).toBe("applied");

    outbox = [];
    await runBroadcastWorker({ shopId });

    expect(outbox).toHaveLength(0);
    expect(await sendRow(next, c.id)).toEqual({ status: "SKIPPED", reason: "undeliverable" });
  });

  it("a permission withdrawn after the freeze stops it", async () => {
    const c = await makeClient();
    const id = await queued();
    await prisma.client.update({ where: { id: c.id }, data: { emailMarketingConsentAt: null } });

    await runBroadcastWorker({ shopId });

    expect(outbox).toHaveLength(0);
    expect(await sendRow(id, c.id)).toEqual({ status: "SKIPPED", reason: "not_permitted" });
  });

  it("🔴 an unsubscribe on ANOTHER record with the same address counts, whatever its case or padding", async () => {
    const c = await makeClient({ email: "sam.sample@example.com" });
    // An old duplicate of the same person, archived - so the freeze skips it
    // and only their live record is queued.
    const dup = await makeClient({ archived: true, email: "sam.sample@example.com" });
    const id = await queued();
    await prisma.client.update({
      where: { id: dup.id },
      data: { email: "  Sam.Sample@Example.COM ", emailOptedOut: true, emailOptedOutAt: new Date() },
    });

    await runBroadcastWorker({ shopId });

    expect(outbox).toHaveLength(0);
    expect(await sendRow(id, c.id)).toEqual({ status: "SKIPPED", reason: "unsubscribed" });
  });

  it("🔴 is asked per recipient as it leaves, not once per pass", async () => {
    const a = await makeClient();
    const b = await makeClient();
    const id = await queued();
    // Both recipients are claimed and loaded in ONE pass. While the first
    // one's email is leaving, the other unsubscribes.
    onSend = async (input) => {
      const other = input.meta?.clientId === a.id ? b.id : a.id;
      await prisma.client.update({ where: { id: other }, data: { emailOptedOut: true } });
      onSend = null;
    };

    await runBroadcastWorker({ shopId });

    expect(outbox).toHaveLength(1);
    const rows = await prisma.broadcastSend.findMany({
      where: { broadcastId: id },
      select: { status: true, reason: true },
    });
    expect(rows.map((r) => `${r.status}:${r.reason ?? ""}`).sort()).toEqual([
      "SENT:",
      "SKIPPED:unsubscribed",
    ]);
  });
});

describe("🔴 an address changed after the freeze", () => {
  it("is mailed at the address the record has NOW, even one corrected mid-pass", async () => {
    const a = await makeClient();
    const b = await makeClient();
    await queued();
    // Both are loaded in one pass. While the first one's email is leaving,
    // the other's address is corrected.
    let corrected: string | null = null;
    onSend = async (input) => {
      corrected = input.meta?.clientId === a.id ? b.id : a.id;
      await prisma.client.update({ where: { id: corrected }, data: { email: "new.address@example.com" } });
      onSend = null;
    };

    await runBroadcastWorker({ shopId });

    expect(outbox).toHaveLength(2);
    expect(outbox[1]!.meta?.clientId).toBe(corrected);
    expect(outbox[1]!.to).toBe("new.address@example.com");
  });

  it("🔴 and the NEW address is checked: one unsubscribed on another record is not mailed", async () => {
    const c = await makeClient({ email: "old.address@example.com" });
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
        magicToken: randomToken(),
        email: "taken.address@example.com",
        emailOptedOut: true,
        archivedAt: new Date(),
      },
    });
    const id = await queued();
    await prisma.client.update({ where: { id: c.id }, data: { email: "taken.address@example.com" } });

    await runBroadcastWorker({ shopId });

    expect(outbox).toHaveLength(0);
    expect(await sendRow(id, c.id)).toEqual({ status: "SKIPPED", reason: "unsubscribed" });
  });
});
