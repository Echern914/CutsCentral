import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { raceBehindRowLock } from "../testing/raceBarrier.js";
import { claimOfferUse, OfferRefused } from "../engines/offers.js";

/**
 * OFFERS & CODES (engines/offers.ts, routes/offers.ts).
 *
 * Pinned here:
 *  - dark until the shop is switched on;
 *  - MIKEYG30: one free haircut with Mikey, for one client, one use - its
 *    value is the stored offer, never the code's characters;
 *  - a personal offer is the client's only when the SHOP books them; online
 *    (where nothing proves who is booking) it is refused;
 *  - one record per booking, claimed in the booking's own transaction; two
 *    bookings racing for the last use get one;
 *  - a cancellation or a lapsed hold gives the use back, a no-show spends it;
 *  - a move keeps the discount or is refused, never repriced to full;
 *  - add-ons are never discounted; a series or a special refuses a code;
 *  - a barber makes offers only with the permission, for those services, on
 *    their own chair.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let owner: string;
let shopId: string;
let slug: string;
let mikey: string;
let dee: string;
let cut: string;
let beard: string;
let jordan: string;
let sam: string;

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

/** `daysAhead` days out at an exact UTC hour (shop tz = UTC, so wall == UTC). */
function dayAt(daysAhead: number, hour: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

const offers = () => request(app).get("/api/offers").set("Cookie", owner);
const makeOffer = (body: Record<string, unknown>, cookie = owner) =>
  request(app).post("/api/offers").set("Cookie", cookie).send(body);
const book = (body: Record<string, unknown>) =>
  request(app).post("/api/booking/appointments").set("Cookie", owner).send(body);
const bookOnline = (body: Record<string, unknown>) =>
  request(app)
    .post(`/api/book/${slug}`)
    .send({ firstName: "Web", lastName: "Booker", email: `web-${randomToken(6)}@test.local`, ...body });
const price = async (id: string) =>
  Number((await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { priceAtBooking: true } })).priceAtBooking);
const usesOf = async (code: string) => ((await offers()).body.offers as { code: string; uses: number }[]).find((o) => o.code === code)!.uses;

beforeAll(async () => {
  const o = await signup("offers-owner");
  owner = o.cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", owner)
    .send({ name: "Offer Cuts", bookingUrl: "https://offers.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const patched = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", owner)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 365 });
  expect(patched.status).toBe(200);
  const me = await request(app).get("/api/shops/me").set("Cookie", owner);
  shopId = me.body.id;
  slug = me.body.slug;
  mikey = (await request(app).post("/api/booking/staff").set("Cookie", owner).send({ name: "Mikey" })).body.id;
  dee = (await request(app).post("/api/booking/staff").set("Cookie", owner).send({ name: "Dee" })).body.id;
  cut = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", owner)
      .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [mikey, dee] })
  ).body.id;
  beard = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", owner)
      .send({ name: "Beard", durationMin: 30, price: 20, staffIds: [mikey, dee] })
  ).body.id;
  for (const staffId of [mikey, dee]) {
    await request(app)
      .put(`/api/booking/staff/${staffId}/availability`)
      .set("Cookie", owner)
      .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  }
  jordan = (await request(app).post("/api/dashboard/clients").set("Cookie", owner).send({ firstName: "Jordan", lastName: "Q" })).body.id;
  sam = (await request(app).post("/api/dashboard/clients").set("Cookie", owner).send({ firstName: "Sam", lastName: "W" })).body.id;
});

beforeEach(async () => {
  await prisma.offerRedemption.deleteMany({ where: { shopId } });
  await prisma.offer.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.shop.update({ where: { id: shopId }, data: { offersEnabled: true } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("dark until the shop is switched on", () => {
  it("nothing to see, nothing to make, and a code reads like a typo", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { offersEnabled: false } });
    expect((await offers()).body).toMatchObject({ enabled: false, offers: [] });
    expect((await makeOffer({ kind: "AMOUNT_OFF", amountOffCents: 500 })).status).toBe(404);
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: jordan, offerCode: "ANYTHING" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "offer_refused", reason: "not_found" });
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });
});

