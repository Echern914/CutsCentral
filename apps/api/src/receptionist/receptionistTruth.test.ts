import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests, type PushSender } from "../messaging/push.js";
import type { MessageProvider } from "../messaging/provider.js";
import { renderPromptForShop } from "./prompt.js";
import { makeToolExecutor, type ToolContext } from "./tools.js";

/**
 * 🔴 WHAT THE RECEPTIONIST SAYS MUST BE WHAT THE SHOP ACTUALLY DOES.
 *
 * Every test here pins one way the SMS receptionist used to tell a customer
 * something false about their own shop, each against real rows through the
 * real prompt renderer and the real tools:
 *
 *   - the menu quoted the BASE price while the booking wrote the Saturday one
 *   - check_availability carried no price at all, so the stale menu line was
 *     the model's only source
 *   - hours included a DEACTIVATED barber's rules forever
 *   - the shop's own hours note was discarded whenever rules existed
 *   - the address was hard-coded "not listed" even when the shop published one
 *   - a one-chair shop offered "another barber" who did not exist, and every
 *     shop's receptionist said "Drick" because the catalog did
 *   - cancel returned no fee, so "no worries, cancelled" went out while the
 *     engine kept half the money
 *
 * The refund call is stubbed: the point is that the fee the TOOL reports is
 * the fee the ENGINE charges, which the stub's argument proves.
 */

const { refundSpy } = vi.hoisted(() => ({
  refundSpy: vi.fn(async (_params: { paymentId: string; feeCents: number }) => 0),
}));
vi.mock("../billing/payments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/payments.js")>()),
  refundForCancellation: refundSpy,
}));

const NOW = new Date("2026-06-01T16:00:00Z"); // Monday, 12:00 EDT
const TZ = "America/New_York";

let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;
const PHONE = "+15551230011";

const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send() {
    return { sid: "SMx", status: "queued" };
  },
};
const fakePush: PushSender = {
  async send() {
    /* no-op */
  },
};

function ctx(): ToolContext {
  return { shopId, conversationId: `convo-${clientId}`, phone: PHONE, clientId, now: NOW };
}

async function render(): Promise<string> {
  const text = await renderPromptForShop(shopId);
  if (!text) throw new Error("prompt template missing - ai/receptionist-prompt.md");
  return text;
}

beforeAll(async () => {
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests(fakePush);
  const user = await prisma.user.create({
    data: { email: `truth-${randomToken(6)}@test.chairback`, name: "Truth" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Truth Cuts",
      slug: `truth-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      compAccess: true,
      timezone: TZ,
      hoursText: "closed 1-2 for lunch",
      addressStreet: "123 Main St",
      addressCity: "Wilmington",
      addressRegion: "DE",
      addressPostal: "19801",
      // Half of what was paid is kept inside 24h.
      cancelWindowHours: 24,
      cancelFeeBps: 5000,
    },
    select: { id: true },
  });
  shopId = shop.id;

  // The one working chair. Not "Drick" - so a hard-coded name has nowhere to hide.
  const kai = await prisma.staff.create({ data: { shopId, name: "Kai" } });
  staffId = kai.id;
  // A barber who left. Deactivation soft-deletes; their rules stay in the table.
  const zeke = await prisma.staff.create({ data: { shopId, name: "Zeke", active: false } });

  const service = await prisma.service.create({
    data: {
      shopId,
      name: "Cut",
      durationMin: 30,
      price: 35,
      // Saturday (6) costs more and takes longer.
      priceOverrides: { "6": 55 },
      durationOverrides: { "6": 45 },
    },
  });
  serviceId = service.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });

  // Kai: Mon-Sat 9-5. Zeke (gone): Sundays 9-5.
  for (let weekday = 1; weekday <= 6; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 540, endMin: 1020 },
    });
  }
  await prisma.availabilityRule.create({
    data: { shopId, staffId: zeke.id, weekday: 0, startMin: 540, endMin: 1020 },
  });

  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `k-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Marcus",
      phone: PHONE,
      smsConsentAt: NOW,
      source: "manual",
    },
    select: { id: true },
  });
  clientId = client.id;
});

afterAll(() => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
});

describe("the menu the receptionist reads", () => {
  it("shows the day-dependent price and length as a RANGE and points at check_availability", async () => {
    const text = await render();
    expect(text).toContain("Cut - $35-$55 (30-45 min)");
    expect(text).toContain("check_availability returns the exact figure");
    // The old line - the base alone, stated as THE price.
    expect(text).not.toContain("Cut - $35 (30 min)");
  });
});

