import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";
import { armBackgroundWorkTracking, settleBackgroundWork } from "../backgroundWork.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";

/**
 * A TIP JUST PAID: the client's receipt and ONE push to whoever did the visit.
 *
 * Every path that can make a tip succeeded runs through applyIntentSnapshot
 * (the webhook, the page's refresh, resume, retire, the sweep, the
 * reconciler), and several of them see the same tip. The announcement must
 * still happen exactly once - a tip announced twice reads as two tips.
 *
 * Only the push TRANSPORT is faked (sendPushToUser); everything that decides
 * who is told, and what, runs for real.
 */

const pushes = vi.hoisted(() => [] as Array<{ userId: string; shopId: string; payload: Record<string, unknown> }>);
vi.mock("../messaging/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../messaging/push.js")>()),
  sendPushToUser: vi.fn(async (p: { userId: string; shopId: string; payload: Record<string, unknown> }) => {
    pushes.push(p);
    return { sent: 1, pruned: 0, failed: 0, anyDelivered: true };
  }),
}));

const { applyIntentSnapshot } = await import("../billing/payments.js");
const { announceTipPaid } = await import("./tipPaid.js");
const { deliverTipReceiptIntent, TIP_RECEIPT_KIND, tipReceiptKey } = await import("./tipEmails.js");
const { repairUnannouncedTips } = await import("../engines/tipRequests.js");

const NOW = new Date();
let ownerId = "";
let shopId = "";
let staffId = "";
let serviceId = "";
let clientId = "";
const ACCT = `acct_test_${randomToken(6)}`;
const clientEmail = `paid-${randomToken(6)}@test.local`.toLowerCase();
const sent: SendEmailInput[] = [];
const savedEnv = { key: process.env.STRIPE_SECRET_KEY, hook: process.env.STRIPE_CONNECT_WEBHOOK_SECRET };

async function visit(over: Partial<{ staffId: string; email: string | null; clientId: string }> = {}) {
  const endsAt = new Date(NOW.getTime() - 90 * 60_000);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId: over.staffId ?? staffId,
      serviceId,
      clientId: over.clientId ?? clientId,
      firstName: "Riley",
      email: over.email === undefined ? null : over.email,
      status: "COMPLETED",
      completedByShop: true,
      startsAt: new Date(endsAt.getTime() - 30 * 60_000),
      endsAt,
      manageToken: randomToken(20),
      priceAtBooking: new Prisma.Decimal("40.00"),
    },
  });
}

/** A tip the client has started: an open intent on the visit. */
async function tip(appointmentId: string, over: Partial<{ purpose: string; amount: number; mode: "ahead" | "hold" }> = {}) {
  return prisma.payment.create({
    data: {
      shopId,
      appointmentId,
      purpose: over.purpose ?? "tip",
      stripePaymentIntentId: `pi_paid_${randomToken(10)}`,
      stripeConnectAccountId: ACCT,
      mode: over.mode ?? "ahead",
      amount: over.amount ?? 800,
      status: "requires_payment_method",
    },
  });
}

/** What Stripe says when the client's tip went through. */
function succeeded(p: { id: string; stripePaymentIntentId: string; amount: number }) {
  return {
    id: p.stripePaymentIntentId,
    status: "succeeded" as const,
    amount_received: p.amount,
    latest_charge: `ch_${p.stripePaymentIntentId}`,
    metadata: { paymentId: p.id },
  };
}

const receipts = (paymentId: string) =>
  prisma.emailIntent.findMany({ where: { shopId, idempotencyKey: tipReceiptKey(paymentId) } });