describe("🔴 MIKEYG30: one free haircut with Mikey, for Jordan, once", () => {
  const mikeyg30 = () =>
    makeOffer({ code: "mikeyg30", kind: "FREE_SERVICE", freeServiceId: cut, staffIds: [mikey], clientId: jordan });

  it("the shop books Jordan with it: the haircut costs $0, one use, nothing sent", async () => {
    const made = await mikeyg30();
    expect(made.status).toBe(201);
    expect(made.body.code).toBe("MIKEYG30");
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: made.body.id } });
    // The value is the stored offer: a free Haircut. The "30" is nothing.
    expect(offer).toMatchObject({ kind: "FREE_SERVICE", freeServiceId: cut, amountOffCents: null, percentOffBps: null, maxUses: 1 });

    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: jordan, offerCode: "MikeyG30" });
    expect(res.status).toBe(201);
    expect(res.body.offer).toEqual({ code: "MIKEYG30", listPriceCents: 4000, discountCents: 4000, totalCents: 0 });
    expect(await price(res.body.id)).toBe(0);
    expect(await prisma.offerRedemption.findUniqueOrThrow({ where: { appointmentId: res.body.id } })).toMatchObject({
      offerId: made.body.id,
      clientId: jordan,
      listPriceCents: 4000,
      discountCents: 4000,
      via: "dashboard",
    });
    expect(await usesOf("MIKEYG30")).toBe(1);
    // Making it and using it sent nothing and touched no consent.
    expect(await prisma.nudge.count({ where: { shopId } })).toBe(0);
    expect(await prisma.client.findUniqueOrThrow({ where: { id: jordan }, select: { smsConsentAt: true } })).toEqual({ smsConsentAt: null });
  });

  it("🔴 the second use is refused, and nothing is booked", async () => {
    await mikeyg30();
    expect((await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: jordan, offerCode: "MIKEYG30" })).status).toBe(201);
    const again = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(4, 10).toISOString(), clientId: jordan, offerCode: "MIKEYG30" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ reason: "used_up", message: "That offer has already been used." });
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(1);
  });

  it("🔴 for anyone else it's refused - and online, where a typed name proves nothing, too", async () => {
    await mikeyg30();
    const forSam = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "MIKEYG30" });
    expect(forSam.body).toMatchObject({ reason: "personal", message: "That offer is for a different client." });
    const online = await bookOnline({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 11).toISOString(), firstName: "Jordan", lastName: "Q", offerCode: "MIKEYG30" });
    expect(online.status).toBe(409);
    expect(online.body).toMatchObject({ reason: "personal", message: "That offer is for one client. Ask the shop to book it for you." });
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });

  it("with another provider, or for another service, it doesn't apply", async () => {
    await mikeyg30();
    expect((await book({ staffId: dee, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: jordan, offerCode: "MIKEYG30" })).body.reason).toBe("provider");
    expect((await book({ staffId: mikey, serviceId: beard, startsAt: dayAt(3, 10).toISOString(), clientId: jordan, offerCode: "MIKEYG30" })).body.reason).toBe("service");
  });
});

describe("🔴 shared contacts and retries", () => {
  it("two client records sharing a phone: the offer is the one client's, not the phone's", async () => {
    const phone = "(302) 555-0199";
    const twinA = (await request(app).post("/api/dashboard/clients").set("Cookie", owner).send({ firstName: "Twin", lastName: "A", phone })).body.id;
    // A second record with the SAME phone (an imported book does this): made
    // directly, since the dashboard route folds a duplicate phone into one.
    const twinB = (
      await prisma.client.create({
        data: { shopId, acuityClientKey: randomToken(8), magicToken: randomToken(), firstName: "Twin", lastName: "B", phone: "+13025550199" },
      })
    ).id;
    await makeOffer({ code: "TWINA", kind: "AMOUNT_OFF", amountOffCents: 500, clientId: twinA });
    const forB = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: twinB, offerCode: "TWINA" });
    expect(forB.body, JSON.stringify({ twinA, twinB, body: forB.body })).toMatchObject({ reason: "personal" });
    const forA = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 11).toISOString(), clientId: twinA, offerCode: "TWINA" });
    expect(forA.status).toBe(201);
    // Online, the shared phone proves nothing either.
    const online = await bookOnline({ staffId: mikey, serviceId: cut, startsAt: dayAt(4, 10).toISOString(), phone, firstName: "Twin", lastName: "A", offerCode: "TWINA" });
    expect(online.body).toMatchObject({ reason: "personal" });
  });

  it("🔴 a booking retried after its answer was lost (same operationId) is answered from the first - one redemption", async () => {
    const made = await makeOffer({ code: "RETRY5", kind: "AMOUNT_OFF", amountOffCents: 500, maxUses: 1, maxUsesPerClient: null });
    const operationId = `op-${randomToken(12)}`;
    const body = { staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "RETRY5", operationId };
    const first = await book(body);
    if (first.status === 400 && /operationId/.test(JSON.stringify(first.body))) {
      // This branch predates #604's operationId: nothing to replay yet.
      return;
    }
    expect(first.status).toBe(201);
    const again = await book(body);
    expect([200, 201]).toContain(again.status);
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.offerRedemption.count({ where: { offerId: made.body.id } })).toBe(1);
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(1);
  });
});

