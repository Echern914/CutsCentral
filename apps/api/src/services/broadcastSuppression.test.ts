import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { applyEmailEvent, recordEmailSent } from "./emailDelivery.js";
import { previewBroadcast, queueBroadcast } from "../engines/broadcast.js";
import { runBroadcastWorker } from "../engines/broadcastWorker.js";

/**
 * WHEN A MAILBOX REFUSES US, STOP SENDING TO IT.
 *
 * A hard bounce is an address that does not exist. A complaint is somebody
 * pressing "this is spam". Keeping either one on the list costs the whole
 * platform its sending reputation - and that reputation is what carries every
 * shop's booking confirmations, not just its promotions.
 *
 * 🔴 THE PART THAT IS EASY TO GET WRONG. The cheap version sets
 * `emailOptedOut = true` and is done. It also quietly rewrites history: the
 * barber's screen then reads "47 people unsubscribed from your emails" when
 * what actually happened is that 47 mailboxes bounced, and a customer who
 * never made that choice is recorded as having made it. The two facts are
 * stored separately, counted separately, and named separately - and these
 * tests hold that apart.
 */

const emailAddr = `supp-${randomToken(6)}@test.local`.toLowerCase();
let shopId: string;
let ownerId: string;
let outbox: SendEmailInput[] = [];

