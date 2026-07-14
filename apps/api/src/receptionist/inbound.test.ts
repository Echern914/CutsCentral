import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests, type PushSender } from "../messaging/push.js";
import type { MessageProvider } from "../messaging/provider.js";
import {
  __setModelClientForTests,
  type ReceptionistModelClient,
} from "./agent.js";
import { hasLiveConversation, processInboundText } from "./inbound.js";
import { closeConversationsForPhone } from "./conversation.js";
import { RECEPTIONIST_REPLY_LIMITS } from "./replyCap.js";

/**
 * End-to-end inbound pipeline with a SCRIPTED model (no API key, fully
 * deterministic): fake inbound text -> shop routing -> prompt + history ->
 * scripted tool calls against the REAL slot engine/DB -> captured outbound SMS
 * + persisted audit trail.
 */

const NOW = new Date("2026-06-01T16:00:00Z"); // Monday, 12:00 EDT

let sms: { to: string; body: string; from?: string }[] = [];
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

// --- scripted model helpers -------------------------------------------------

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

/** Pops scripted responses in order; captures every request it was sent. */
function scriptedModel(responses: Anthropic.Messages.Message[]): ReceptionistModelClient & {
  requests: Anthropic.Messages.MessageCreateParamsNonStreaming[];
} {
  const queue = [...responses];
  const requests: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    async create(params) {
      requests.push(params);
      const next = queue.shift();
      if (!next) throw new Error("scripted model exhausted");
      return next;
    },
  };
}

/** A model that never stops calling tools (runaway-loop test). */
function runawayModel(): ReceptionistModelClient {
  let i = 0;
  return {
    async create() {
      i += 1;
      return toolUseMsg([{ id: `tu_${i}`, name: "get_client_history", input: {} }]);
    },
  };
}

// --- seeding ----------------------------------------------------------------

let userId: string;

function freshPhone(): string {
  return `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
}

async function makeShop(
  overrides: Partial<{
    receptionistEnabled: boolean;
    receptionistTermsAcceptedAt: Date | null;
    notifyPhone: string | null;
    twilioNumber: string | null;
  }> = {},
): Promise<{ id: string }> {
  return prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Recept Cuts",
      slug: `recept-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      compAccess: true,
      receptionistEnabled: overrides.receptionistEnabled ?? true,
      receptionistCompAccess: true,
      receptionistTermsAcceptedAt:
        overrides.receptionistTermsAcceptedAt === undefined
          ? NOW
          : overrides.receptionistTermsAcceptedAt,
      notifyPhone: overrides.notifyPhone === undefined ? "+13025550111" : overrides.notifyPhone,
      twilioNumber: overrides.twilioNumber ?? null,
    },
    select: { id: true },
  });
}

async function makeBookable(shopId: string): Promise<{ staffId: string; serviceId: string }> {
  const staff = await prisma.staff.create({ data: { shopId, name: "Drick" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 35 },
  });
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId: staff.id, weekday, startMin: 0, endMin: 1439 },
    });
  }
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: service.id, staffId: staff.id },
  });
  return { staffId: staff.id, serviceId: service.id };
}