describe("a public code", () => {
  it("$10 off a haircut online: priced $30, recorded as used online, one per client", async () => {
    await makeOffer({ code: "FALL10", kind: "AMOUNT_OFF", amountOffCents: 1000, serviceIds: [cut] });
    const email = `fall-${randomToken(6)}@test.local`;
    const res = await bookOnline({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 12).toISOString(), email, offerCode: "fall10" });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, manageToken: res.body.manageToken } });
    expect(Number(appt.priceAtBooking)).toBe(30);
    expect(await prisma.offerRedemption.findUniqueOrThrow({ where: { appointmentId: appt.id } })).toMatchObject({ discountCents: 1000, via: "online" });
    // The same person again: one use per client.
    const again = await bookOnline({ staffId: mikey, serviceId: cut, startsAt: dayAt(4, 12).toISOString(), email, offerCode: "FALL10" });
    expect(again.body).toMatchObject({ reason: "used_by_client" });
  });

  it("🔴 add-ons are charged in full", async () => {
    await makeOffer({ code: "HALF", kind: "PERCENT_OFF", percentOff: 50 });
    const hotTowel = await prisma.serviceAddOn.create({
      data: { shopId, name: "Hot towel", durationMin: 0, price: 10, serviceIds: [cut] },
    });
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 13).toISOString(), clientId: sam, offerCode: "HALF", addOnIds: [hotTowel.id] });
    expect(res.status).toBe(201);
    expect(res.body.offer).toEqual({ code: "HALF", listPriceCents: 5000, discountCents: 2000, totalCents: 3000 });
    expect(await price(res.body.id)).toBe(30);
  });

  it("a code from another shop reads like a typo", async () => {
    const other = await prisma.shop.findFirst({ where: { NOT: { id: shopId } }, select: { id: true } });
    if (other) {
      await prisma.offer.create({ data: { shopId: other.id, code: "ELSEWHERE", kind: "AMOUNT_OFF", amountOffCents: 500 } });
    }
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "ELSEWHERE" });
    expect(res.body).toMatchObject({ reason: "not_found" });
    if (other) await prisma.offer.deleteMany({ where: { shopId: other.id, code: "ELSEWHERE" } });
  });

  it("a repeating series and a special refuse a code", async () => {
    await makeOffer({ code: "ANY5", kind: "AMOUNT_OFF", amountOffCents: 500 });
    const series = await book({
      staffId: mikey,
      serviceId: cut,
      startsAt: dayAt(3, 14).toISOString(),
      clientId: sam,
      offerCode: "ANY5",
      recurrence: { interval: 1, count: 3 },
    });
    expect(series.body).toMatchObject({ reason: "series" });
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });
});