async function deliverReceipt(paymentId: string) {
  const [intent, ...more] = await receipts(paymentId);
  expect(more).toHaveLength(0);
  const claimToken = `test_${randomToken(12)}`;
  await prisma.emailIntent.update({
    where: { id: intent!.id },
    data: { claimToken, claimedAt: new Date(), nextAttemptAt: null },
  });
  const outcome = await deliverTipReceiptIntent({ intentId: intent!.id, claimToken });
  const row = await prisma.emailIntent.findUniqueOrThrow({ where: { id: intent!.id } });
  return { outcome, row };
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  armBackgroundWorkTracking();
  const owner = await prisma.user.create({
    data: { email: `paid-owner-${randomToken(6)}@test.local`, passwordHash: "x", name: "O" },
  });
  ownerId = owner.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId,
      name: "Tip Paid Studio",
      webhookSecret: randomToken(),
      bookingMode: "native",
      onlineTipsEnabled: true,
      tipPolicy: "not_included",
      connectChargesEnabled: true,
      stripeConnectAccountId: ACCT,
      compAccess: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  // Sam has no account of their own: their tips are told to the owner.
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Lineup", durationMin: 30, price: 40 }, select: { id: true } })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { shopId, acuityClientKey: `paid-${randomToken(8)}`, magicToken: randomToken(), firstName: "Riley", email: clientEmail },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  // A push an earlier test started must land in THAT test, not this one.
  await settleBackgroundWork();
  pushes.length = 0;
  sent.length = 0;
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: `em_${randomToken(8)}`, status: "sent" };
  });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  process.env.STRIPE_SECRET_KEY = savedEnv.key;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = savedEnv.hook;
  if (savedEnv.key === undefined) delete process.env.STRIPE_SECRET_KEY;
  if (savedEnv.hook === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
});

describe("announced once, whichever path sees it first", () => {
  it("🔴 the page's refresh, the webhook, a replay and a re-armed event: ONE receipt, ONE push", async () => {
    const appt = await visit();
    const p = await tip(appt.id);
    const pi = succeeded(p);
    await applyIntentSnapshot(pi, `tip-status:${pi.id}:succeeded`);
    await applyIntentSnapshot(pi, "evt_tip_1");
    await applyIntentSnapshot(pi, "evt_tip_1"); // Stripe redelivers
    await applyIntentSnapshot(pi, "evt_tip_2"); // a re-armed event
    await settleBackgroundWork();

    expect(await receipts(p.id)).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.tipAnnouncedAt).not.toBeNull();
  });

  it("🔴 two at once announce ONCE (the claim is the guard)", async () => {
    const appt = await visit();
    const p = await tip(appt.id);
    await prisma.payment.update({ where: { id: p.id }, data: { status: "succeeded", capturedAmount: 800 } });
    const go = () => announceTipPaid({ paymentId: p.id });
    const { results, settledEarly } = await raceBehindRowLock<boolean>("Payment", p.id, [go, go]);
    await settleBackgroundWork();
    expect(settledEarly).toBe(0);
    expect(winners(results).filter(Boolean)).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(await receipts(p.id)).toHaveLength(1);
  });

  it("a booking's or a checkout's payment announces nothing", async () => {
    for (const purpose of ["booking", "service_checkout"]) {
      const appt = await visit();
      const p = await tip(appt.id, { purpose });
      await applyIntentSnapshot(succeeded(p), `evt_${purpose}_${randomToken(6)}`);
      await settleBackgroundWork();
      expect(await receipts(p.id), purpose).toHaveLength(0);
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.tipAnnouncedAt, purpose).toBeNull();
    }
    expect(pushes).toHaveLength(0);
  });

  it("a tip refunded in full before anyone saw it is nothing to announce; a partly refunded one still is", async () => {
    const full = await tip((await visit()).id);
    await prisma.payment.update({
      where: { id: full.id },
      data: { status: "refunded", capturedAmount: 800, refundedAmount: 800 },
    });
    expect(await announceTipPaid({ paymentId: full.id })).toBe(false);

    const part = await tip((await visit()).id);
    await prisma.payment.update({
      where: { id: part.id },
      data: { status: "partially_refunded", capturedAmount: 800, refundedAmount: 300 },
    });
    expect(await announceTipPaid({ paymentId: part.id })).toBe(true);
    await settleBackgroundWork();
    expect(pushes).toHaveLength(1);
  });

  it("no address for the client: the push still goes, and the receipt is FAILED in the ledger", async () => {
    const noEmail = await prisma.client.create({
      data: { shopId, acuityClientKey: `paid-${randomToken(8)}`, magicToken: randomToken(), firstName: "Riley" },
      select: { id: true },
    });
    const appt = await visit({ clientId: noEmail.id });
    const p = await tip(appt.id);
    await applyIntentSnapshot(succeeded(p), `evt_${randomToken(6)}`);
    await settleBackgroundWork();
    expect(pushes).toHaveLength(1);
    const { outcome, row } = await deliverReceipt(p.id);
    expect(outcome).toBe("skipped");
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBe("no_address");
  });

  it("🔴 the self-heal announces a paid tip nobody announced, once", async () => {
    const appt = await visit();
    const p = await tip(appt.id);
    await prisma.payment.update({ where: { id: p.id }, data: { status: "succeeded", capturedAmount: 800 } });
    // Not yet: the live path may still be on its way.
    expect(await repairUnannouncedTips(new Date(), { shopIds: [shopId] })).toBe(0);
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await repairUnannouncedTips(later, { shopIds: [shopId] })).toBe(1);
    expect(await repairUnannouncedTips(later, { shopIds: [shopId] })).toBe(0);
    await settleBackgroundWork();
    expect(pushes).toHaveLength(1);
    expect(await receipts(p.id)).toHaveLength(1);
  });
});

