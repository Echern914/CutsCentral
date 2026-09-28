import request from "supertest";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { ingestAppointment } from "../ingest.js";
import type { AcuityAppointment } from "../acuity/types.js";
import { previewBroadcast, queueBroadcast } from "../engines/broadcast.js";
import { runBroadcastWorker } from "../engines/broadcastWorker.js";
import { suppressionAddressHash } from "../engines/broadcastAudience.js";
import { applyEmailEvent } from "./emailDelivery.js";
import { editClient, mergeClients } from "./client.js";
import { notifyAppointmentConfirmation } from "./appointmentNotify.js";

/**
 * 🔴 AN UNSUBSCRIBE OR A BOUNCE IS ABOUT AN ADDRESS, AND A RECORD'S ADDRESS
 * CHANGES (#514).
 *
 * Kept only on the client record, a bounce followed the record onto its new,
 * working address, and an unsubscribed address became mailable again on any
 * other record once the record that unsubscribed had moved on - or had been
 * blanked by the customer deleting their data. Every case here goes through
 * the real paths: the Acuity sync, the one-click unsubscribe link, the signed
 * provider webhook, self-deletion from the rewards page.
 */

const app = createApp();
const SECRET = "whsec_" + Buffer.from("supp-test-webhook-key-0123").toString("base64");
const PERMITTED = new Date("2026-01-01T00:00:00Z");
let ownerId: string;
let shopId: string;
let outbox: SendEmailInput[] = [];
const messageIds: string[] = [];

beforeAll(async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  __setSendEmailForTests(async (input) => {
    outbox.push(input);
    const id = `msg-${randomToken(8)}`;
    messageIds.push(id);
    return { id, status: "sent" as const };
  });
  const user = await prisma.user.create({
    data: { email: `supp-${randomToken(6)}@test.local`.toLowerCase(), passwordHash: "x", name: "S" },
    select: { id: true },
  });
  ownerId = user.id;
});

