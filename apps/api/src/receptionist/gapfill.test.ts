import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests, type PushSender } from "../messaging/push.js";
import type { MessageProvider } from "../messaging/provider.js";
import { cancelAppointment } from "../engines/appointmentPromotion.js";
import {
  __setModelClientForTests,
  type ReceptionistModelClient,
} from "./agent.js";
import { encodeSlotId } from "./tools.js";
import { runGapFill, type GapFillInput } from "./gapfill.js";
import { processInboundText } from "./inbound.js";

/**
 * PROACTIVE gap-fill: a freed slot goes to the right client (loyalty-due >
 * overdue > waitlist) as ONE held offer over SMS, with the full marketing
 * rails (consent, quiet hours, cap, 72h suppression). Accepting the offer
 * books the already-held slot in place.
 */

const NOW = new Date("2026-06-01T16:00:00Z"); // Monday, 12:00 EDT (not quiet)
const QUIET_NOW = new Date("2026-06-01T06:00:00Z"); // 02:00 EDT (quiet hours)
const SLOT_AT = new Date("2026-06-03T18:00:00Z"); // Wed, 14:00 EDT

let sms: { to: string; body: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sms.push(input);
    return { sid: `SM${sms.length}`, status: "queued" };
  },
};
const fakePush: PushSender = {
  async send() {
    /* no-op */
  },
};

function textMsg(text: string): Anthropic.Messages.Message {
  return {
    id: `msg_${randomToken(6)}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message;
}

function toolUseMsg(
  calls: { id: string; name: string; input: unknown }[],
): Anthropic.Messages.Message {
  return {
    id: `msg_${randomToken(6)}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content: calls.map((c) => ({
      type: "tool_use",
      id: c.id,
      name: c.name,
      input: c.input,
    })),
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message;
}

function scripted(responses: Anthropic.Messages.Message[]): ReceptionistModelClient {
  const queue = [...responses];
  return {
    async create() {
      const next = queue.shift();
      if (!next) throw new Error("scripted model exhausted");
      return next;
    },
  };
}

let userId: string;

function freshPhone(): string {
  return `+1556${Math.floor(1000000 + Math.random() * 8999999)}`;
}

interface Seeded {
  shopId: string;
  staffId: string;
  serviceId: string;
  input: GapFillInput;
}

async function seedShop(dailySendCap = 50): Promise<Seeded> {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Gap Cuts",
      slug: `gap-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      compAccess: true,
      dailySendCap,
      receptionistEnabled: true,
      receptionistCompAccess: true,
      receptionistTermsAcceptedAt: NOW,
      waitlistEnabled: true,
      notifyPhone: null,
    },
    select: { id: true },
  });
  const staff = await prisma.staff.create({ data: { shopId: shop.id, name: "Drick" } });
  const service = await prisma.service.create({
    data: { shopId: shop.id, name: "Cut", durationMin: 30, price: 35 },
  });
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId: shop.id, staffId: staff.id, weekday, startMin: 0, endMin: 1439 },
    });
  }
  await prisma.serviceStaff.create({
    data: { shopId: shop.id, serviceId: service.id, staffId: staff.id },
  });
  // The just-canceled appointment whose slot is being offered.
  const canceled = await prisma.appointment.create({
    data: {
      shopId: shop.id,
      staffId: staff.id,
      serviceId: service.id,
      firstName: "Gone",
      status: "CANCELED",
      canceledAt: NOW,
      startsAt: SLOT_AT,
      endsAt: new Date(SLOT_AT.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return {
    shopId: shop.id,
    staffId: staff.id,
    serviceId: service.id,
    input: {
      shop: { id: shop.id, name: "Gap Cuts", timezone: "America/New_York", dailySendCap },
      appt: {
        id: canceled.id,
        staffId: staff.id,
        serviceId: service.id,
        startsAt: SLOT_AT,
        serviceName: "Cut",
        staffName: "Drick",
      },
      now: NOW,
    },
  };
}

async function seedClient(
  shopId: string,
  opts: Partial<{
    firstName: string;
    loyaltyTier: "BRONZE" | "SILVER" | "GOLD" | null;
    nextExpectedAt: Date | null;
    optedOut: boolean;
    smsConsentAt: Date | null;
  }> = {},
): Promise<{ id: string; phone: string }> {
  const phone = freshPhone();
  const c = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `k-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: opts.firstName ?? "Jamal",
      phone,
      optedOut: opts.optedOut ?? false,
      smsConsentAt: opts.smsConsentAt === undefined ? NOW : opts.smsConsentAt,
      loyaltyTier: opts.loyaltyTier ?? null,
      nextExpectedAt: opts.nextExpectedAt === undefined ? null : opts.nextExpectedAt,
      source: "manual",
    },
    select: { id: true },
  });
  return { id: c.id, phone };
}

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;
const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests(fakePush);
  const user = await prisma.user.create({
    data: { email: `gap-${randomToken(6)}@test.chairback`, name: "Gap Tester" },
    select: { id: true },
  });
  userId = user.id;
});

