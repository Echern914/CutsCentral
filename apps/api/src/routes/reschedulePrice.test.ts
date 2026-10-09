import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * A MOVE KEEPS THE BOOKING'S PRICE (engines/movePrice.ts), on both doors:
 * the shop's reschedule and the client's own.
 *
 * Both used to overwrite `priceAtBooking` with the service's menu price for
 * the new time, silently dropping add-ons, a special's price, a typed price
 * and any hand edit. Pinned here:
 *  - add-ons move with the booking, at their booked prices;
 *  - a hand-edited or typed price stays, whatever the new day's menu says;
 *  - a plain menu price that differs at the new time is refused until the
 *    figure has been seen (`acceptPriceCents`), then applied AND recorded in
 *    the price ledger - by the shop (actor) or the client (no actor);
 *  - leaving a special offers the menu price the same way;
 *  - the paid-booking guard reads the price the move would set;
 *  - the saved-card ceiling (agreedPriceCents) never rises above what was
 *    first agreed.
 */
const app = createApp();
let agent: ReturnType<typeof request.agent>;
let shopId: string;
let slug: string;
let staffId: string;
let cut: string;
const TZ = "UTC";

/** `daysAhead` days out at an exact UTC hour, landing on the weekday asked for. */
function nextWeekday(weekday: number, hour: number, atLeastDays = 2): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + atLeastDays);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}
const SUNDAY = 0;
const MONDAY = 1;

async function bookRow(over: Partial<Prisma.AppointmentUncheckedCreateInput> = {}) {
  const startsAt = (over.startsAt as Date | undefined) ?? nextWeekday(MONDAY, 10);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: cut,
      firstName: "Move",
      lastName: "Me",
      email: `move-${randomToken(4)}@test.local`,
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: new Prisma.Decimal("40.00"),
      manageToken: randomToken(),
      ...over,
    },
  });
}
const price = async (id: string) => Number((await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { priceAtBooking: true } })).priceAtBooking);
const ledger = (id: string) => prisma.appointmentPriceChange.findMany({ where: { appointmentId: id }, orderBy: { createdAt: "asc" } });
const shopMove = (id: string, startsAt: Date, extra: Record<string, unknown> = {}) =>
  agent.post(`/api/booking/appointments/${id}/reschedule`).send({ startsAt: startsAt.toISOString(), ...extra });
const clientMove = (token: string, startsAt: Date, extra: Record<string, unknown> = {}) =>
  request(app).post(`/api/book/manage/${token}/reschedule`).send({ startsAt: startsAt.toISOString(), ...extra });

beforeAll(async () => {
  agent = request.agent(app);
  const email = `resched-${randomToken(6)}@test.local`;
  await agent.post("/api/auth/signup").send({ email, password: "supersecret123", name: "Mover", smsAttested: true });
  await agent.post("/api/shops").send({ name: "Move Cuts", bookingUrl: "https://move.test", smsAttested: true });
  const patched = await agent.patch("/api/shops/me").send({ bookingMode: "native", timezone: TZ, bookingLeadHours: 1, bookingMaxDays: 60 });
  expect(patched.status).toBe(200);
  const me = await agent.get("/api/shops/me");
  shopId = me.body.id;
  slug = me.body.slug;
  staffId = (await agent.post("/api/booking/staff").send({ name: "Sam" })).body.id;
  // $40, and $45 on Sundays.
  cut = (await agent.post("/api/booking/services").send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] })).body.id;
  expect(cut).toBeTruthy();
  // $45 on Sundays - set directly, so this test doesn't depend on the services form.
  await prisma.service.update({ where: { id: cut }, data: { priceOverrides: { "0": 45 } } });
  await agent
    .put(`/api/booking/staff/${staffId}/availability`)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentPriceChange.deleteMany({ where: { shopId } });
});