beforeEach(async () => {
  outbox = [];
  // A fresh shop per case: nothing one case suppresses can reach the next.
  const shop = await prisma.shop.create({
    data: {
      ownerId,
      name: "Address Cuts",
      slug: `address-cuts-${randomToken(5).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      bookingMode: "acuity",
      bookingUrl: "https://address.test",
      webhookSecret: randomToken(16),
      compAccess: true,
      addressStreet: "7 Sample Ave",
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
  delete process.env.RESEND_WEBHOOK_SECRET;
  if (messageIds.length) {
    await prisma.emailWebhookEvent.deleteMany({ where: { messageId: { in: messageIds } } });
    await prisma.emailDelivery.deleteMany({ where: { messageId: { in: messageIds } } });
  }
  if (ownerId) {
    await prisma.shop.deleteMany({ where: { ownerId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  }
});

// ── the real paths ────────────────────────────────────────────────────────────

/** A past booking arriving through the Acuity sync - which updates the record's email. */
async function sync(id: number, phone: string, email: string): Promise<void> {
  const start = new Date(Date.now() - (20 - id / 100) * 24 * 3_600_000);
  const a: AcuityAppointment = {
    id: String(id),
    firstName: "Sample",
    lastName: "Person",
    phone,
    email,
    datetime: start.toISOString(),
    endTime: new Date(start.getTime() + 30 * 60_000).toISOString(),
    price: "40.00",
    type: "Cut",
    canceled: false,
    noShow: false,
    duration: 30,
  };
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  await ingestAppointment(shop, "scheduled", a.id, a);
}

const byPhone = (phone: string) =>
  prisma.client.findUniqueOrThrow({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: `tel:${phone}` } },
  });

/** The customer's recorded yes to marketing email - how they get into a blast at all. */
const permit = (clientId: string) =>
  prisma.client.update({ where: { id: clientId }, data: { emailMarketingConsentAt: PERMITTED } });

/** Another record of the shop carrying an address: an import, a duplicate, a family booking. */
const otherRecord = (email: string) =>
  prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `mail:${randomToken(8)}`,
      magicToken: randomToken(),
      email,
      emailMarketingConsentAt: PERMITTED,
    },
    select: { id: true },
  });

/** Queue an email blast to everyone; returns the broadcast id. */
async function queue(): Promise<string> {
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
  expect((await queueBroadcast({ shopId, broadcastId: b.id })).ok).toBe(true);
  return b.id;
}

/** Who a blast queued now would reach, and why the rest are left out. */
async function audience() {
  const p = await previewBroadcast({ shopId, channel: "email", tiers: [] });
  return { reachable: p.reachable, skipped: Object.fromEntries(p.skipped.map((s) => [s.reason, s.count])) };
}

const lastMessageTo = async (clientId: string) =>
  (await prisma.broadcastSend.findFirstOrThrow({
    where: { clientId, status: "SENT" },
    orderBy: { sentAt: "desc" },
    select: { messageId: true },
  })).messageId!;

/** A provider event, signed and delivered to the real webhook route. */
function webhook(type: string, messageId: string, to?: string[]) {
  const raw = JSON.stringify({ type, data: { email_id: messageId, ...(to ? { to } : {}) } });
  const id = `msg_${randomToken(8)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return request(app)
    .post("/webhooks/resend")
    .set("Content-Type", "application/json")
    .set("svix-id", id)
    .set("svix-timestamp", ts)
    .set("svix-signature", `v1,${sig}`)
    .send(raw);
}

const table = () =>
  prisma.emailAddressSuppression.findMany({
    where: { shopId },
    select: { addressHash: true, kind: true, source: true },
    orderBy: [{ kind: "asc" }, { addressHash: "asc" }],
  });
const entry = (address: string, kind: string, source: string) => ({
  addressHash: suppressionAddressHash(shopId, address),
  kind,
  source,
});

// ── the acceptance cases ──────────────────────────────────────────────────────

describe("🔴 a bounce stays with the mailbox that bounced", () => {
  it("a record whose address changes - by a sync - is mailed at its new address, and the old one stays out", async () => {
    const phone = "+13025557101";
    await sync(1, phone, "pat.typo@example.com");
    const pat = await byPhone(phone);
    await permit(pat.id);
    await queue();
    await runBroadcastWorker({ shopId });
    expect(outbox.map((m) => m.to)).toEqual(["pat.typo@example.com"]);

    // It bounces. The webhook runs with no shop session at all.
    const bounced = await webhook("email.bounced", await lastMessageTo(pat.id), ["pat.typo@example.com"]);
    expect(bounced.status).toBe(200);
    expect(await table()).toEqual([entry("pat.typo@example.com", "bounce", "provider_webhook")]);

    // Pat's next booking carries the corrected address. The record still says
    // it bounced (the owner's screens), and that must not follow it.
    await sync(2, phone, "pat@example.com");
    expect((await byPhone(phone)).emailSuppressedAt).not.toBeNull();
    await otherRecord("  PAT.TYPO@Example.com ");
    expect(await audience()).toEqual({ reachable: 1, skipped: { undeliverable: 1 } });

    outbox = [];
    await queue();
    await runBroadcastWorker({ shopId });
    expect(outbox.map((m) => m.to)).toEqual(["pat@example.com"]);
  });

  it("is bound to the provider's recipient, even if the record moved on before the event arrived", async () => {
    const phone = "+13025557102";
    await sync(3, phone, "first@example.com");
    const c = await byPhone(phone);
    await permit(c.id);
    await queue();
    await runBroadcastWorker({ shopId });
    const messageId = await lastMessageTo(c.id);
    await sync(4, phone, "second@example.com");

    expect((await webhook("email.complained", messageId, ["first@example.com"])).status).toBe(200);

    // A complaint is recorded as a complaint, against the address it was about.
    expect(await table()).toEqual([entry("first@example.com", "complaint", "provider_webhook")]);
  });

  it("falls back to the record's address when the event names no recipient", async () => {
    const phone = "+13025557103";
    await sync(5, phone, "no.recipient@example.com");
    const c = await byPhone(phone);
    await permit(c.id);
    await queue();
    await runBroadcastWorker({ shopId });

    const outcome = await applyEmailEvent({
      messageId: await lastMessageTo(c.id),
      event: "email.bounced",
      svixId: `svix_${randomToken(8)}`,
    });
    expect(outcome).toBe("applied");
    expect(await table()).toEqual([entry("no.recipient@example.com", "bounce", "provider_webhook")]);
  });
});

describe("🔴 an unsubscribed address stays out", () => {
  it("on every other record, after the record that unsubscribed has moved on", async () => {
    const phone = "+13025557104";
    await sync(6, phone, "sam@example.com");
    const sam = await byPhone(phone);
    await permit(sam.id);
    await queue();
    await runBroadcastWorker({ shopId });
    const link = outbox[0]!.unsubscribeUrl!;

    // One click - bound to the record's current address.
    expect((await request(app).post(new URL(link).pathname)).status).toBe(200);
    expect(await table()).toEqual([entry("sam@example.com", "unsubscribe", "unsubscribe_link")]);

    // Sam's record moves on; another record still carries the address.
    await sync(7, phone, "sam.new@example.com");
    await otherRecord("Sam@Example.com");

    // Sam stays out at the new address (their own record says so), and the
    // address they unsubscribed stays out on the other record.
    expect(await audience()).toEqual({ reachable: 0, skipped: { unsubscribed: 2 } });
  });

  it("🔴 for a customer who deleted their data, when a sync brings the address back", async () => {
    const phone = "+13025557105";
    await sync(8, phone, "lee@example.com");
    const lee = await byPhone(phone);
    await permit(lee.id);
    await queue();
    await runBroadcastWorker({ shopId });
    expect((await request(app).post(new URL(outbox[0]!.unsubscribeUrl!).pathname)).status).toBe(200);

    // Lee deletes their data from the rewards page: the record is blanked.
    expect((await request(app).post(`/api/rewards/${lee.magicToken}/delete`)).status).toBe(200);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: lee.id } })).email).toBeNull();

    // A later sync brings the same person, and the same address, back - as a
    // brand-new record. Even with a yes on it, the address stays out.
    await sync(9, phone, "lee@example.com");
    const fresh = await byPhone(phone);
    expect(fresh.id).not.toBe(lee.id);
    await permit(fresh.id);
    expect(await audience()).toEqual({ reachable: 0, skipped: { unsubscribed: 1, archived: 1 } });
  });
});

