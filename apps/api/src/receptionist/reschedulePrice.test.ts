import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { Prisma, prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests, type PushSender } from "../messaging/push.js";
import type { MessageProvider } from "../messaging/provider.js";
import { encodeSlotId, makeToolExecutor, type ToolContext } from "./tools.js";

/**
 * THE SMS RECEPTIONIST'S `reschedule` NEVER CHANGES A PRICE IN SILENCE.
 *
 * It used to write the new slot's menu price over `priceAtBooking` on every
 * move - dropping add-ons, typed and hand-edited prices, and repricing a
 * Wednesday surcharge with nobody asked. It now follows the same rule as both
 * reschedule routes (engines/movePrice.ts): an agreed price moves untouched; a
 * plain menu price that differs at the new time moves NOTHING until the client
 * has said yes to the exact figure, which the server re-derives and compares on
 * the accepting call; a stale yes is asked again; a retry does nothing twice;
 * a fully prepaid booking whose price would change is handed to the shop.
 */

const NOW = new Date("2026-06-01T16:00:00Z"); // Monday, 12:00 EDT
const TUE = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 2, h, m)); // $35
const WED = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 3, h, m)); // $45 (date override)
const WED_KEY = "2026-06-03";

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;
const PHONE = "+15551240001";

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

const ctx = (): ToolContext => ({
  shopId,
  conversationId: `convo-price-${clientId}`,
  phone: PHONE,
  clientId,
  now: NOW,
});
const exec = (name: string, input: unknown) => makeToolExecutor(ctx())(name, input);
const slotAt = (d: Date) => encodeSlotId(staffId, serviceId, d);

async function booking(over: Partial<Prisma.AppointmentUncheckedCreateInput> = {}) {
  const startsAt = (over.startsAt as Date | undefined) ?? TUE(14);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Marcus",
      phone: PHONE,
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: new Prisma.Decimal("35.00"),
      manageToken: randomToken(),
      ...over,
    },
    select: { id: true },
  });
}
const row = (id: string) =>
  prisma.appointment.findUniqueOrThrow({
    where: { id },
    select: { startsAt: true, priceAtBooking: true, bookedVia: true, status: true },
  });
const state = async (id: string) => {
  const r = await row(id);
  return { at: r.startsAt.toISOString(), price: Number(r.priceAtBooking) };
};
const ledger = (id: string) =>
  prisma.appointmentPriceChange.findMany({ where: { appointmentId: id }, orderBy: { createdAt: "asc" } });
const body = (r: { result: string }) => JSON.parse(r.result) as Record<string, unknown>;

beforeAll(async () => {
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests(fakePush);
  userId = (
    await prisma.user.create({
      data: { email: `rprice-${randomToken(6)}@test.chairback`, name: "Price" },
      select: { id: true },
    })
  ).id;
  shopId = (
    await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Price Cuts",
        slug: `rprice-${randomToken(5)}`.toLowerCase(),
        webhookSecret: randomToken(),
        bookingMode: "native",
        compAccess: true,
      },
      select: { id: true },
    })
  ).id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Kai" } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 35 } })
  ).id;
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 0, endMin: 1439 },
    });
  }
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  clientId = (
    await prisma.client.create({
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
    })
  ).id;
});