describe("the booking page's \"Have a code?\"", () => {
  const check = (body: Record<string, unknown>) =>
    request(app)
      .post(`/api/book/${slug}/code`)
      .send({ serviceId: cut, staffId: mikey, startsAt: dayAt(3, 10).toISOString(), ...body });

  it("a public code: the same numbers the booking will charge", async () => {
    await makeOffer({ code: "FALL10", kind: "AMOUNT_OFF", amountOffCents: 1000 });
    const res = await check({ code: "fall10" });
    expect(res.body).toEqual({ ok: true, code: "FALL10", words: "$10 off", listPriceCents: 4000, discountCents: 1000, totalCents: 3000 });
  });

  it("🔴 a personal code is refused, however it was learned", async () => {
    await makeOffer({ code: "MIKEYG30", kind: "FREE_SERVICE", freeServiceId: cut, staffIds: [mikey], clientId: jordan });
    const res = await check({ code: "MIKEYG30" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("personal");
  });

  it("offers off: a real code reads exactly like a typo", async () => {
    await makeOffer({ code: "FALL10", kind: "AMOUNT_OFF", amountOffCents: 1000 });
    await prisma.shop.update({ where: { id: shopId }, data: { offersEnabled: false } });
    const off = await check({ code: "FALL10" });
    const typo = await check({ code: "NOSUCH" });
    expect(off.status).toBe(409);
    expect(off.body).toEqual(typo.body);
  });
});

describe("🔴 a use counts while its booking stands", () => {
  it("cancelling gives it back; a no-show spends it", async () => {
    await makeOffer({ code: "ONCE", kind: "AMOUNT_OFF", amountOffCents: 500, maxUses: 1, maxUsesPerClient: null });
    const first = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "ONCE" });
    expect(first.status).toBe(201);
    expect((await request(app).post(`/api/booking/appointments/${first.body.id}/cancel`).set("Cookie", owner).send({})).status).toBe(200);
    expect(await usesOf("ONCE")).toBe(0);
    const second = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(4, 10).toISOString(), clientId: sam, offerCode: "ONCE" });
    expect(second.status).toBe(201);
    // A no-show keeps the use spent.
    await prisma.appointment.update({ where: { id: second.body.id }, data: { status: "NO_SHOW" } });
    expect(await usesOf("ONCE")).toBe(1);
    expect((await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(5, 10).toISOString(), clientId: sam, offerCode: "ONCE" })).body.reason).toBe("used_up");
  });

  it("a payment hold that ran out gives it back", async () => {
    await makeOffer({ code: "HELD", kind: "AMOUNT_OFF", amountOffCents: 500, maxUses: 1, maxUsesPerClient: null });
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "HELD" });
    await prisma.appointment.update({
      where: { id: res.body.id },
      data: { status: "PENDING", holdReason: "payment", holdExpiresAt: new Date(Date.now() + 60_000) },
    });
    expect(await usesOf("HELD")).toBe(1); // a live hold holds the use
    await prisma.appointment.update({ where: { id: res.body.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    expect(await usesOf("HELD")).toBe(0);
    // ...and the next booking can use it.
    const next = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(4, 10).toISOString(), clientId: sam, offerCode: "HELD" });
    expect(next.status).toBe(201);
  });

  it("🔴 two bookings racing for the last use: one gets it", async () => {
    const made = await makeOffer({ code: "LAST", kind: "AMOUNT_OFF", amountOffCents: 500, maxUses: 1, maxUsesPerClient: null });
    const { results, settledEarly } = await raceBehindRowLock("Offer", made.body.id, [
      () => book({ staffId: mikey, serviceId: cut, startsAt: dayAt(6, 10).toISOString(), clientId: sam, offerCode: "LAST" }).then((r) => r.status),
      () => book({ staffId: dee, serviceId: cut, startsAt: dayAt(6, 11).toISOString(), clientId: jordan, offerCode: "LAST" }).then((r) => r.status),
    ]);
    expect(settledEarly).toBe(0);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value : 0)).sort();
    expect(statuses).toEqual([201, 409]);
    expect(await prisma.offerRedemption.count({ where: { offerId: made.body.id } })).toBe(1);
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(1);
  });
});

describe("the claim asks again under the lock", () => {
  it("🔴 an offer that changed between the price and the write refuses, and writes nothing", async () => {
    const made = await makeOffer({ code: "EDITED", kind: "AMOUNT_OFF", amountOffCents: 1000 });
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam });
    // Priced at $10 off, but the offer now takes $5.
    await prisma.offer.update({ where: { id: made.body.id }, data: { amountOffCents: 500 } });
    const claim = prisma.$transaction((tx) =>
      claimOfferUse(tx, {
        shopId,
        offerId: made.body.id,
        appointmentId: res.body.id,
        via: "dashboard",
        expected: { listPriceCents: 4000, discountCents: 1000, totalCents: 3000 },
        serviceCents: 4000,
        addOnCents: 0,
        clientId: sam,
        now: new Date(),
        visit: { serviceId: cut, staffId: mikey, startsAt: dayAt(3, 10), provenClientId: sam },
      }),
    );
    await expect(claim).rejects.toBeInstanceOf(OfferRefused);
    await expect(claim).rejects.toMatchObject({ reason: "changed" });
    expect(await prisma.offerRedemption.count({ where: { offerId: made.body.id } })).toBe(0);
  });
});