describe("🔴 the send-time check reads it too", () => {
  it("a bounce that arrives after the freeze stops the email to another record with that address", async () => {
    const phone = "+13025557106";
    await sync(10, phone, "shared@example.com");
    const first = await byPhone(phone);
    await permit(first.id);
    await queue();
    await runBroadcastWorker({ shopId });
    const earlier = await lastMessageTo(first.id);

    // The first record moves on; a second record now carries the address and
    // is frozen into the next blast.
    await sync(11, phone, "moved@example.com");
    const second = await otherRecord("shared@example.com");
    outbox = [];
    const next = await queue();

    // Only then does the earlier email's bounce arrive, naming the address.
    expect((await webhook("email.bounced", earlier, ["shared@example.com"])).status).toBe(200);
    await runBroadcastWorker({ shopId });

    expect(outbox.map((m) => m.to)).toEqual(["moved@example.com"]);
    const row = await prisma.broadcastSend.findFirstOrThrow({
      where: { broadcastId: next, clientId: second.id },
      select: { status: true, reason: true },
    });
    expect(row).toEqual({ status: "SKIPPED", reason: "undeliverable" });
  });
});

describe("🔴 never cleared", () => {
  it("by a hand edit, a sync or a merge", async () => {
    const phone = "+13025557107";
    await sync(12, phone, "kept@example.com");
    const c = await byPhone(phone);
    await permit(c.id);
    await queue();
    await runBroadcastWorker({ shopId });
    await request(app).post(new URL(outbox[0]!.unsubscribeUrl!).pathname);
    await webhook("email.bounced", await lastMessageTo(c.id), ["kept@example.com"]);
    const before = await table();
    expect(before).toHaveLength(2);

    expect(await editClient(shopId, c.id, { email: "edited@example.com" })).toEqual({ ok: true });
    await sync(13, phone, "synced@example.com");
    const dup = await otherRecord("kept@example.com");
    expect((await mergeClients(shopId, c.id, dup.id)).ok).toBe(true);

    expect(await table()).toEqual(before);
  });
});

describe("appointment email reads none of it", () => {
  it("an unsubscribed, bounced address still gets its booking confirmation", async () => {
    const phone = "+13025557108";
    await sync(14, phone, "booked@example.com");
    const c = await byPhone(phone);
    await permit(c.id);
    await queue();
    await runBroadcastWorker({ shopId });
    await request(app).post(new URL(outbox[0]!.unsubscribeUrl!).pathname);
    await webhook("email.bounced", await lastMessageTo(c.id), ["booked@example.com"]);
    expect(await table()).toHaveLength(2);

    const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
    const service = await prisma.service.create({ data: { shopId, name: "Haircut", durationMin: 30 } });
    const startsAt = new Date(Date.now() + 3 * 24 * 3_600_000);
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        clientId: c.id,
        firstName: "Sample",
        phone,
        email: "booked@example.com",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
      select: { id: true },
    });

    outbox = [];
    await notifyAppointmentConfirmation({ shopId, appointmentId: appt.id });
    expect(outbox.map((m) => m.to)).toEqual(["booked@example.com"]);
  });
});