beforeAll(async () => {
  // The injected sender replaces the TRANSPORT only. It deliberately does NOT
  // write the delivery ledger: for a broadcast that is the worker's own job
  // now, done in the transaction that marks the recipient sent, and these
  // tests should exercise that path rather than a stand-in for the one it
  // replaced.
  __setSendEmailForTests(async (input) => {
    outbox.push(input);
    return { id: `msg-${outbox.length}-${randomToken(6)}`, status: "sent" as const };
  });
  const user = await prisma.user.create({
    data: { email: emailAddr, passwordHash: "x", name: "S" },
    select: { id: true },
  });
  ownerId = user.id;
  const shop = await prisma.shop.create({
    data: {
      name: "Bounce Cuts",
      ownerId,
      slug: `bounce-cuts-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      bookingUrl: "https://b.test",
      webhookSecret: randomToken(16),
      addressStreet: "3 Bounce Rd",
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
  await prisma.shop.deleteMany({ where: { ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

beforeEach(async () => {
  outbox = [];
  await prisma.broadcast.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
});

async function makeClient() {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      magicToken: randomToken(),
      firstName: "Client",
      email: `c${randomToken(6)}@example.com`,
      loyaltyTier: "GOLD",
    },
    select: { id: true },
  });
}

/** Mail everybody, and hand back what the provider was told about each. */
async function blastAndCollect(): Promise<SendEmailInput[]> {
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
  await runBroadcastWorker();
  return outbox;
}

/** The message id the ledger recorded for one client's copy. */
async function messageIdFor(clientId: string): Promise<string> {
  const row = await prisma.broadcastSend.findFirst({
    where: { clientId },
    select: { messageId: true },
  });
  expect(row?.messageId).toBeTruthy();
  return row!.messageId!;
}

/**
 * The dispatch ledger row is COMMITTED BY THE WORKER PASS, in the same
 * transaction that marked the recipient sent - so by the time the pass
 * returns it is simply there.
 *
 * It used to be a floating promise these tests had to poll for. That polling
 * was the visible edge of the defect: a write nobody waits for is a write
 * whose failure nobody notices.
 */
async function requireDelivery(messageId: string) {
  const row = await prisma.emailDelivery.findUnique({ where: { messageId } });
  expect(row, "the worker did not commit a delivery row").not.toBeNull();
  return row!;
}

describe("🔴 a bounce attaches to a person, without storing their address", () => {
  it("the ledger row names the client, and nothing else about them", async () => {
    const c = await makeClient();
    const sent = await blastAndCollect();
    expect(sent).toHaveLength(1);
    await requireDelivery(await messageIdFor(c.id));

    const delivery = await prisma.emailDelivery.findFirst({ where: { clientId: c.id } });
    expect(delivery).not.toBeNull();
    expect(delivery!.kind).toBe("broadcast");
    expect(delivery!.shopId).toBe(shopId);
    // 🔴 An id, not an address. Without the id a provider event names a
    // message and nothing else, and the only way to find out whose mailbox
    // rejected it would be to copy the address into a second table.
    const columns = Object.keys(delivery!);
    expect(columns).not.toContain("to");
    expect(columns).not.toContain("email");
    expect(columns).not.toContain("subject");
    expect(JSON.stringify(delivery)).not.toContain(sent[0]!.to);
  });
});

describe("🔴 suppression, and what it is NOT", () => {
  it("a hard bounce stops the next blast reaching them", async () => {
    const c = await makeClient();
    await blastAndCollect();
    const messageId = await messageIdFor(c.id);
    await requireDelivery(messageId);

    expect(await applyEmailEvent({ messageId, event: "email.bounced", svixId: randomToken(8) }))
      .toBe("applied");

    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true, emailSuppressionReason: true, emailOptedOut: true },
    });
    expect(after!.emailSuppressedAt).not.toBeNull();
    expect(after!.emailSuppressionReason).toBe("hard_bounce");
    // 🔴 THE LINE THAT MATTERS. They did not unsubscribe. Recording it that way
    // would put a decision in a customer's mouth and report it back to the
    // barber as one.
    expect(after!.emailOptedOut).toBe(false);

    const preview = await previewBroadcast({ shopId, channel: "email", tiers: [] });
    expect(preview.reachable).toBe(0);
    const reason = preview.skipped.find((s) => s.reason === "undeliverable");
    expect(reason?.count).toBe(1);
    // And it is NOT counted among the unsubscribes.
    expect(preview.skipped.find((s) => s.reason === "unsubscribed")).toBeUndefined();
  });

  it("a spam complaint is recorded as a complaint, not as an opt-out", async () => {
    const c = await makeClient();
    await blastAndCollect();
    const messageId = await messageIdFor(c.id);
    await requireDelivery(messageId);

    await applyEmailEvent({ messageId, event: "email.complained", svixId: randomToken(8) });

    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true, emailSuppressionReason: true, emailOptedOut: true },
    });
    expect(after!.emailSuppressionReason).toBe("complaint");
    expect(after!.emailOptedOut).toBe(false);
  });

  it("a permanent provider failure suppresses too", async () => {
    const c = await makeClient();
    await blastAndCollect();
    const messageId = await messageIdFor(c.id);
    await requireDelivery(messageId);

    await applyEmailEvent({ messageId, event: "email.failed", svixId: randomToken(8) });
    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true, emailSuppressionReason: true },
    });
    expect(after!.emailSuppressionReason).toBe("provider_error");
  });

  it("a delivered message suppresses nobody", async () => {
    const c = await makeClient();
    await blastAndCollect();
    const messageId = await messageIdFor(c.id);
    await requireDelivery(messageId);

    await applyEmailEvent({ messageId, event: "email.delivered", svixId: randomToken(8) });
    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true },
    });
    expect(after!.emailSuppressedAt).toBeNull();
  });

  it("the FIRST terminal reason is the one kept", async () => {
    const c = await makeClient();
    await blastAndCollect();
    const messageId = await messageIdFor(c.id);
    await requireDelivery(messageId);

    await applyEmailEvent({ messageId, event: "email.bounced", svixId: randomToken(8) });
    const first = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true },
    });
    // A second, different terminal event arrives later. The record already
    // explains what happened; overwriting it would lose the explanation.
    await applyEmailEvent({ messageId, event: "email.complained", svixId: randomToken(8) });
    const second = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true, emailSuppressionReason: true },
    });
    expect(second!.emailSuppressionReason).toBe("hard_bounce");
    expect(second!.emailSuppressedAt!.getTime()).toBe(first!.emailSuppressedAt!.getTime());
  });

  it("a replayed webhook changes nothing twice", async () => {
    const c = await makeClient();
    await blastAndCollect();
    const messageId = await messageIdFor(c.id);
    await requireDelivery(messageId);
    const svixId = randomToken(8);

    expect(await applyEmailEvent({ messageId, event: "email.bounced", svixId })).toBe("applied");
    expect(await applyEmailEvent({ messageId, event: "email.bounced", svixId })).toBe("duplicate");

    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true },
    });
    expect(after!.emailSuppressedAt).not.toBeNull();
  });

  it("🔴 a bounce that ARRIVES FIRST is not lost", async () => {
    // Webhooks routinely beat the sender's own metadata write - the provider
    // has already rejected the message by the time our ledger row lands. That
    // event cannot suppress anybody when it applies, because there is no
    // clientId on the row yet. The dispatch write has to finish the job.
    const c = await makeClient();
    const messageId = `msg-early-${randomToken(8)}`;
    await applyEmailEvent({ messageId, event: "email.bounced", svixId: randomToken(8) });
    const orphan = await prisma.emailDelivery.findUnique({ where: { messageId } });
    expect(orphan!.clientId).toBeNull();
    expect(orphan!.awaitingDispatchMeta).toBe(true);

    // ...and now our own write arrives, knowing who it was for.
    recordEmailSent(messageId, {
      to: "whoever@example.com",
      subject: "Friday",
      text: "Two chairs open.",
      meta: { shopId, clientId: c.id, kind: "broadcast" },
    });

    for (let i = 0; i < 100; i++) {
      const row = await prisma.client.findUnique({
        where: { id: c.id },
        select: { emailSuppressedAt: true },
      });
      if (row?.emailSuppressedAt) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true, emailSuppressionReason: true, emailOptedOut: true },
    });
    expect(after!.emailSuppressedAt).not.toBeNull();
    expect(after!.emailSuppressionReason).toBe("hard_bounce");
    expect(after!.emailOptedOut).toBe(false);
  });

  it("🔴 a suppressed client still gets their booking confirmations", async () => {
    // Marketing only. A bounce today may be a full mailbox tomorrow, and
    // silently ceasing to tell somebody when their own appointment is would be
    // a far worse failure than a wasted send.
    const c = await makeClient();
    await blastAndCollect();
    await requireDelivery(await messageIdFor(c.id));
    await applyEmailEvent({
      messageId: await messageIdFor(c.id),
      event: "email.bounced",
      svixId: randomToken(8),
    });

    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true, optedOut: true, emailOptedOut: true },
    });
    // Nothing that gates transactional mail or SMS was touched: the ONLY thing
    // reading emailSuppressedAt is the broadcast audience.
    expect(after!.emailSuppressedAt).not.toBeNull();
    expect(after!.optedOut).toBe(false);
    expect(after!.emailOptedOut).toBe(false);
  });
});