describe("🔴 an agreed price moves with the booking", () => {
  it("add-ons: Haircut $40 + Beard $10 booked at $50, moved Monday to Monday, still $50 on both doors", async () => {
    const addOns = [{ id: "ao1", name: "Beard", durationMin: 0, price: 10 }];
    const a = await bookRow({ priceAtBooking: new Prisma.Decimal("50.00"), addOns });
    expect((await shopMove(a.id, nextWeekday(MONDAY, 11))).status).toBe(200);
    expect(await price(a.id)).toBe(50);
    const b = await bookRow({ priceAtBooking: new Prisma.Decimal("50.00"), addOns, startsAt: nextWeekday(MONDAY, 13) });
    expect((await clientMove(b.manageToken, nextWeekday(MONDAY, 14))).status).toBe(200);
    expect(await price(b.id)).toBe(50);
    expect(await ledger(a.id)).toEqual([]);
    expect(await ledger(b.id)).toEqual([]);
  });

  it("a typed price ($30, not the menu's $40) stays, even moved to the $45 Sunday", async () => {
    const a = await bookRow({ priceAtBooking: new Prisma.Decimal("30.00") });
    const res = await shopMove(a.id, nextWeekday(SUNDAY, 10));
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ kind: "kept", totalCents: 3000 });
    expect(await price(a.id)).toBe(30);
  });

  it("🔴 a hand-edited price (a ledger row) stays, on the client's door too", async () => {
    const a = await bookRow({ priceAtBooking: new Prisma.Decimal("40.00") });
    await prisma.appointmentPriceChange.create({
      data: { shopId, appointmentId: a.id, actorUserId: null, fromPriceCents: 5000, toPriceCents: 4000 },
    });
    const res = await clientMove(a.manageToken, nextWeekday(SUNDAY, 10));
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ kind: "kept", totalCents: 4000 });
    expect(await price(a.id)).toBe(40);
    expect(await ledger(a.id)).toHaveLength(1);
  });

  it("an unpriced booking stays unpriced", async () => {
    const a = await bookRow({ priceAtBooking: null });
    expect((await shopMove(a.id, nextWeekday(SUNDAY, 10))).body.price).toEqual({ kind: "kept", totalCents: null });
  });
});

describe("🔴 a menu price may change - never in silence", () => {
  it("the shop: Monday $40 to Sunday is refused with both figures, then applied when sent back, and recorded with the actor", async () => {
    const a = await bookRow();
    const asked = await shopMove(a.id, nextWeekday(SUNDAY, 10));
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ error: "price_changes", fromCents: 4000, toCents: 4500 });
    expect(asked.body.message).toBe("That time has a different price: $40 becomes $45. Move it at the new price?");
    expect(await price(a.id)).toBe(40);
    // A stale figure (the menu changed again) is refused the same way.
    expect((await shopMove(a.id, nextWeekday(SUNDAY, 10), { acceptPriceCents: 4400 })).status).toBe(409);
    const moved = await shopMove(a.id, nextWeekday(SUNDAY, 10), { acceptPriceCents: 4500 });
    expect(moved.status).toBe(200);
    expect(moved.body.price).toEqual({ kind: "repriced", fromCents: 4000, toCents: 4500 });
    expect(await price(a.id)).toBe(45);
    const rows = await ledger(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromPriceCents: 4000, toPriceCents: 4500 });
    expect(rows[0]!.actorUserId).toBeTruthy();
  });

  it("the client: the same, with no actor on the record", async () => {
    const a = await bookRow();
    const asked = await clientMove(a.manageToken, nextWeekday(SUNDAY, 10));
    expect(asked.status).toBe(409);
    expect(asked.body).toEqual({ error: "price_changes", code: "PRICE_CHANGES", fromCents: 4000, toCents: 4500 });
    const moved = await clientMove(a.manageToken, nextWeekday(SUNDAY, 10), { acceptPriceCents: 4500 });
    expect(moved.status).toBe(200);
    expect(await price(a.id)).toBe(45);
    const rows = await ledger(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromPriceCents: 4000, toPriceCents: 4500, actorUserId: null });
  });

  it("the same price on the new day: moves at once, nothing recorded", async () => {
    const a = await bookRow();
    const res = await shopMove(a.id, nextWeekday(MONDAY, 15));
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ kind: "same", totalCents: 4000 });
    expect(await ledger(a.id)).toEqual([]);
  });

  it("🔴 add-ons on a menu move: the add-ons ride along into the new figure ($50 -> $55)", async () => {
    const a = await bookRow({ priceAtBooking: new Prisma.Decimal("50.00"), addOns: [{ id: "ao1", name: "Beard", durationMin: 0, price: 10 }] });
    const asked = await shopMove(a.id, nextWeekday(SUNDAY, 10));
    expect(asked.body).toMatchObject({ error: "price_changes", fromCents: 5000, toCents: 5500 });
    expect((await shopMove(a.id, nextWeekday(SUNDAY, 10), { acceptPriceCents: 5500 })).status).toBe(200);
    expect(await price(a.id)).toBe(55);
  });

  it("the shop moving its own special keeps the special's price (he moved the special he sold)", async () => {
    const a = await bookRow({ priceAtBooking: new Prisma.Decimal("150.00"), bookedVia: "targeted_slot" });
    const res = await shopMove(a.id, nextWeekday(MONDAY, 11), { customTime: true });
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ kind: "kept", totalCents: 15000 });
    expect(await price(a.id)).toBe(150);
    expect(await ledger(a.id)).toEqual([]);
  });

  it("leaving a special ($150 at 8 PM) offers the menu price, on the client's door", async () => {
    const at = nextWeekday(MONDAY, 10);
    const a = await bookRow({ priceAtBooking: new Prisma.Decimal("150.00"), bookedVia: "targeted_slot", startsAt: at });
    const asked = await clientMove(a.manageToken, nextWeekday(MONDAY, 11));
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ error: "price_changes", fromCents: 15000, toCents: 4000 });
    const moved = await clientMove(a.manageToken, nextWeekday(MONDAY, 11), { acceptPriceCents: 4000 });
    expect(moved.status).toBe(200);
    expect(await price(a.id)).toBe(40);
    expect(await prisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { bookedVia: true } })).toEqual({ bookedVia: null });
  });
});