describe("the receipt", () => {
  it("🔴 says what they paid, to whom, with a reference - and names no card", async () => {
    const appt = await visit();
    const p = await tip(appt.id, { amount: 1250 });
    await applyIntentSnapshot(succeeded({ ...p, amount: 1250 }), `evt_${randomToken(6)}`);
    const { outcome, row } = await deliverReceipt(p.id);
    expect(outcome).toBe("sent");
    expect(row.status).toBe("SENT");
    const mail = sent[0]!;
    expect(mail.to).toBe(clientEmail);
    expect(mail.subject).toBe("Receipt: $12.50 tip to Tip Paid Studio");
    expect(mail.idempotencyKey).toBe(tipReceiptKey(p.id));
    expect(mail.text).toContain(p.stripePaymentIntentId.slice(-8).toUpperCase());
    expect(mail.text).toContain(`/book/manage/${appt.manageToken}`);
    expect(mail.text).not.toContain("?tip=1");
    for (const body of [mail.subject, mail.text, mail.html!]) {
      expect(body).not.toMatch(/Visa|Mastercard|ending in|Reschedule|reply|—|\b(barbers?|cuts?|haircuts?|chairs?)\b/i);
    }
  });

  it("refunded in full between queueing and sending: no receipt goes", async () => {
    const appt = await visit();
    const p = await tip(appt.id);
    await applyIntentSnapshot(succeeded(p), `evt_${randomToken(6)}`);
    await prisma.payment.update({ where: { id: p.id }, data: { status: "refunded", refundedAmount: 800 } });
    const { outcome, row } = await deliverReceipt(p.id);
    expect(outcome).toBe("superseded");
    expect(row.lastError).toBe("not_collected");
    expect(sent).toHaveLength(0);
  });

  it("🔴 money already taken ALWAYS gets its receipt: tips switched off or the window closed since", async () => {
    const appt = await visit();
    const p = await tip(appt.id);
    await applyIntentSnapshot(succeeded(p), `evt_${randomToken(6)}`);
    await prisma.shop.update({ where: { id: shopId }, data: { onlineTipsEnabled: false } });
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { endsAt: new Date(NOW.getTime() - 9 * 24 * 3600_000) },
    });
    try {
      const { outcome } = await deliverReceipt(p.id);
      expect(outcome).toBe("sent");
      expect(sent).toHaveLength(1);
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { onlineTipsEnabled: true } });
    }
  });

  it("is its own outbox kind", async () => {
    const appt = await visit();
    const p = await tip(appt.id);
    await applyIntentSnapshot(succeeded(p), `evt_${randomToken(6)}`);
    const [intent] = await receipts(p.id);
    expect(intent!.kind).toBe(TIP_RECEIPT_KIND);
    expect(intent!.appointmentId).toBe(appt.id);
  });
});