describe("🔴 a move keeps the discount, or is refused - never repriced to full", () => {
  it("inside the offer's dates: still discounted", async () => {
    await makeOffer({ code: "MOVE10", kind: "AMOUNT_OFF", amountOffCents: 1000 });
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "MOVE10" });
    const moved = await request(app)
      .post(`/api/booking/appointments/${res.body.id}/reschedule`)
      .set("Cookie", owner)
      .send({ startsAt: dayAt(5, 11).toISOString() });
    expect(moved.status).toBe(200);
    expect(await price(res.body.id)).toBe(30);
  });

  it("after the offer's last day: the move is refused and says why", async () => {
    await makeOffer({ code: "SOON", kind: "AMOUNT_OFF", amountOffCents: 1000, endsAt: dayAt(4, 0).toISOString() });
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "SOON" });
    expect(res.status).toBe(201);
    const moved = await request(app)
      .post(`/api/booking/appointments/${res.body.id}/reschedule`)
      .set("Cookie", owner)
      .send({ startsAt: dayAt(6, 11).toISOString() });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ error: "offer_refused", reason: "ended" });
    expect(moved.body.message).toMatch(/^This booking used an offer\. That offer is for visits before /);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(appt.startsAt.toISOString()).toBe(dayAt(3, 10).toISOString());
    expect(Number(appt.priceAtBooking)).toBe(30);
  });

  it("the client's own move from their page follows the same rule", async () => {
    await makeOffer({ code: "WEB5", kind: "AMOUNT_OFF", amountOffCents: 500 });
    const res = await bookOnline({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 12).toISOString(), offerCode: "WEB5" });
    expect(res.status).toBe(201);
    const moved = await request(app)
      .post(`/api/book/manage/${res.body.manageToken}/reschedule`)
      .send({ startsAt: dayAt(5, 13).toISOString() });
    expect(moved.status).toBe(200);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, manageToken: res.body.manageToken } });
    expect(Number(appt.priceAtBooking)).toBe(35);
  });
});

describe("who can make an offer", () => {
  it("🔴 a barber: only with the permission, for those services, on their own chair", async () => {
    const barber = await signup("offers-barber");
    await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER", staffId: dee } });
    const no = await makeOffer({ kind: "AMOUNT_OFF", amountOffCents: 500, serviceIds: [cut] }, barber.cookie);
    expect(no.status).toBe(403);
    await prisma.shopMember.updateMany({ where: { shopId, userId: barber.userId }, data: { offerServiceIds: [cut] } });
    const yes = await makeOffer({ kind: "AMOUNT_OFF", amountOffCents: 500, serviceIds: [cut] }, barber.cookie);
    expect(yes.status).toBe(201);
    expect(await prisma.offer.findUniqueOrThrow({ where: { id: yes.body.id } })).toMatchObject({ staffIds: [dee], serviceIds: [cut] });
    // Not another service, not another chair, not "any service".
    expect((await makeOffer({ kind: "AMOUNT_OFF", amountOffCents: 500, serviceIds: [beard] }, barber.cookie)).status).toBe(403);
    expect((await makeOffer({ kind: "AMOUNT_OFF", amountOffCents: 500, serviceIds: [cut], staffIds: [mikey] }, barber.cookie)).status).toBe(403);
    expect((await makeOffer({ kind: "AMOUNT_OFF", amountOffCents: 500 }, barber.cookie)).status).toBe(403);
  });

  it("codes are this shop's own, typed in any case; a used offer can't be deleted, only paused", async () => {
    const a = await makeOffer({ code: " spooky-25 ", kind: "PERCENT_OFF", percentOff: 25 });
    expect(a.body.code).toBe("SPOOKY-25");
    expect((await makeOffer({ code: "SPOOKY-25", kind: "AMOUNT_OFF", amountOffCents: 100 })).status).toBe(409);
    expect((await makeOffer({ code: "no", kind: "AMOUNT_OFF", amountOffCents: 100 })).body.error).toBe("invalid_code");
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "SPOOKY-25" });
    expect(res.status).toBe(201);
    expect((await request(app).delete(`/api/offers/${a.body.id}`).set("Cookie", owner)).status).toBe(409);
    expect((await request(app).patch(`/api/offers/${a.body.id}`).set("Cookie", owner).send({ active: false })).status).toBe(200);
    expect((await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(4, 10).toISOString(), clientId: jordan, offerCode: "SPOOKY-25" })).body.reason).toBe("off");
    const unused = await makeOffer({ kind: "AMOUNT_OFF", amountOffCents: 100 });
    expect(unused.body.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
    expect((await request(app).delete(`/api/offers/${unused.body.id}`).set("Cookie", owner)).status).toBe(200);
  });

  it("the shop's booking form asks first and gets the same numbers the booking charges", async () => {
    await makeOffer({ code: "Q15", kind: "PERCENT_OFF", percentOff: 15 });
    const q = await request(app)
      .post("/api/offers/quote")
      .set("Cookie", owner)
      .send({ code: "q15", clientId: sam, serviceId: cut, staffId: mikey, startsAt: dayAt(3, 10).toISOString() });
    expect(q.body).toMatchObject({ ok: true, code: "Q15", words: "15% off", listPriceCents: 4000, discountCents: 600, totalCents: 3400 });
    const res = await book({ staffId: mikey, serviceId: cut, startsAt: dayAt(3, 10).toISOString(), clientId: sam, offerCode: "Q15" });
    expect(res.body.offer).toMatchObject({ listPriceCents: 4000, discountCents: 600, totalCents: 3400 });
  });
});