afterAll(() => {
  process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  __setModelClientForTests(null);
});

beforeEach(() => {
  sms = [];
  __setModelClientForTests(null);
});

describe("runGapFill", () => {
  it("offers the freed slot to the loyalty-due client first, with a 60-min hold + receptionist Nudge", async () => {
    const seeded = await seedShop();
    // Three candidates in reverse priority order of creation:
    await seedClient(seeded.shopId, {
      firstName: "OverdueOnly",
      nextExpectedAt: new Date(NOW.getTime() - 7 * 86400_000),
    });
    const loyal = await seedClient(seeded.shopId, {
      firstName: "Jamal",
      loyaltyTier: "GOLD",
      nextExpectedAt: new Date(NOW.getTime() + 86400_000), // due by the slot date
    });
    const waitlisted = await seedClient(seeded.shopId, { firstName: "Wanda" });
    await prisma.waitlistEntry.create({
      data: {
        shopId: seeded.shopId,
        firstName: "Wanda",
        phone: waitlisted.phone,
        status: "WAITING",
      },
    });
    __setModelClientForTests(
      scripted([textMsg("hey Jamal - a 2:00 just opened up Wednesday w/ Drick if you're due")]),
    );

    await runGapFill(seeded.input);

    // The offer went to the LOYALTY client, once.
    expect(sms).toHaveLength(1);
    expect(sms[0]!.to).toBe(loyal.phone);
    expect(sms[0]!.body).toContain("Jamal");

    // A 60-minute hold exists for them on the freed slot.
    const hold = await prisma.appointment.findFirst({
      where: {
        shopId: seeded.shopId,
        startsAt: SLOT_AT,
        status: "PENDING",
        clientId: loyal.id,
      },
    });
    expect(hold).not.toBeNull();
    expect(hold!.bookedVia).toBe("receptionist");
    expect(hold!.holdExpiresAt!.getTime()).toBe(NOW.getTime() + 60 * 60_000);

    // Audited on the ledger as a PROACTIVE send (counts against the cap).
    const nudge = await prisma.nudge.findFirst({
      where: { shopId: seeded.shopId, clientId: loyal.id, kind: "receptionist" },
    });
    expect(nudge?.status).toBe("SENT");

    // Thread seeded: system_note (with the held slot_id) + the assistant offer.
    const convo = await prisma.receptionistConversation.findFirst({
      where: { shopId: seeded.shopId, phone: loyal.phone },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    expect(convo).not.toBeNull();
    const slotId = encodeSlotId(seeded.staffId, seeded.serviceId, SLOT_AT);
    expect(convo!.messages[0]!.role).toBe("system_note");
    expect(convo!.messages[0]!.content).toContain(slotId);
    expect(convo!.messages[1]!.role).toBe("assistant");
  });

  it("accepting the offer books the ALREADY-HELD slot in place (the full round-trip)", async () => {
    const seeded = await seedShop();
    const loyal = await seedClient(seeded.shopId, {
      firstName: "Jamal",
      loyaltyTier: "GOLD",
      nextExpectedAt: new Date(NOW.getTime() + 86400_000),
    });
    const slotId = encodeSlotId(seeded.staffId, seeded.serviceId, SLOT_AT);
    __setModelClientForTests(scripted([textMsg("a 2:00 Wed just opened up - want it?")]));
    await runGapFill(seeded.input);
    expect(sms).toHaveLength(1);

    // Client replies "yeah book it" -> model books with the held slot_id from
    // the thread's context note.
    sms = [];
    __setModelClientForTests(
      scripted([
        toolUseMsg([{ id: "tu_1", name: "book_appointment", input: { slot_id: slotId } }]),
        textMsg("got you, Wed 2:00. see you then"),
      ]),
    );
    await processInboundText({ phone: loyal.phone, text: "yeah book it", now: NOW });

    expect(sms).toHaveLength(1); // the confirmation reply
    const row = await prisma.appointment.findFirst({
      where: { shopId: seeded.shopId, startsAt: SLOT_AT, clientId: loyal.id },
    });
    expect(row!.status).toBe("BOOKED");
    expect(row!.holdExpiresAt).toBeNull();
    expect(row!.confirmationSentAt).not.toBeNull();
  });

  it("falls through to the waitlist when nobody is due/overdue", async () => {
    const seeded = await seedShop();
    const waitlisted = await seedClient(seeded.shopId, { firstName: "Wanda" });
    await prisma.waitlistEntry.create({
      data: {
        shopId: seeded.shopId,
        firstName: "Wanda",
        phone: waitlisted.phone,
        status: "WAITING",
      },
    });
    __setModelClientForTests(scripted([textMsg("hey Wanda - a spot opened Wed 2:00")]));

    await runGapFill(seeded.input);

    expect(sms).toHaveLength(1);
    expect(sms[0]!.to).toBe(waitlisted.phone);
  });

  it("enforces the marketing rails: consent, opt-out, quiet hours, cap, 72h suppression, existing booking", async () => {
    // No-consent + opted-out candidates -> nobody to offer to.
    const s1 = await seedShop();
    await seedClient(s1.shopId, {
      loyaltyTier: "GOLD",
      nextExpectedAt: NOW,
      smsConsentAt: null,
    });
    await seedClient(s1.shopId, {
      loyaltyTier: "GOLD",
      nextExpectedAt: NOW,
      optedOut: true,
    });
    __setModelClientForTests(scripted([textMsg("never sent")]));
    await runGapFill(s1.input);
    expect(sms).toHaveLength(0);
    expect(
      await prisma.appointment.count({
        where: { shopId: s1.shopId, status: "PENDING" },
      }),
    ).toBe(0); // no hold placed either

    // Quiet hours -> skip entirely.
    const s2 = await seedShop();
    await seedClient(s2.shopId, { loyaltyTier: "GOLD", nextExpectedAt: NOW });
    await runGapFill({ ...s2.input, now: QUIET_NOW });
    expect(sms).toHaveLength(0);

    // Cap exhausted -> skip.
    const s3 = await seedShop(0);
    await seedClient(s3.shopId, { loyaltyTier: "GOLD", nextExpectedAt: NOW });
    await runGapFill(s3.input);
    expect(sms).toHaveLength(0);

    // 72h suppression: a recent receptionist offer muzzles a new one.
    const s4 = await seedShop();
    const c4 = await seedClient(s4.shopId, { loyaltyTier: "GOLD", nextExpectedAt: NOW });
    await prisma.nudge.create({
      data: {
        shopId: s4.shopId,
        clientId: c4.id,
        channel: "SMS",
        status: "SENT",
        kind: "receptionist",
        body: "earlier offer",
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
      },
    });
    await runGapFill(s4.input);
    expect(sms).toHaveLength(0);

    // Already has an upcoming appointment -> skip.
    const s5 = await seedShop();
    const c5 = await seedClient(s5.shopId, { loyaltyTier: "GOLD", nextExpectedAt: NOW });
    await prisma.appointment.create({
      data: {
        shopId: s5.shopId,
        staffId: s5.staffId,
        serviceId: s5.serviceId,
        clientId: c5.id,
        firstName: "Booked",
        status: "BOOKED",
        startsAt: new Date(NOW.getTime() + 5 * 86400_000),
        endsAt: new Date(NOW.getTime() + 5 * 86400_000 + 30 * 60_000),
        manageToken: randomToken(),
      },
    });
    await runGapFill(s5.input);
    expect(sms).toHaveLength(0);
  });
});