beforeEach(async () => {
  await prisma.service.update({ where: { id: serviceId }, data: { dateOverrides: { [WED_KEY]: 45 } } });
  await prisma.targetedSlot.deleteMany({ where: { shopId } });
  await prisma.payment.deleteMany({ where: { shopId } });
  await prisma.appointmentPriceChange.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  await prisma.payment.deleteMany({ where: { shopId } });
  await prisma.appointmentPriceChange.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("🔴 reschedule by text: a price never changes without a yes", () => {
  it("the same price at the new time: moves at once, nothing recorded", async () => {
    const a = await booking();
    const res = await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(TUE(15)) });
    expect(res.isError).toBe(false);
    expect(body(res)).toMatchObject({ rescheduled: true, price: "$35" });
    expect(await state(a.id)).toEqual({ at: TUE(15).toISOString(), price: 35 });
    expect(await ledger(a.id)).toEqual([]);
  });

  it("a different menu price moves NOTHING and hands back both figures and the reason", async () => {
    const a = await booking();
    const res = await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(WED(14)) });
    expect(res.isError).toBe(false);
    const b = body(res);
    expect(b).toMatchObject({
      rescheduled: false,
      needs_price_ok: true,
      current_price: "$35",
      new_price: "$45",
      current_price_cents: 3500,
      new_price_cents: 4500,
    });
    expect(b.price_changed_since_quoted).toBeUndefined();
    expect(b.reason).toBe(
      "The new time has a different menu price. Moving it changes the price from $35 to $45.",
    );
    expect(b.note).toContain("accept_price_cents: 4500");
    expect(b.note).toContain("NOTHING MOVED");
    expect(await state(a.id)).toEqual({ at: TUE(14).toISOString(), price: 35 });
    expect(await ledger(a.id)).toEqual([]);
  });

  it("the client's yes, sent back as the exact figure, moves it and records ONE ledger row (source move)", async () => {
    const a = await booking();
    await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(WED(14)) });
    const res = await exec("reschedule", {
      appointment_id: a.id,
      new_slot_id: slotAt(WED(14)),
      accept_price_cents: 4500,
    });
    expect(res.isError).toBe(false);
    expect(body(res)).toMatchObject({ rescheduled: true, price: "$45", price_changed: true });
    expect(await state(a.id)).toEqual({ at: WED(14).toISOString(), price: 45 });
    const rows = await ledger(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromPriceCents: 3500,
      toPriceCents: 4500,
      actorUserId: null,
      source: "move",
    });
  });

  it("a retried accepting call (the reply never arrived) moves nothing twice and records nothing twice", async () => {
    const a = await booking();
    const accept = { appointment_id: a.id, new_slot_id: slotAt(WED(14)), accept_price_cents: 4500 };
    expect(body(await exec("reschedule", accept)).rescheduled).toBe(true);
    const again = await exec("reschedule", accept);
    expect(again.isError).toBe(false);
    expect(body(again)).toMatchObject({ rescheduled: true, already_at_that_time: true, price: "$45" });
    expect(await state(a.id)).toEqual({ at: WED(14).toISOString(), price: 45 });
    expect(await ledger(a.id)).toHaveLength(1);
  });

  it("🔴 a stale yes (the menu changed after it was quoted) is asked again with the new figures", async () => {
    const a = await booking();
    expect(body(await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(WED(14)) })).new_price_cents).toBe(4500);
    // The shop changes Wednesday's price while the client is deciding.
    await prisma.service.update({ where: { id: serviceId }, data: { dateOverrides: { [WED_KEY]: 50 } } });
    const res = await exec("reschedule", {
      appointment_id: a.id,
      new_slot_id: slotAt(WED(14)),
      accept_price_cents: 4500,
    });
    expect(res.isError).toBe(false);
    expect(body(res)).toMatchObject({
      rescheduled: false,
      needs_price_ok: true,
      price_changed_since_quoted: true,
      new_price_cents: 5000,
      new_price: "$50",
    });
    expect(await state(a.id)).toEqual({ at: TUE(14).toISOString(), price: 35 });
    expect(await ledger(a.id)).toEqual([]);
  });

  it("🔴 a figure the model made up is never written - it is refused like a stale one", async () => {
    const a = await booking();
    for (const cents of [3500, 4000, 0, 99999]) {
      const res = await exec("reschedule", {
        appointment_id: a.id,
        new_slot_id: slotAt(WED(14)),
        accept_price_cents: cents,
      });
      expect(body(res)).toMatchObject({ rescheduled: false, needs_price_ok: true, new_price_cents: 4500 });
    }
    // Not a number at all is invalid input, and nothing moves either.
    const junk = await exec("reschedule", {
      appointment_id: a.id,
      new_slot_id: slotAt(WED(14)),
      accept_price_cents: "4500",
    });
    expect(junk.isError).toBe(true);
    expect(await state(a.id)).toEqual({ at: TUE(14).toISOString(), price: 35 });
    expect(await ledger(a.id)).toEqual([]);
  });

  it("the client says no: the booking stays exactly as it was, and the held time is not taken", async () => {
    const a = await booking();
    // The usual flow holds the new time before asking.
    expect((await exec("hold_slot", { slot_id: slotAt(WED(14)) })).isError).toBe(false);
    const asked = await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(WED(14)) });
    expect(body(asked).needs_price_ok).toBe(true);
    // "nah keep it" - no accepting call is ever made.
    expect(await state(a.id)).toEqual({ at: TUE(14).toISOString(), price: 35 });
    expect((await row(a.id)).status).toBe("BOOKED");
    expect(await ledger(a.id)).toEqual([]);
    const moved = await prisma.appointment.count({
      where: { shopId, status: "BOOKED", startsAt: WED(14) },
    });
    expect(moved).toBe(0);
  });

  it("🔴 an agreed price is kept: a hand edit, a typed price, and add-ons on a same-menu move", async () => {
    // Hand-edited to $32 (a ledger row): moved to the $45 Wednesday at $32, no question.
    const edited = await booking({ priceAtBooking: new Prisma.Decimal("32.00") });
    await prisma.appointmentPriceChange.create({
      data: { shopId, appointmentId: edited.id, actorUserId: null, fromPriceCents: 3500, toPriceCents: 3200 },
    });
    const e = await exec("reschedule", { appointment_id: edited.id, new_slot_id: slotAt(WED(14)) });
    expect(body(e)).toMatchObject({ rescheduled: true, price: "$32" });
    expect(await state(edited.id)).toEqual({ at: WED(14).toISOString(), price: 32 });
    expect(await ledger(edited.id)).toHaveLength(1);

    // A typed $30 (not the menu's $35): kept on Wednesday too.
    const typed = await booking({ startsAt: TUE(16), priceAtBooking: new Prisma.Decimal("30.00") });
    expect(body(await exec("reschedule", { appointment_id: typed.id, new_slot_id: slotAt(WED(16)) }))).toMatchObject({
      rescheduled: true,
      price: "$30",
    });
    expect((await state(typed.id)).price).toBe(30);

    // Cut $35 + Beard $10 = $45, moved Tuesday to Tuesday: still $45 (the
    // old tool wrote the bare $35 menu price and dropped the add-on).
    const withAddOn = await booking({
      startsAt: TUE(18),
      priceAtBooking: new Prisma.Decimal("45.00"),
      addOns: [{ id: "ao1", name: "Beard", durationMin: 0, price: 10 }],
    });
    expect(body(await exec("reschedule", { appointment_id: withAddOn.id, new_slot_id: slotAt(TUE(19)) }))).toMatchObject({
      rescheduled: true,
      price: "$45",
    });
    expect((await state(withAddOn.id)).price).toBe(45);
    expect(await ledger(withAddOn.id)).toEqual([]);
  });

  async function paid(apptId: string, cents: number) {
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: apptId,
        purpose: "booking",
        stripePaymentIntentId: `pi_rprice_${randomToken(8)}`,
        stripeConnectAccountId: "acct_rprice",
        mode: "ahead",
        amount: cents,
        capturedAmount: cents,
        status: "succeeded",
      },
    });
  }

  it("🔴 a booking paid in full whose price would change goes to the shop - even with the right figure", async () => {
    const a = await booking();
    await paid(a.id, 3500);
    for (const extra of [{}, { accept_price_cents: 4500 }]) {
      const res = await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(WED(14)), ...extra });
      expect(res.isError).toBe(true);
      expect(res.result).toContain("escalate_to_human");
    }
    expect(await state(a.id)).toEqual({ at: TUE(14).toISOString(), price: 35 });
    expect(await ledger(a.id)).toEqual([]);
    // Paid in full but the same price at the new time: moves.
    expect(body(await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(TUE(15)) })).rescheduled).toBe(true);
  });

  it("a DEPOSIT still covered by the new price is asked like anyone else, not handed off", async () => {
    const a = await booking();
    await paid(a.id, 1000);
    const res = await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(WED(14)) });
    expect(res.isError).toBe(false);
    expect(body(res)).toMatchObject({ needs_price_ok: true, new_price_cents: 4500 });
  });

  it("leaving a special by text offers the menu price, says why, and gives the special back once moved", async () => {
    const a = await booking({
      startsAt: TUE(23),
      priceAtBooking: new Prisma.Decimal("150.00"),
      bookedVia: "targeted_slot",
    });
    const special = await prisma.targetedSlot.create({
      data: {
        shopId,
        staffId,
        serviceId,
        startsAt: TUE(23),
        durationMin: 30,
        price: new Prisma.Decimal("150.00"),
        bookedAppointmentId: a.id,
      },
      select: { id: true },
    });
    const asked = body(await exec("reschedule", { appointment_id: a.id, new_slot_id: slotAt(TUE(15)) }));
    expect(asked).toMatchObject({ needs_price_ok: true, current_price_cents: 15000, new_price_cents: 3500 });
    expect(asked.reason).toContain("special");
    expect((await row(a.id)).bookedVia).toBe("targeted_slot");

    const moved = await exec("reschedule", {
      appointment_id: a.id,
      new_slot_id: slotAt(TUE(15)),
      accept_price_cents: 3500,
    });
    expect(body(moved)).toMatchObject({ rescheduled: true, price: "$35" });
    const after = await row(a.id);
    expect(Number(after.priceAtBooking)).toBe(35);
    expect(after.bookedVia).toBeNull();
    const slot = await prisma.targetedSlot.findUniqueOrThrow({ where: { id: special.id } });
    expect(slot.bookedAppointmentId).toBeNull();
    expect(await ledger(a.id)).toHaveLength(1);
  });
});