describe("the push", () => {
  it("staff with no account of their own: it goes to the owner, naming them", async () => {
    const appt = await visit();
    const p = await tip(appt.id);
    await applyIntentSnapshot(succeeded(p), `evt_${randomToken(6)}`);
    await settleBackgroundWork();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.userId).toBe(ownerId);
    expect(pushes[0]!.payload.title).toBe("New tip");
    expect(pushes[0]!.payload.body).toBe("Riley left Sam a $8.00 tip.");
    expect(String(pushes[0]!.payload.url)).toContain(`appointment=${appt.id}`);
    expect(pushes[0]!.payload.tag).toBe(`tip-${appt.id}`);
  });

  it("🔴 staff with their own seat: it goes to THEM, says 'you', and links where a staff seat can go", async () => {
    const user = await prisma.user.create({
      data: { email: `paid-staff-${randomToken(6)}@test.local`, passwordHash: "x", name: "Alex" },
    });
    const staff = await prisma.staff.create({ data: { shopId, name: "Alex", userId: user.id }, select: { id: true } });
    await prisma.shopMember.create({ data: { shopId, userId: user.id, role: "BARBER", staffId: staff.id } });
    try {
      const appt = await visit({ staffId: staff.id });
      const p = await tip(appt.id);
      await applyIntentSnapshot(succeeded(p), `evt_${randomToken(6)}`);
      await settleBackgroundWork();
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.userId).toBe(user.id);
      expect(pushes[0]!.payload.body).toBe("Riley left you a $8.00 tip.");
      // The appointments manager is a manager's page; the dashboard home is not.
      expect(String(pushes[0]!.payload.url)).toMatch(/\/dashboard$/);
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  it("their push switch off: nothing", async () => {
    await prisma.barberNotifyPref.create({ data: { shopId, userId: ownerId, pushEnabled: false } });
    try {
      const appt = await visit();
      const p = await tip(appt.id);
      await applyIntentSnapshot(succeeded(p), `evt_${randomToken(6)}`);
      await settleBackgroundWork();
      expect(pushes).toHaveLength(0);
      // The client's receipt does not depend on the staff member's switch.
      expect(await receipts(p.id)).toHaveLength(1);
    } finally {
      await prisma.barberNotifyPref.deleteMany({ where: { shopId, userId: ownerId } });
    }
  });

  it("🔴 a push and nothing else: no email reaches the shop, texting on or off", async () => {
    const before = process.env.SMS_ENABLED;
    try {
      for (const sms of ["true", "false"]) {
        process.env.SMS_ENABLED = sms;
        __resetEnvCacheForTests();
        pushes.length = 0;
        const appt = await visit();
        const p = await tip(appt.id);
        await applyIntentSnapshot(succeeded(p), `evt_${randomToken(6)}`);
        await settleBackgroundWork();
        expect(pushes, sms).toHaveLength(1);
        // The only email this produced is the client's receipt, still queued.
        expect(sent, sms).toHaveLength(0);
        const intents = await prisma.emailIntent.findMany({ where: { shopId, appointmentId: appt.id } });
        expect(intents.map((i) => i.kind), sms).toEqual([TIP_RECEIPT_KIND]);
      }
    } finally {
      process.env.SMS_ENABLED = before;
      __resetEnvCacheForTests();
    }
  });
});