describe("🔴 a second move, after an accepted one", () => {
  // An accepted reprice writes a ledger row. That row is the MOVE's, not a hand
  // edit: the booking's price is the menu's figure for its time again, so the
  // next move must ask again rather than keep that figure in silence.
  it("Sunday $45 -> Monday (accepted $40) -> back to Sunday asks again ($40 -> $45), on the client's door", async () => {
    const a = await bookRow({ priceAtBooking: new Prisma.Decimal("45.00"), startsAt: nextWeekday(SUNDAY, 10) });
    expect((await clientMove(a.manageToken, nextWeekday(MONDAY, 11))).body).toMatchObject({ fromCents: 4500, toCents: 4000 });
    expect((await clientMove(a.manageToken, nextWeekday(MONDAY, 11), { acceptPriceCents: 4000 })).status).toBe(200);
    expect(await price(a.id)).toBe(40);
    const back = await clientMove(a.manageToken, nextWeekday(SUNDAY, 12));
    expect(back.status).toBe(409);
    expect(back.body).toMatchObject({ error: "price_changes", fromCents: 4000, toCents: 4500 });
    expect(await price(a.id)).toBe(40);
    expect((await clientMove(a.manageToken, nextWeekday(SUNDAY, 12), { acceptPriceCents: 4500 })).status).toBe(200);
    expect(await price(a.id)).toBe(45);
    const rows = await ledger(a.id);
    expect(rows.map((r) => [r.fromPriceCents, r.toPriceCents, r.source])).toEqual([
      [4500, 4000, "move"],
      [4000, 4500, "move"],
    ]);
  });

  it("🔴 Monday $40 -> Sunday (accepted $45) -> back to Monday asks ($45 -> $40): the higher figure never stays in silence, on the shop's door", async () => {
    const a = await bookRow();
    expect((await shopMove(a.id, nextWeekday(SUNDAY, 10), { acceptPriceCents: 4500 })).status).toBe(200);
    const back = await shopMove(a.id, nextWeekday(MONDAY, 12));
    expect(back.status).toBe(409);
    expect(back.body).toMatchObject({ error: "price_changes", fromCents: 4500, toCents: 4000 });
    expect(await price(a.id)).toBe(45);
    expect((await shopMove(a.id, nextWeekday(MONDAY, 12), { acceptPriceCents: 4000 })).status).toBe(200);
    expect(await price(a.id)).toBe(40);
  });

  it("a hand edit after an accepted move is still a hand edit: it stays on the next move", async () => {
    const a = await bookRow();
    expect((await shopMove(a.id, nextWeekday(SUNDAY, 10), { acceptPriceCents: 4500 })).status).toBe(200);
    expect((await agent.post(`/api/booking/appointments/${a.id}/price`).send({ amount: 42 })).status).toBe(200);
    const res = await clientMove(a.manageToken, nextWeekday(MONDAY, 12));
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ kind: "kept", totalCents: 4200 });
    expect(await price(a.id)).toBe(42);
    expect((await ledger(a.id)).map((r) => r.source)).toEqual(["move", null]);
  });
});