async function makeClient(
  shopId: string,
  phone: string,
  opts: Partial<{
    optedOut: boolean;
    smsConsentAt: Date | null;
    lastVisitAt: Date | null;
  }> = {},
): Promise<{ id: string }> {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `key-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Marcus",
      phone,
      optedOut: opts.optedOut ?? false,
      smsConsentAt: opts.smsConsentAt === undefined ? NOW : opts.smsConsentAt,
      lastVisitAt: opts.lastVisitAt === undefined ? null : opts.lastVisitAt,
      source: "manual",
    },
    select: { id: true },
  });
}

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;
const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  process.env.ANTHROPIC_API_KEY = "test-key-never-used"; // scripted client intercepts
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests(fakePush);
  const user = await prisma.user.create({
    data: { email: `recept-${randomToken(6)}@test.chairback`, name: "Recept Tester" },
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

// --- tests --------------------------------------------------------------

describe("processInboundText", () => {
  it("answers a known client end-to-end: tools run against the real slot engine, reply lands as SMS + Nudge + audit rows", async () => {
    const shop = await makeShop();
    await makeBookable(shop.id);
    const phone = freshPhone();
    await makeClient(shop.id, phone);

    const model = scriptedModel([
      toolUseMsg([
        { id: "tu_1", name: "get_client_history", input: {} },
        {
          id: "tu_2",
          name: "check_availability",
          input: { service: "Cut", from_date: "2026-06-02" },
        },
      ]),
      textMsg("hey Marcus, got Tue 10 or Tue 2 with Drick - either work?"),
    ]);
    __setModelClientForTests(model);

    await processInboundText({ phone, text: "you got anything this week", now: NOW });

    // The reply went out over SMS to the client.
    expect(sms).toHaveLength(1);
    expect(sms[0]!.to).toBe(phone);
    expect(sms[0]!.body).toContain("Tue 10 or Tue 2");

    // Audit trail: conversation + user/assistant rows + tool calls persisted.
    const convo = await prisma.receptionistConversation.findFirst({
      where: { shopId: shop.id, phone },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    expect(convo).not.toBeNull();
    expect(convo!.status).toBe("active");
    const roles = convo!.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    const calls = convo!.messages[1]!.toolCalls as {
      name: string;
      isError: boolean;
      result: string;
    }[];
    expect(calls.map((c) => c.name).sort()).toEqual([
      "check_availability",
      "get_client_history",
    ]);
    expect(calls.every((c) => !c.isError)).toBe(true);
    // The availability tool returned REAL slots (full-week hours -> open Tue).
    const avail = calls.find((c) => c.name === "check_availability")!;
    expect(avail.result).toContain("slot_id");

    // Ledger: one receptionist_reply Nudge, SENT.
    const nudges = await prisma.nudge.findMany({ where: { shopId: shop.id } });
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.kind).toBe("receptionist_reply");
    expect(nudges[0]!.status).toBe("SENT");

    // The system prompt was the rendered file (persona from ai/, not code).
    expect(model.requests[0]!.system).toBeDefined();
    const sys = model.requests[0]!.system as { type: string; text: string }[];
    expect(sys[0]!.text).toContain("Recept Cuts");
    expect(sys[0]!.text).toContain("front desk");
  });

  it("surfaces active holds in the per-turn context so an accept books the held slot", async () => {
    const shop = await makeShop();
    const { staffId, serviceId } = await makeBookable(shop.id);
    const phone = freshPhone();
    const client = await makeClient(shop.id, phone);

    // The hold a previous turn placed while offering this time. History replays
    // text only, so the context note is the model's ONLY way to recover it.
    const startsAt = new Date("2026-06-02T18:00:00Z"); // Tue 2:00 PM EDT
    await prisma.appointment.create({
      data: {
        shopId: shop.id,
        staffId,
        serviceId,
        clientId: client.id,
        firstName: "Marcus",
        phone,
        status: "PENDING",
        holdExpiresAt: new Date(NOW.getTime() + 9 * 60_000),
        bookedVia: "receptionist",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
    });

    const slotId = `${staffId}~${serviceId}~${startsAt.toISOString()}`;
    const model = scriptedModel([
      toolUseMsg([{ id: "tu_1", name: "book_appointment", input: { slot_id: slotId } }]),
      textMsg("locked in - Tue 2:00 with Drick"),
    ]);
    __setModelClientForTests(model);

    await processInboundText({ phone, text: "yeah", now: NOW });

    // The context turn lists the hold: time, barber, and the exact slot_id.
    const first = model.requests[0]!.messages[0]!;
    expect(first.role).toBe("user");
    expect(first.content).toContain("HOLD");
    expect(first.content).toContain(slotId);
    expect(first.content).toContain("Drick");

    // Booking the held slot_id flipped the SAME row to BOOKED - no new row,
    // no leaked PENDING hold.
    const appts = await prisma.appointment.findMany({ where: { shopId: shop.id } });
    expect(appts).toHaveLength(1);
    expect(appts[0]!.status).toBe("BOOKED");
    expect(appts[0]!.holdExpiresAt).toBeNull();
    expect(sms).toHaveLength(1);
  });

  it("booking one held slot releases the client's alternate holds in the same tx", async () => {
    const shop = await makeShop();
    const { staffId, serviceId } = await makeBookable(shop.id);
    const phone = freshPhone();
    const client = await makeClient(shop.id, phone);

    const mkHold = (startsAt: Date) =>
      prisma.appointment.create({
        data: {
          shopId: shop.id,
          staffId,
          serviceId,
          clientId: client.id,
          firstName: "Marcus",
          phone,
          status: "PENDING",
          holdExpiresAt: new Date(NOW.getTime() + 9 * 60_000),
          bookedVia: "receptionist",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          manageToken: randomToken(),
        },
        select: { id: true },
      });
    const target = await mkHold(new Date("2026-06-02T18:00:00Z"));
    const alternate = await mkHold(new Date("2026-06-02T19:00:00Z"));

    const slotId = `${staffId}~${serviceId}~2026-06-02T18:00:00.000Z`;
    __setModelClientForTests(
      scriptedModel([
        toolUseMsg([{ id: "tu_1", name: "book_appointment", input: { slot_id: slotId } }]),
        textMsg("2:00 Tuesday locked in"),
      ]),
    );

    await processInboundText({ phone, text: "the earlier one", now: NOW });

    const rows = await prisma.appointment.findMany({
      where: { shopId: shop.id },
      select: { id: true, status: true, holdExpiresAt: true, canceledAt: true },
    });
    const booked = rows.find((r) => r.id === target.id)!;
    const released = rows.find((r) => r.id === alternate.id)!;
    expect(booked.status).toBe("BOOKED");
    expect(booked.holdExpiresAt).toBeNull();
    expect(released.status).toBe("CANCELED");
    expect(released.canceledAt).not.toBeNull();
  });

  it("context lists upcoming appointment_ids; reschedule into the client's own held slot works", async () => {
    const shop = await makeShop();
    const { staffId, serviceId } = await makeBookable(shop.id);
    const phone = freshPhone();
    const client = await makeClient(shop.id, phone);

    // An existing booked appointment (Tue 2:00)...
    const appt = await prisma.appointment.create({
      data: {
        shopId: shop.id,
        staffId,
        serviceId,
        clientId: client.id,
        firstName: "Marcus",
        phone,
        status: "BOOKED",
        startsAt: new Date("2026-06-02T18:00:00Z"),
        endsAt: new Date("2026-06-02T18:30:00Z"),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    // ...and the hold a previous turn placed on the proposed new time (Sat 3:00).
    const newStart = new Date("2026-06-06T19:00:00Z");
    const hold = await prisma.appointment.create({
      data: {
        shopId: shop.id,
        staffId,
        serviceId,
        clientId: client.id,
        firstName: "Marcus",
        phone,
        status: "PENDING",
        holdExpiresAt: new Date(NOW.getTime() + 9 * 60_000),
        bookedVia: "receptionist",
        startsAt: newStart,
        endsAt: new Date(newStart.getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
      select: { id: true },
    });

    const newSlotId = `${staffId}~${serviceId}~${newStart.toISOString()}`;
    const model = scriptedModel([
      toolUseMsg([
        {
          id: "tu_1",
          name: "reschedule",
          input: { appointment_id: appt.id, new_slot_id: newSlotId },
        },
      ]),
      textMsg("moved you to Sat 3:00"),
    ]);
    __setModelClientForTests(model);

    await processInboundText({ phone, text: "perfect", now: NOW });

    // Fix A: the context turn handed the model the appointment_id.
    const first = model.requests[0]!.messages[0]!;
    expect(first.content).toContain(`appointment_id ${appt.id}`);

    // Fix C: the move landed even though the client's own hold sat on the
    // target slot - the hold was consumed, not treated as a conflict.
    const moved = await prisma.appointment.findUnique({ where: { id: appt.id } });
    expect(moved!.status).toBe("BOOKED");
    expect(moved!.startsAt.toISOString()).toBe(newStart.toISOString());
    const consumed = await prisma.appointment.findUnique({ where: { id: hold.id } });
    expect(consumed!.status).toBe("CANCELED");
    // Still exactly ONE booked appointment - no second booking on a move.
    const bookedCount = await prisma.appointment.count({
      where: { shopId: shop.id, status: "BOOKED" },
    });
    expect(bookedCount).toBe(1);
  });

  it("a shop-owned To number pins routing to that shop, beating the phone-match guess", async () => {
    // The wrong-shop scenario: this phone is a client at BOTH shops, and shop A
    // has the more recent visit - the phone-match heuristic would pick A. But
    // the client texted SHOP B'S OWN NUMBER, so B must win, full stop.
    const shopA = await makeShop();
    const ownNumber = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const shopB = await makeShop({ twilioNumber: ownNumber });
    await makeBookable(shopA.id);
    await makeBookable(shopB.id);
    const phone = freshPhone();
    await makeClient(shopA.id, phone, { lastVisitAt: NOW }); // most recent -> the guess
    await makeClient(shopB.id, phone, { lastVisitAt: new Date("2026-01-01T00:00:00Z") });

    const model = scriptedModel([textMsg("hey! what can I get you?")]);
    __setModelClientForTests(model);

    await processInboundText({ phone, text: "you open?", to: ownNumber, now: NOW });

    // The conversation landed at shop B (the owned line), not shop A.
    const convoB = await prisma.receptionistConversation.findFirst({
      where: { shopId: shopB.id, phone },
    });
    const convoA = await prisma.receptionistConversation.findFirst({
      where: { shopId: shopA.id, phone },
    });
    expect(convoB).not.toBeNull();
    expect(convoA).toBeNull();

    // And the reply went out FROM the shop's own number.
    expect(sms).toHaveLength(1);
    expect(sms[0]!.from).toBe(ownNumber);
  });

  it("a stranger texting a shop-owned line stays silent - never rerouted to another shop", async () => {
    // The phone is a client ONLY at shop A. Texting shop B's own number must
    // not fall back to the phone-match (that would be the wrong-shop bug) -
    // v1 answer for unknown texters is silence.
    const shopA = await makeShop();
    const ownNumber = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const shopB = await makeShop({ twilioNumber: ownNumber });
    await makeBookable(shopB.id);
    const phone = freshPhone();
    await makeClient(shopA.id, phone);

    __setModelClientForTests(scriptedModel([textMsg("should never be sent")]));

    await processInboundText({ phone, text: "you open?", to: ownNumber, now: NOW });

    expect(sms).toHaveLength(0);
    const convos = await prisma.receptionistConversation.findMany({
      where: { phone },
    });
    expect(convos).toHaveLength(0);
  });

  it("shops without their own number keep shared-line phone-match routing and the shared sender", async () => {
    const shop = await makeShop(); // no twilioNumber
    await makeBookable(shop.id);
    const phone = freshPhone();
    await makeClient(shop.id, phone);

    __setModelClientForTests(scriptedModel([textMsg("hey Marcus")]));

    // to = the shared platform number (owned by no shop) -> phone-match path.
    await processInboundText({ phone, text: "hi", to: "+15550001111", now: NOW });

    expect(sms).toHaveLength(1);
    expect(sms[0]!.from).toBeUndefined(); // shared sender = provider default
    const convo = await prisma.receptionistConversation.findFirst({
      where: { shopId: shop.id, phone },
    });
    expect(convo).not.toBeNull();
  });

  it("omits the holds note when the client holds nothing", async () => {
    const shop = await makeShop();
    await makeBookable(shop.id);
    const phone = freshPhone();
    await makeClient(shop.id, phone);

    const model = scriptedModel([textMsg("hey - what can I get you?")]);
    __setModelClientForTests(model);

    await processInboundText({ phone, text: "hi", now: NOW });

    const first = model.requests[0]!.messages[0]!;
    expect(first.content).not.toContain("HOLD");
  });

  it("stays silent for unknown numbers (shared-number v1 routing)", async () => {
    await makeShop();
    const phone = freshPhone();
    __setModelClientForTests(scriptedModel([textMsg("should never be sent")]));

    await processInboundText({ phone, text: "you free tomorrow?", now: NOW });

    expect(sms).toHaveLength(0);
    const convo = await prisma.receptionistConversation.findFirst({ where: { phone } });
    expect(convo).toBeNull();
  });

  it("stays silent when the shop's receptionist is off or terms unaccepted", async () => {
    const offShop = await makeShop({ receptionistEnabled: false });
    const noTermsShop = await makeShop({ receptionistTermsAcceptedAt: null });
    const p1 = freshPhone();
    const p2 = freshPhone();
    await makeClient(offShop.id, p1);
    await makeClient(noTermsShop.id, p2);
    __setModelClientForTests(scriptedModel([textMsg("nope"), textMsg("nope")]));

    await processInboundText({ phone: p1, text: "hey", now: NOW });
    await processInboundText({ phone: p2, text: "hey", now: NOW });

    expect(sms).toHaveLength(0);
  });

  it("replies to a known client WITHOUT smsConsentAt (consumer-initiated thread)", async () => {
    const shop = await makeShop();
    const phone = freshPhone();
    await makeClient(shop.id, phone, { smsConsentAt: null });
    __setModelClientForTests(scriptedModel([textMsg("we're open 9-6 tomorrow")]));

    await processInboundText({ phone, text: "you open tomorrow?", now: NOW });

    expect(sms).toHaveLength(1);
  });

  it("NEVER texts an opted-out number - even mid-conversation (send-time re-check)", async () => {
    const shop = await makeShop();
    const phone = freshPhone();
    await makeClient(shop.id, phone, { optedOut: true });
    __setModelClientForTests(scriptedModel([textMsg("this must not send")]));

    await processInboundText({ phone, text: "one more question", now: NOW });

    expect(sms).toHaveLength(0);
    // The turn still ran and is audited; only the send was blocked.
    const convo = await prisma.receptionistConversation.findFirst({
      where: { shopId: shop.id, phone },
      include: { messages: true },
    });
    expect(convo).not.toBeNull();
    expect(convo!.messages.some((m) => m.role === "assistant")).toBe(true);
    const nudges = await prisma.nudge.findMany({ where: { shopId: shop.id } });
    expect(nudges).toHaveLength(0);
  });

  it("escalate_to_human hands the thread off: status flips, barber alerted, AI goes silent on the follow-up", async () => {
    const shop = await makeShop({ notifyPhone: "+13025550199" });
    const phone = freshPhone();
    await makeClient(shop.id, phone);
    __setModelClientForTests(
      scriptedModel([
        toolUseMsg([
          { id: "tu_1", name: "escalate_to_human", input: { reason: "refund dispute" } },
        ]),
        textMsg("let me flag that for the shop right now so we get it sorted"),
      ]),
    );

    await processInboundText({ phone, text: "i got charged twice", now: NOW });

    const convo = await prisma.receptionistConversation.findFirst({
      where: { shopId: shop.id, phone },
      include: { messages: true },
    });
    expect(convo!.status).toBe("escalated");
    expect(convo!.messages.some((m) => m.role === "system_note")).toBe(true);
    // Barber SMS + client handoff reply both captured.
    const barberSms = sms.find((s) => s.to === "+13025550199");
    expect(barberSms).toBeDefined();
    expect(barberSms!.body).toContain("refund dispute");
    expect(sms.find((s) => s.to === phone)).toBeDefined();

    // Follow-up inbound: persisted for the barber, NO ai reply.
    sms = [];
    __setModelClientForTests(scriptedModel([textMsg("must not send")]));
    await processInboundText({ phone, text: "any update?", now: NOW });
    expect(sms).toHaveLength(0);
    const after = await prisma.receptionistConversation.findFirst({
      where: { id: convo!.id },
      include: { messages: true },
    });
    expect(after!.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("a runaway tool loop escalates at the iteration cap with a handoff line", async () => {
    const shop = await makeShop();
    const phone = freshPhone();
    await makeClient(shop.id, phone);
    __setModelClientForTests(runawayModel());

    await processInboundText({ phone, text: "hmm", now: NOW });

    const convo = await prisma.receptionistConversation.findFirst({
      where: { shopId: shop.id, phone },
    });
    expect(convo!.status).toBe("escalated");
    const clientSms = sms.find((s) => s.to === phone);
    expect(clientSms).toBeDefined();
    expect(clientSms!.body).toContain("barber");
  });

  it("routes a multi-shop phone to the most recently visited enabled shop", async () => {
    const oldShop = await makeShop();
    const newShop = await makeShop();
    const phone = freshPhone();
    await makeClient(oldShop.id, phone, { lastVisitAt: new Date("2026-01-01T00:00:00Z") });
    await makeClient(newShop.id, phone, { lastVisitAt: new Date("2026-05-20T00:00:00Z") });
    __setModelClientForTests(scriptedModel([textMsg("hey!")]));

    await processInboundText({ phone, text: "yo", now: NOW });

    const convo = await prisma.receptionistConversation.findFirst({ where: { phone } });
    expect(convo!.shopId).toBe(newShop.id);
  });
});

describe("reply abuse caps", () => {
  it("escalates a client at the daily reply cap BEFORE calling the model or sending SMS", async () => {
    const shop = await makeShop();
    const phone = freshPhone();
    const client = await makeClient(shop.id, phone);

    // The client already burned today's reply allowance.
    await prisma.nudge.createMany({
      data: Array.from(
        { length: RECEPTIONIST_REPLY_LIMITS.perClientPerDay },
        () => ({
          shopId: shop.id,
          clientId: client.id,
          channel: "SMS" as const,
          status: "SENT" as const,
          kind: "receptionist_reply",
          createdAt: NOW,
        }),
      ),
    });

    const model = scriptedModel([textMsg("must never be requested")]);
    __setModelClientForTests(model);

    await processInboundText({ phone, text: "and another thing", now: NOW });

    // No Anthropic call, no SMS - the inbound is persisted and the thread is
    // handed to the barber (escalated silences all future AI turns).
    expect(model.requests).toHaveLength(0);
    expect(sms.find((s) => s.to === phone)).toBeUndefined();
    const convo = await prisma.receptionistConversation.findFirst({
      where: { shopId: shop.id, phone },
      include: { messages: true },
    });
    expect(convo!.status).toBe("escalated");
    expect(convo!.messages.some((m) => m.role === "user")).toBe(true);
    expect(
      convo!.messages.some(
        (m) => m.role === "system_note" && m.content.includes("reply_cap"),
      ),
    ).toBe(true);
  });
});

describe("premium AI tier entitlement (billing enabled)", () => {
  it("plan=pro_ai runs the receptionist with NO add-on subscription or comp", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_PRICE_ID = "price_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
    __resetEnvCacheForTests();
    try {
      const shop = await prisma.shop.create({
        data: {
          ownerId: userId,
          name: "Tier Cuts",
          slug: `tier-${randomToken(5)}`,
          webhookSecret: randomToken(),
          bookingMode: "native",
          plan: "pro_ai",
          subscriptionStatus: "active",
          stripeSubscriptionId: `sub_test_${randomToken(6)}`,
          compAccess: false,
          receptionistEnabled: true,
          receptionistCompAccess: false,
          receptionistSubscriptionStatus: "none",
          receptionistTermsAcceptedAt: NOW,
        },
        select: { id: true },
      });
      const phone = freshPhone();
      await makeClient(shop.id, phone);
      __setModelClientForTests(scriptedModel([textMsg("hey, what can I book you for?")]));

      await processInboundText({ phone, text: "hi", now: NOW });

      expect(sms.find((s) => s.to === phone)).toBeDefined();
      const convo = await prisma.receptionistConversation.findFirst({
        where: { shopId: shop.id, phone },
      });
      expect(convo).not.toBeNull();
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_PRICE_ID;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      __resetEnvCacheForTests();
    }
  });
});

describe("STOP + live-thread helpers", () => {
  it("closeConversationsForPhone silences every live thread for the number", async () => {
    const shop = await makeShop();
    const phone = freshPhone();
    await makeClient(shop.id, phone);
    __setModelClientForTests(scriptedModel([textMsg("hi")]));
    await processInboundText({ phone, text: "hello", now: NOW });
    expect(await hasLiveConversation(phone)).toBe(true);

    const closed = await closeConversationsForPhone(phone);
    expect(closed).toBe(1);
    expect(await hasLiveConversation(phone)).toBe(false);

    // Post-STOP the thread is closed - a new text starts a FRESH conversation.
    __setModelClientForTests(scriptedModel([textMsg("fresh thread")]));
    await processInboundText({ phone, text: "im back", now: NOW });
    const convos = await prisma.receptionistConversation.findMany({ where: { phone } });
    expect(convos).toHaveLength(2);
  });
});