describe("check_availability", () => {
  it("quotes each slot's OWN price and length: the Saturday figure on Saturday", async () => {
    const exec = makeToolExecutor(ctx());
    const sat = await exec("check_availability", { service: "Cut", from_date: "2026-06-06" });
    expect(sat.isError).toBe(false);
    const body = JSON.parse(sat.result) as {
      duration_min: number;
      availability: { barber: string; slots: { price: number | null; duration_min: number }[] }[];
    };
    const slots = body.availability.flatMap((a) => a.slots);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.price).toBe(55);
      expect(s.duration_min).toBe(45);
    }
    // The top-level figure is the BASE length (kept for older readers); the
    // slot is the truth.
    expect(body.duration_min).toBe(30);
  });

  it("and the weekday figure on a Tuesday", async () => {
    const exec = makeToolExecutor(ctx());
    const tue = await exec("check_availability", { service: "Cut", from_date: "2026-06-02" });
    expect(tue.isError).toBe(false);
    const body = JSON.parse(tue.result) as {
      availability: { slots: { price: number | null; duration_min: number }[] }[];
      note: string;
    };
    const slots = body.availability.flatMap((a) => a.slots);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.price).toBe(35);
      expect(s.duration_min).toBe(30);
    }
    expect(body.note).toContain("Quote each slot's own price");
  });
});

describe("hours, address, staff", () => {
  it("hours come from ACTIVE staff only, carry the shop's own note, and are framed as the usual week", async () => {
    const text = await render();
    expect(text).toContain("Mon 9:00 AM-5:00 PM");
    // Zeke's Sunday rule is still in the table; Zeke is gone.
    expect(text).not.toContain("Sun 9:00 AM-5:00 PM");
    expect(text).toContain("shop's own note: closed 1-2 for lunch");
    expect(text).toContain("usual weekly hours");
  });

  it("the address is the one the shop published, not a refusal", async () => {
    const text = await render();
    expect(text).toContain("123 Main St, Wilmington, DE 19801");
    expect(text).not.toContain("don't quote an address");
  });

  it("says what a no-show costs on THIS channel: nothing is collected at the chair", async () => {
    const text = await render();
    expect(text).toContain("no charge for a no-show");
  });

  it("a one-chair shop never offers a second barber, and never says 'Drick'", async () => {
    const text = await render();
    expect(text).toContain("Kai's fully booked this week");
    expect(text).not.toContain("has spots this week");
    expect(text).not.toContain("another barber has spots");
    expect(text).not.toMatch(/\bDrick\b/);
  });

  it("a second ACTIVE barber turns the offer back on, by name", async () => {
    const moe = await prisma.staff.create({ data: { shopId, name: "Moe" } });
    try {
      const text = await render();
      expect(text).toContain("want the first opening next week? or Moe has spots this week?");
    } finally {
      await prisma.staff.update({ where: { id: moe.id }, data: { active: false } });
    }
  });
});

describe("cancel", () => {
  async function bookedAt(startsAt: Date, priceAtBooking: number): Promise<string> {
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId,
        firstName: "Marcus",
        phone: PHONE,
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
        priceAtBooking,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    return appt.id;
  }

  it("🔴 reports the fee the engine actually keeps - the SAME formula, proven by the refund call", async () => {
    // Paid $40 on the website, cancelling by text 2h before: inside the 24h
    // window, so 50% = $20 stays with the shop.
    const inTwoHours = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const apptId = await bookedAt(inTwoHours, 40);
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: apptId,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: 4000,
        status: "succeeded",
      },
    });
    refundSpy.mockClear();

    const exec = makeToolExecutor(ctx());
    const res = await exec("cancel", { appointment_id: apptId });
    expect(res.isError).toBe(false);
    const body = JSON.parse(res.result) as { cancelled: boolean; fee_cents: number; fee_note: string; note: string };
    expect(body.cancelled).toBe(true);
    expect(body.fee_cents).toBe(2000);
    expect(body.fee_note).toContain("$20.00");
    expect(body.note).toContain("be straight about the fee");

    // The engine charged the identical figure.
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy.mock.calls[0]![0].feeCents).toBe(2000);
    const row = await prisma.appointment.findUnique({ where: { id: apptId }, select: { status: true } });
    expect(row?.status).toBe("CANCELED");
  });

  it("is a clean zero when nothing was paid - a fee needs money to take it from", async () => {
    const inTwoHours = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    const apptId = await bookedAt(inTwoHours, 35);
    refundSpy.mockClear();

    const exec = makeToolExecutor(ctx());
    const res = await exec("cancel", { appointment_id: apptId });
    expect(res.isError).toBe(false);
    const body = JSON.parse(res.result) as { fee_cents: number; fee_note: string; note: string };
    expect(body.fee_cents).toBe(0);
    expect(body.fee_note).toBe("no fee - nothing kept");
    expect(body.note).toContain("no guilt-trip");
    // No payment row, so the engine never reached the refund path.
    expect(refundSpy).not.toHaveBeenCalled();
  });
});