describe("money already taken", () => {
  it("🔴 a deposit still covered by the new price: the move (once seen) goes through; a full prepayment that no longer matches is refused", async () => {
    const dep = await bookRow();
    await prisma.payment.create({
      data: { shopId, appointmentId: dep.id, purpose: "booking", status: "succeeded", amount: 1000, currency: "usd", stripePaymentIntentId: `pi_${randomToken(8)}`, stripeConnectAccountId: "acct_test", mode: "deposit" },
    });
    expect((await shopMove(dep.id, nextWeekday(SUNDAY, 10), { acceptPriceCents: 4500 })).status).toBe(200);
    const full = await bookRow({ startsAt: nextWeekday(MONDAY, 12) });
    await prisma.payment.create({
      data: { shopId, appointmentId: full.id, purpose: "booking", status: "succeeded", amount: 4000, currency: "usd", stripePaymentIntentId: `pi_${randomToken(8)}`, stripeConnectAccountId: "acct_test", mode: "ahead" },
    });
    const refused = await shopMove(full.id, nextWeekday(SUNDAY, 11), { acceptPriceCents: 4500 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("price_changed");
    expect(await price(full.id)).toBe(40);
  });

  it("the saved-card ceiling never rises: first agreed $40, repriced to $45, agreed stays $40", async () => {
    const { agreedPriceCents } = await import("../services/appointmentPriceLedger.js");
    const a = await bookRow();
    expect((await shopMove(a.id, nextWeekday(SUNDAY, 10), { acceptPriceCents: 4500 })).status).toBe(200);
    expect(await agreedPriceCents(shopId, a.id, 4500)).toBe(4000);
  });

  it("🔴 a lower figure accepted at a move caps the card: leaving a $150 special at $40, then the shop raising it to $150, the ceiling stays $40", async () => {
    const { agreedPriceCents } = await import("../services/appointmentPriceLedger.js");
    const a = await bookRow({ priceAtBooking: new Prisma.Decimal("150.00"), bookedVia: "targeted_slot" });
    expect((await clientMove(a.manageToken, nextWeekday(MONDAY, 11), { acceptPriceCents: 4000 })).status).toBe(200);
    expect((await agent.post(`/api/booking/appointments/${a.id}/price`).send({ amount: 150 })).status).toBe(200);
    expect(await price(a.id)).toBe(150);
    expect(await agreedPriceCents(shopId, a.id, 15000)).toBe(4000);
  });

  it("a card ceiling with only hand edits reads as before: the price before the first edit, capped by the current one", async () => {
    const { agreedPriceCents } = await import("../services/appointmentPriceLedger.js");
    const a = await bookRow();
    expect((await agent.post(`/api/booking/appointments/${a.id}/price`).send({ amount: 50 })).status).toBe(200);
    expect(await agreedPriceCents(shopId, a.id, 5000)).toBe(4000);
    expect((await agent.post(`/api/booking/appointments/${a.id}/price`).send({ amount: 30 })).status).toBe(200);
    expect(await agreedPriceCents(shopId, a.id, 3000)).toBe(3000);
  });
});

describe("the public page's slug is untouched by all this", () => {
  it("the shop still exists under its slug", async () => {
    expect((await request(app).get(`/api/book/${slug}`)).status).toBe(200);
  });
});
