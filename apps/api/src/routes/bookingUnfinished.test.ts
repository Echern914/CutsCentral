import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";

/**
 * "Didn't finish booking": the clients a payment hold left behind.
 *
 * A card-on-file shop's client picks a time, presses Confirm, and never saves
 * the card - they left, or Cash App never approved. Ten minutes later the hold
 * lapses and the time goes back on sale, while the client may think they are
 * booked. The shop could not see who it was. This list is how it can.
 *
 * Stripe is a fake at the network edge (as in bookingFinishCheckout.test.ts).
 */

const fake = vi.hoisted(() => {
  type SI = { id: string; status: string; client_secret: string; customer: string; payment_method: string | null; metadata: Record<string, string> };
  const setupIntents = new Map<string, SI>();
  let n = 0;
  return {
    setupIntents,
    client: {
      customers: { create: vi.fn(async () => ({ id: `cus_unf_${++n}` })) },
      setupIntents: {
        create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }) => {
          const id = `seti_unf_${++n}`;
          const si: SI = {
            id,
            status: "requires_payment_method",
            client_secret: `${id}_secret`,
            customer: params.customer,
            payment_method: null,
            metadata: params.metadata,
          };
          setupIntents.set(id, si);
          return si;
        }),
        retrieve: vi.fn(async (id: string) => {
          const si = setupIntents.get(id);
          if (!si) throw new Error(`no such setup intent ${id}`);
          return si;
        }),
      },
      paymentMethods: {
        retrieve: vi.fn(async (id: string) => ({ id, card: { brand: "visa", last4: "4242" } })),
        detach: vi.fn(async (id: string) => ({ id })),
      },
      accounts: {
        retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })),
      },
    },
    succeed(id: string) {
      const si = setupIntents.get(id)!;
      si.status = "succeeded";
      si.payment_method = `pm_unf_${id}`;
    },
  };
});

vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  stripeClient: () => fake.client,
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
const password = "supersecret123";
const emails: string[] = [];

/** A distinct, valid number per person: one client record each. */
let phoneSeq = 10;
const newPhone = () => `(302) 555-01${String(phoneSeq++).padStart(2, "0")}`;
const e164 = (pretty: string) => `+1${pretty.replace(/\D/g, "")}`;

function at(daysAhead: number, hourUtc: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

interface Person {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

function person(firstName: string, lastName: string, phone = newPhone()): Person {
  return { firstName, lastName, phone, email: `${firstName.toLowerCase()}-${randomToken(4)}@example.com` };
}

/** The client's side: pick a time and press Confirm. Leaves a live hold. */
async function tryToBook(who: Person, when: Date): Promise<{ id: string; manageToken: string; setupIntentId: string }> {
  const res = await request(app)
    .post(`/api/book/${slug}`)
    .send({ staffId, serviceId, startsAt: when.toISOString(), ...who });
  expect(res.status).toBe(201);
  expect(res.body.payment?.kind).toBe("setup");
  const appt = await prisma.appointment.findUniqueOrThrow({
    where: { manageToken: res.body.manageToken },
    select: { id: true },
  });
  return {
    id: appt.id,
    manageToken: res.body.manageToken,
    setupIntentId: (res.body.payment.clientSecret as string).replace(/_secret$/, ""),
  };
}

/** The ten minutes run out (without the sweep, unless asked). */
async function expire(id: string): Promise<void> {
  await prisma.appointment.update({
    where: { id },
    data: { holdExpiresAt: new Date(Date.now() - 1000) },
  });
}

async function sweep(): Promise<void> {
  const { sweepExpiredPaymentHolds } = await import("../services/appointmentPaymentHold.js");
  await sweepExpiredPaymentHolds(new Date());
}

/** An attempt that ran out and was swept: what the shop finds the next day. */
async function lapsed(who: Person, when: Date) {
  const attempt = await tryToBook(who, when);
  await expire(attempt.id);
  await sweep();
  return attempt;
}

async function finish(attempt: { manageToken: string; setupIntentId: string }): Promise<void> {
  fake.succeed(attempt.setupIntentId);
  const saved = await request(app).post(`/api/book/manage/${attempt.manageToken}/card-saved`);
  expect(saved.body.status).toBe("BOOKED");
}

interface Row {
  id: string;
  clientId: string | null;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  phoneDisplay: string | null;
  email: string | null;
  canText: boolean;
  profileName: string | null;
  staffId: string;
  staffName: string;
  serviceId: string;
  serviceName: string;
  startsAt: string;
  triedAt: string;
  attempts: number;
  state: "live" | "lapsed";
  heldUntil: string | null;
  timeTaken: boolean;
  reason: string | null;
  targetedSlotId: string | null;
  repeating: boolean;
  otherTimes: { startsAt: string; serviceName: string }[];
}

async function list(as = cookie): Promise<{ timezone: string; more: number; rows: Row[] }> {
  const res = await request(app).get("/api/booking/unfinished").set("Cookie", as);
  expect(res.status).toBe(200);
  return res.body;
}

async function rowFor(who: Person): Promise<Row | undefined> {
  return (await list()).rows.find((r) => r.phone === e164(who.phone));
}

async function signup(tag: string): Promise<{ id: string; cookie: string }> {
  const email = `unf-${tag}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: tag, smsAttested: true });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, cookie: (res.headers["set-cookie"] as unknown as string[])[0]! };
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  cookie = (await signup("owner")).cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Unfinished Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  slug = patch.body.slug;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] })
  ).body.id;
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: `acct_unf_${randomToken(6)}`, connectChargesEnabled: true },
  });
  const settings = await request(app)
    .patch("/api/payments/settings")
    .set("Cookie", cookie)
    // Card-or-nothing: the list exists for clients whose hold ran out, which
    // only happens when the card is required to book.
    .send({ paymentsMode: "card_on_file", requireCardToBook: true });
  expect(settings.status).toBe(200);
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) continue;
    // EmailIntent has no foreign key to Shop, so deleting the shop would leave
    // the cancellation email this file queues PENDING for every other file's
    // outbox drain to trip over.
    const shops = await prisma.shop.findMany({ where: { ownerId: user.id }, select: { id: true } });
    await prisma.emailIntent.deleteMany({ where: { shopId: { in: shops.map((s) => s.id) } } });
    await prisma.shopMember.deleteMany({ where: { userId: user.id } });
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("who is on the list", () => {
  it("🔴 a client whose hold ran out is listed: who, the time they wanted, how to reach them", async () => {
    const who = person("Lena", "Ortiz");
    const when = at(2, 10);
    const attempt = await lapsed(who, when);

    const body = await list();
    expect(body.timezone).toBe("UTC");
    const row = body.rows.find((r) => r.id === attempt.id);
    expect(row).toMatchObject({
      firstName: "Lena",
      lastName: "Ortiz",
      phone: e164(who.phone),
      phoneDisplay: who.phone,
      email: who.email,
      canText: true,
      profileName: null,
      staffId,
      staffName: "Sam",
      serviceId,
      serviceName: "Haircut",
      startsAt: when.toISOString(),
      attempts: 1,
      state: "lapsed",
      heldUntil: null,
      timeTaken: false,
      releasing: false,
      blockedElsewhere: false,
      reason: "card_not_saved",
      wantedSpecial: false,
      targetedSlotId: null,
      repeating: false,
      otherTimes: [],
    });
    expect(row!.clientId).toEqual(expect.any(String));
  });

  it("a client on the card step right now is listed as still finishing", async () => {
    const who = person("Ade", "Bello");
    const attempt = await tryToBook(who, at(2, 11));
    const held = await prisma.appointment.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { holdExpiresAt: true },
    });
    const row = await rowFor(who);
    expect(row).toMatchObject({ state: "live", reason: null, timeTaken: false });
    expect(row!.heldUntil).toBe(held.holdExpiresAt!.toISOString());
  });

  it("🔴 a hold that ran out but hasn't been swept yet is lapsed, not still finishing - and still releasing", async () => {
    const who = person("Noor", "Haddad");
    const attempt = await tryToBook(who, at(2, 12));
    await expire(attempt.id);
    // Not bookable yet: the booking guard would cancel it without giving back
    // what the sweep gives back (its special, Acuity block, payment).
    expect(await rowFor(who)).toMatchObject({ id: attempt.id, state: "lapsed", heldUntil: null, releasing: true });
    await sweep();
    expect(await rowFor(who)).toMatchObject({ id: attempt.id, state: "lapsed", releasing: false });
  });

  it("🔴 a client who saved their card is booked, and never listed", async () => {
    const who = person("Finn", "Walsh");
    await finish(await tryToBook(who, at(2, 13)));
    expect(await rowFor(who)).toBeUndefined();
  });

  it("🔴 a client who booked again since is not listed", async () => {
    const who = person("Iris", "Moreau");
    await lapsed(who, at(2, 14));
    expect(await rowFor(who)).toBeDefined();
    // Same number, a later booking that went through.
    await finish(await tryToBook(who, at(3, 9)));
    expect(await rowFor(who)).toBeUndefined();
  });

  it("a later attempt AFTER a real booking is listed again - it is a new unfinished time", async () => {
    const who = person("Omar", "Said");
    await finish(await tryToBook(who, at(3, 10)));
    const again = await lapsed(who, at(3, 11));
    expect((await rowFor(who))?.id).toBe(again.id);
  });

  it("past times are not listed", async () => {
    const who = person("Pia", "Lund");
    const attempt = await lapsed(who, at(3, 12));
    const yesterday = at(-1, 12);
    await prisma.appointment.update({
      where: { id: attempt.id },
      data: { startsAt: yesterday, endsAt: new Date(yesterday.getTime() + 30 * 60_000) },
    });
    expect(await rowFor(who)).toBeUndefined();
  });

  it("🔴 a hold cancelled before its deadline was not abandoned, and is not listed", async () => {
    // What an Acuity refusal or a decline leaves: cancelled while still held,
    // and the client was told on the spot.
    const who = person("Rui", "Costa");
    const attempt = await tryToBook(who, at(3, 13));
    await prisma.appointment.update({
      where: { id: attempt.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    expect(await rowFor(who)).toBeUndefined();
  });

  it("a client who deleted their data is not listed", async () => {
    const who = person("Sol", "Vega");
    const attempt = await lapsed(who, at(3, 14));
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: attempt.id }, select: { clientId: true } });
    await prisma.client.update({ where: { id: appt.clientId! }, data: { optOutSource: "deleted" } });
    expect(await rowFor(who)).toBeUndefined();
  });

  it("🔴 one row per person: the latest try, the other times under it, every try counted", async () => {
    const who = person("Tess", "Grant");
    const first = at(4, 9);
    const second = at(4, 10);
    await lapsed(who, first);
    await lapsed(who, second);
    const latest = await lapsed(who, second);
    const rows = (await list()).rows.filter((r) => r.phone === e164(who.phone));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: latest.id,
      startsAt: second.toISOString(),
      attempts: 3,
      otherTimes: [{ startsAt: first.toISOString(), serviceName: "Haircut" }],
    });
  });
});

describe("what the row says", () => {
  it("🔴 the time they wanted, now someone else's, says so", async () => {
    const who = person("Uma", "Reyes");
    const when = at(4, 11);
    await lapsed(who, when);
    expect((await rowFor(who))?.timeTaken).toBe(false);
    await finish(await tryToBook(person("Vic", "Hale"), when));
    expect((await rowFor(who))?.timeTaken).toBe(true);
  });

  it("a card saved after the hold ran out says so", async () => {
    const who = person("Wes", "Park");
    const attempt = await tryToBook(who, at(4, 12));
    await expire(attempt.id);
    fake.succeed(attempt.setupIntentId);
    await request(app).post(`/api/book/manage/${attempt.manageToken}/card-saved`);
    await sweep();
    expect(await rowFor(who)).toMatchObject({ state: "lapsed", reason: "card_saved_late" });
  });

  it("a client who texted STOP can be called but not texted", async () => {
    const who = person("Xan", "Cole");
    const attempt = await lapsed(who, at(4, 13));
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: attempt.id }, select: { clientId: true } });
    await prisma.client.update({ where: { id: appt.clientId! }, data: { optedOut: true } });
    expect(await rowFor(who)).toMatchObject({ canText: false, phone: e164(who.phone) });
  });

  it("🔴 a shared phone: listed by the name THEY typed, with whose profile it is", async () => {
    const phone = newPhone();
    await finish(await tryToBook(person("Maria", "Lopez", phone), at(5, 9)));
    await lapsed(person("Tony", "Lopez", phone), at(5, 10));
    const row = await rowFor({ firstName: "", lastName: "", phone, email: "" });
    expect(row).toMatchObject({ firstName: "Tony", lastName: "Lopez", profileName: "Maria Lopez" });
  });

  it("the same first name typed a little differently is still them - no profile warning", async () => {
    const phone = newPhone();
    await lapsed(person("Gabe", "Ruiz", phone), at(5, 13));
    await lapsed({ firstName: "gabe", lastName: "R", phone, email: `gabe-${randomToken(4)}@example.com` }, at(5, 14));
    const rows = (await list()).rows.filter((r) => r.phone === e164(phone));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 2, profileName: null });
  });
});

describe("🔴 a shared phone is not the same person", () => {
  it("one person's booking does not hide another's unfinished try on the same number", async () => {
    const phone = newPhone();
    // The son tries first and leaves; the mother books afterwards, same phone.
    const tony = await lapsed(person("Tony", "Vance", phone), at(7, 10));
    await finish(await tryToBook(person("Maria", "Vance", phone), at(7, 11)));
    const rows = (await list()).rows.filter((r) => r.phone === e164(phone));
    expect(rows.map((r) => r.id)).toEqual([tony.id]);
    expect(rows[0]).toMatchObject({ firstName: "Tony" });
  });

  it("two people's tries on one number are two rows, and Dismiss takes off only one", async () => {
    const phone = newPhone();
    const tony = await lapsed(person("Tony", "Kerr", phone), at(7, 12));
    const maria = await lapsed(person("Maria", "Kerr", phone), at(7, 13));
    let rows = (await list()).rows.filter((r) => r.phone === e164(phone));
    expect(rows.map((r) => r.firstName).sort()).toEqual(["Maria", "Tony"]);
    expect(rows.every((r) => r.attempts === 1 && r.otherTimes.length === 0)).toBe(true);

    // Maria's is the NEWER try, so only the first-name rule keeps Tony's.
    const res = await request(app).post(`/api/booking/unfinished/${maria.id}/dismiss`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    rows = (await list()).rows.filter((r) => r.phone === e164(phone));
    expect(rows.map((r) => r.id)).toEqual([tony.id]);
  });
});

describe("what counts as booked since", () => {
  it("🔴 the exact time they wanted, booked on their profile under the PROFILE's name, takes them off", async () => {
    const phone = newPhone();
    // The profile says Michael; on the booking page he types Mike.
    await finish(await tryToBook(person("Michael", "Ruiz", phone), at(10, 9)));
    const when = at(10, 11);
    await lapsed({ firstName: "Mike", lastName: "Ruiz", phone, email: `mike-${randomToken(4)}@example.com` }, when);
    const row = (await rowFor({ firstName: "", lastName: "", phone, email: "" }))!;
    expect(row).toMatchObject({ firstName: "Mike", profileName: "Michael Ruiz" });
    // New appointment with his profile picked: written as "Michael".
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt: when.toISOString(), clientId: row.clientId });
    expect(res.status).toBe(201);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } })).firstName).toBe("Michael");
    expect(await rowFor({ firstName: "", lastName: "", phone, email: "" })).toBeUndefined();
  });

  it("names typed with different case, accents or punctuation are the same person", async () => {
    const { firstNameKey } = await import("../services/unfinishedBookings.js");
    expect(firstNameKey("  JOSÉ maria")).toBe("jose");
    expect(firstNameKey("Jose")).toBe("jose");
    expect(firstNameKey("D'Andre")).toBe(firstNameKey("Dandre"));
    expect(firstNameKey("")).toBe("");
    expect(firstNameKey("Mike")).not.toBe(firstNameKey("Michael"));
  });

  it("🔴 a booking that was refused or undone - never booked - does not hide them", async () => {
    const who = person("Hana", "Ito");
    const attempt = await lapsed(who, at(8, 9));
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: attempt.id }, select: { clientId: true } });
    // What an Acuity refusal or an undone forced booking leaves: CANCELED, no
    // hold, and no cancellation ever made (cancellationRevision 0).
    const later = at(8, 10);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: appt.clientId,
        firstName: "Hana",
        lastName: "Ito",
        startsAt: later,
        endsAt: new Date(later.getTime() + 30 * 60_000),
        status: "CANCELED",
        canceledAt: new Date(),
        manageToken: randomToken(),
      },
    });
    expect((await rowFor(who))?.id).toBe(attempt.id);
  });

  it("a real booking they later cancelled does hide them - they were told where they stand", async () => {
    const who = person("Ivo", "Banks");
    await lapsed(who, at(8, 11));
    const booked = await tryToBook(who, at(8, 12));
    await finish(booked);
    const cancel = await request(app).post(`/api/book/manage/${booked.manageToken}/cancel`).send({});
    expect(cancel.status).toBe(200);
    expect(await rowFor(who)).toBeUndefined();
  });
});

describe("what stands in the way of booking it now", () => {
  it("🔴 someone ELSE's hold at that exact time, run out but not swept, makes it 'releasing' too", async () => {
    const when = at(10, 13);
    const first = person("Nia", "Grey");
    await lapsed(first, when);
    const other = await tryToBook(person("Otto", "Fry"), when);
    await expire(other.id);
    expect(await rowFor(first)).toMatchObject({ releasing: true, timeTaken: false });
    await sweep();
    expect(await rowFor(first)).toMatchObject({ releasing: false });
  });

  it("time blocked on the other calendar, with nobody in it, is never 'open'", async () => {
    const when = at(10, 14);
    const who = person("Pax", "Lee");
    await lapsed(who, when);
    expect(await rowFor(who)).toMatchObject({ blockedElsewhere: false, timeTaken: false });
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:test-${randomToken(6)}`,
        startsAt: when,
        endsAt: new Date(when.getTime() + 60 * 60_000),
      },
    });
    expect(await rowFor(who)).toMatchObject({ blockedElsewhere: true, timeTaken: false });
  });
});

describe("a special they tried for", () => {
  async function publishSpecial(when: Date, durationMin: number, price: number): Promise<string> {
    const pub = await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt: when.toISOString(), durationMin, price });
    expect(pub.status).toBe(201);
    const slot = await prisma.targetedSlot.findFirstOrThrow({
      where: { shopId, staffId, startsAt: when, serviceId },
      select: { id: true },
    });
    return slot.id;
  }

  async function trySpecial(who: Person, when: Date, slotId: string) {
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({ staffId, serviceId, startsAt: when.toISOString(), targetedSlotId: slotId, ...who });
    expect(res.status).toBe(201);
    expect(res.body.payment?.kind).toBe("setup");
    const appt = await prisma.appointment.findUniqueOrThrow({
      where: { manageToken: res.body.manageToken },
      select: { id: true },
    });
    await expire(appt.id);
    await sweep();
    return appt.id;
  }

  it("🔴 is offered back AS that special, and Book them books it at the special's price", async () => {
    // After hours, the point of a special.
    const when = at(9, 20);
    const slotId = await publishSpecial(when, 60, 80);
    const who = person("Jin", "Park");
    await trySpecial(who, when, slotId);
    const row = (await rowFor(who))!;
    expect(row).toMatchObject({ wantedSpecial: true, targetedSlotId: slotId, timeTaken: false });

    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId: row.staffId,
        serviceId: row.serviceId,
        startsAt: row.startsAt,
        clientId: row.clientId,
        targetedSlotId: row.targetedSlotId,
      });
    expect(res.status).toBe(201);
    const booked = await prisma.appointment.findUniqueOrThrow({
      where: { id: res.body.id },
      select: { priceAtBooking: true, endsAt: true, bookedVia: true },
    });
    expect(Number(booked.priceAtBooking)).toBe(80);
    expect(booked.endsAt.getTime() - when.getTime()).toBe(60 * 60_000);
    expect(booked.bookedVia).toBe("targeted_slot");
    expect(await rowFor(who)).toBeUndefined();
  });

  it("a special that's no longer on offer is not quietly swapped for the menu service", async () => {
    const when = at(9, 21);
    const slotId = await publishSpecial(when, 60, 80);
    const who = person("Kai", "Wong");
    await trySpecial(who, when, slotId);
    await prisma.targetedSlot.update({ where: { id: slotId }, data: { active: false } });
    expect(await rowFor(who)).toMatchObject({ wantedSpecial: true, targetedSlotId: null });
  });

  it("a special inside time since blocked off is not on offer", async () => {
    const when = at(11, 20);
    const slotId = await publishSpecial(when, 60, 80);
    const who = person("Quin", "Rhee");
    await trySpecial(who, when, slotId);
    expect(await rowFor(who)).toMatchObject({ targetedSlotId: slotId });
    await prisma.availabilityException.create({
      data: {
        shopId,
        staffId,
        startsAt: new Date(when.getTime() - 60 * 60_000),
        endsAt: new Date(when.getTime() + 2 * 60 * 60_000),
        isBlock: true,
      },
    });
    expect(await rowFor(who)).toMatchObject({ wantedSpecial: true, targetedSlotId: null });
  });

  it("only the special for THEIR service, never another one at the same start", async () => {
    const when = at(9, 22);
    // Published FIRST, same start, same length - for another service only.
    const other = (
      await request(app)
        .post("/api/booking/services")
        .set("Cookie", cookie)
        .send({ name: "Braids", durationMin: 60, price: 150, staffIds: [staffId] })
    ).body.id as string;
    await prisma.targetedSlot.create({
      data: { shopId, staffId, serviceId: other, label: "Late braids", startsAt: when, durationMin: 60, price: 200 },
    });
    const slotId = await publishSpecial(when, 60, 80);
    const who = person("Lux", "Hart");
    await trySpecial(who, when, slotId);
    expect(await rowFor(who)).toMatchObject({ targetedSlotId: slotId });
  });
});

describe("why, from the payment rows", () => {
  it("🔴 money that came in and was never refunded is never 'didn't pay'", async () => {
    const { reasonFor } = await import("../services/unfinishedBookings.js");
    const pay = (status: string, refundedAmount = 0) => ({ cardOnFile: null, payments: [{ status, refundedAmount }] });
    expect(reasonFor(pay("succeeded"))).toBe("paid_late");
    expect(reasonFor(pay("requires_capture"))).toBe("paid_late");
    expect(reasonFor(pay("refunded", 1000))).toBe("paid_late_refunded");
    expect(reasonFor(pay("succeeded", 500))).toBe("paid_late_refunded");
    expect(reasonFor(pay("canceled"))).toBe("not_paid");
    expect(reasonFor(pay("requires_payment_method"))).toBe("not_paid");
    expect(reasonFor({ cardOnFile: null, payments: [] })).toBe("not_finished");
  });

  it("a repeating booking's card is read from its first date, even once that date is past", async () => {
    const { reasonFor } = await import("../services/unfinishedBookings.js");
    const later = { cardOnFile: null, payments: [] };
    expect(reasonFor(later, { savedAt: null })).toBe("card_not_saved");
    expect(reasonFor(later, { savedAt: new Date() })).toBe("card_saved_late");
  });
});

describe("Book them", () => {
  it("🔴 booking the time they wanted, from the dashboard, takes them off the list", async () => {
    const who = person("Yara", "Nunes");
    await lapsed(who, at(5, 11));
    const row = (await rowFor(who))!;
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId: row.staffId,
        serviceId: row.serviceId,
        startsAt: row.startsAt,
        clientId: row.clientId,
        phone: row.phone,
      });
    expect(res.status).toBe(201);
    const booked = await prisma.appointment.findUniqueOrThrow({
      where: { id: res.body.id },
      select: { status: true, clientId: true, phone: true, startsAt: true },
    });
    expect(booked).toEqual({
      status: "BOOKED",
      clientId: row.clientId,
      phone: row.phone,
      startsAt: new Date(row.startsAt),
    });
    expect(await rowFor(who)).toBeUndefined();
  });

  it("a time someone else has since booked is refused, so nobody is double-booked", async () => {
    const who = person("Zed", "Amari");
    const when = at(5, 12);
    await lapsed(who, when);
    await finish(await tryToBook(person("Abe", "Stone"), when));
    const row = (await rowFor(who))!;
    expect(row.timeTaken).toBe(true);
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId: row.staffId, serviceId: row.serviceId, startsAt: row.startsAt, clientId: row.clientId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
  });
});

/**
 * TELLING THEM. A barber can't text everyone (texting is off), and these
 * clients may think they're booked. Booking from the list emails them the
 * ordinary confirmation; a time someone else took gets one "pick another
 * time" email. Every other dashboard booking stays silent.
 */
describe("telling the client", () => {
  type Sent = {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string;
    meta?: Record<string, unknown>;
  };
  let sent: Sent[] = [];
  let attempts: Sent[] = [];
  /** "reject" = Resend refused it (nothing went out); "lost" = the answer never came. */
  let failNext: null | "reject" | "lost" = null;

  async function useMailer() {
    const { __setSendEmailForTests, ResendSendError } = await import("../messaging/email.js");
    const { armBackgroundWorkTracking } = await import("../backgroundWork.js");
    armBackgroundWorkTracking();
    sent = [];
    attempts = [];
    failNext = null;
    __setSendEmailForTests(async (input) => {
      attempts.push(input as Sent);
      const mode = failNext;
      failNext = null;
      if (mode === "reject") throw new ResendSendError(422);
      if (mode === "lost") throw new Error("The operation was aborted due to timeout");
      sent.push(input as Sent);
      return { id: `email_${sent.length}`, status: "sent" };
    });
  }
  /** Someone else books `when` (a real booking, card saved). */
  const takenBy = async (when: Date, first: string, last: string) =>
    finish(await tryToBook(person(first, last), when));
  async function noMailer() {
    const { __setSendEmailForTests } = await import("../messaging/email.js");
    const { disarmBackgroundWorkTracking } = await import("../backgroundWork.js");
    __setSendEmailForTests(undefined);
    disarmBackgroundWorkTracking();
  }
  async function settle() {
    const { settleBackgroundWork } = await import("../backgroundWork.js");
    await settleBackgroundWork();
  }
  const bookFromList = (row: Row, extra: Record<string, unknown> = {}) =>
    request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId: row.staffId,
        serviceId: row.serviceId,
        startsAt: row.startsAt,
        clientId: row.clientId,
        ...(row.phone ? { phone: row.phone } : {}),
        ...(row.email ? { email: row.email } : {}),
        ...extra,
      });
  const invite = (id: string) =>
    request(app).post(`/api/booking/unfinished/${id}/invite`).set("Cookie", cookie).send({});

  it("🔴 Book them from the list emails them the ordinary confirmation, and says so", async () => {
    await useMailer();
    try {
      const who = person("Cal", "Moss");
      await lapsed(who, at(8, 9));
      const row = (await rowFor(who))!;
      const res = await bookFromList(row, { confirmClient: true });
      expect(res.status).toBe(201);
      expect(res.body.clientConfirmation).toBe("email");
      await settle();
      const mine = sent.filter((m) => m.to === who.email);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.subject).toBe("Booking confirmed: Haircut at Unfinished Cuts");
    } finally {
      await noMailer();
    }
  });

  it("🔴 any other dashboard booking still sends nothing", async () => {
    await useMailer();
    try {
      const who = person("Dee", "Lyle");
      await lapsed(who, at(8, 10));
      const row = (await rowFor(who))!;
      const res = await bookFromList(row);
      expect(res.status).toBe(201);
      expect(res.body.clientConfirmation).toBeUndefined();
      await settle();
      expect(sent.filter((m) => m.to === who.email)).toHaveLength(0);
    } finally {
      await noMailer();
    }
  });

  it("🔴 a provider that refuses the confirmation: 'none' - read from the stamp, never predicted", async () => {
    await useMailer();
    try {
      const who = person("Bo", "Cruz");
      await lapsed(who, at(12, 9));
      const row = (await rowFor(who))!;
      failNext = "reject";
      const res = await bookFromList(row, { confirmClient: true });
      expect(res.status).toBe(201);
      expect(res.body.clientConfirmation).toBe("none");
      expect(sent.filter((m) => m.to === who.email)).toHaveLength(0);
    } finally {
      await noMailer();
    }
  });

  it("never claims an email it can't send - email off says 'none'", async () => {
    const who = person("Eli", "Ford");
    await lapsed(who, at(8, 11));
    const row = (await rowFor(who))!;
    const res = await bookFromList(row, { confirmClient: true });
    expect(res.status).toBe(201);
    expect(res.body.clientConfirmation).toBe("none");
  });

  it("🔴 DRY_RUN: email looks configured but nothing goes out - so it says 'none', never 'email'", async () => {
    const saved = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM, dry: process.env.DRY_RUN };
    process.env.RESEND_API_KEY = "re_test_dummy";
    process.env.EMAIL_FROM = "ChairBack <hello@example.com>";
    process.env.DRY_RUN = "true";
    __resetEnvCacheForTests();
    try {
      const who = person("Gio", "Hart");
      await lapsed(who, at(8, 16));
      const row = (await rowFor(who))!;
      const res = await bookFromList(row, { confirmClient: true });
      expect(res.status).toBe(201);
      expect(res.body.clientConfirmation).toBe("none");
    } finally {
      for (const [k, v] of [["RESEND_API_KEY", saved.key], ["EMAIL_FROM", saved.from], ["DRY_RUN", saved.dry]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      __resetEnvCacheForTests();
    }
  });

  it("a confirmation is for one booking, never a repeating one", async () => {
    const who = person("Fay", "Gray");
    await lapsed(who, at(8, 12));
    const row = (await rowFor(who))!;
    const res = await bookFromList(row, { confirmClient: true, recurrence: { interval: 1, count: 2 } });
    expect(res.status).toBe(400);
  });

  it("🔴 a time someone else took: one 'pick another time' email, with their service and staff picked - once", async () => {
    await useMailer();
    try {
      const who = person("Gus", "Hale");
      const when = at(8, 13);
      await lapsed(who, when);
      await takenBy(when, "Hal", "Ives");
      const row = (await rowFor(who))!;
      expect(row.timeTaken).toBe(true);
      expect((row as Row & { canInvite: boolean }).canInvite).toBe(true);

      const first = await invite(row.id);
      expect(first.status).toBe(200);
      const mine = sent.filter((m) => m.to === who.email);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.idempotencyKey).toBe(`unfinished-invite:${row.id}`);
      expect(mine[0]!.subject).toBe("Pick another time at Unfinished Cuts");
      expect(mine[0]!.html).toContain(`/book/${slug}?service=${serviceId}&amp;staff=${staffId}`);
      expect(mine[0]!.text).toMatch(/You're not booked for it/);
      expect(mine[0]!.html).not.toMatch(/cancel/i);
      expect(mine[0]!.html).not.toContain("/book/manage/");

      const again = await invite(row.id);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("already_invited");
      expect(sent.filter((m) => m.to === who.email)).toHaveLength(1);
      expect(((await rowFor(who)) as Row & { invitedAt: string | null }).invitedAt).toBe(first.body.invitedAt);
    } finally {
      await noMailer();
    }
  });

  it("🔴 race: two taps at once send ONE email", async () => {
    await useMailer();
    try {
      const who = person("Ida", "Jules");
      const when = at(8, 14);
      await lapsed(who, when);
      await takenBy(when, "Jay", "Kent");
      const row = (await rowFor(who))!;
      const { raceBehindRowLock } = await import("../testing/raceBarrier.js");
      const { settledEarly, results } = await raceBehindRowLock("Appointment", row.id, [
        () => invite(row.id),
        () => invite(row.id),
      ]);
      expect(settledEarly).toBe(0);
      const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
      expect(statuses).toEqual([200, 409]);
      expect(sent.filter((m) => m.to === who.email)).toHaveLength(1);
    } finally {
      await noMailer();
    }
  });

  it("a send Resend refused lets the claim go, so trying again works", async () => {
    await useMailer();
    try {
      const who = person("Kit", "Lane");
      const when = at(8, 15);
      await lapsed(who, when);
      await takenBy(when, "Lou", "Marsh");
      const row = (await rowFor(who))!;
      failNext = "reject";
      const failed = await invite(row.id);
      expect(failed.status).toBe(502);
      expect(((await rowFor(who)) as Row & { invitedAt: string | null }).invitedAt).toBeNull();
      const retried = await invite(row.id);
      expect(retried.status).toBe(200);
      expect(sent.filter((m) => m.to === who.email)).toHaveLength(1);
    } finally {
      await noMailer();
    }
  });

  it("🔴 a send whose answer was lost KEEPS the claim - it may have gone out - and is never sent again", async () => {
    await useMailer();
    try {
      const who = person("Liv", "Moore");
      const when = at(12, 10);
      await lapsed(who, when);
      await takenBy(when, "Max", "Nolan");
      const row = (await rowFor(who))!;
      failNext = "lost";
      const lost = await invite(row.id);
      expect(lost.status).toBe(202);
      expect(lost.body.error).toBe("unknown");
      const again = await invite(row.id);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("already_invited");
      expect(attempts.filter((m) => m.to === who.email)).toHaveLength(1);
    } finally {
      await noMailer();
    }
  });

  it("🔴 a time only HELD by someone on the card step is not 'booked by someone else': not offered, and refused", async () => {
    await useMailer();
    try {
      const who = person("Nia", "Owen");
      const when = at(9, 13);
      await lapsed(who, when);
      await tryToBook(person("Oz", "Pratt"), when); // still on the card step
      const row = (await rowFor(who))!;
      expect(row.timeTaken).toBe(true);
      expect((row as Row & { canInvite: boolean }).canInvite).toBe(false);
      const res = await invite(row.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("stale");
      expect(sent).toHaveLength(0);
    } finally {
      await noMailer();
    }
  });

  it("re-checked at send time: booked since, blocked or paid are refused", async () => {
    await useMailer();
    try {
      // Booked since (another time), after the list was read.
      const since = person("Pat", "Quill");
      const t1 = at(9, 14);
      await lapsed(since, t1);
      await takenBy(t1, "Quin", "Ross");
      const sinceRow = (await rowFor(since))!;
      expect((sinceRow as Row & { canInvite: boolean }).canInvite).toBe(true);
      await finish(await tryToBook(since, at(12, 11)));
      const r1 = await invite(sinceRow.id);
      expect(r1.status).toBe(409);
      expect(r1.body.error).toBe("stale");

      // Blocked from booking.
      const blocked = person("Rae", "Stone");
      const t2 = at(9, 15);
      await lapsed(blocked, t2);
      await takenBy(t2, "Sid", "Tate");
      const blockedRow = (await rowFor(blocked))!;
      await prisma.client.update({ where: { id: blockedRow.clientId! }, data: { bookingBlockedAt: new Date() } });
      expect(((await rowFor(blocked)) as Row & { canInvite: boolean }).canInvite).toBe(false);
      const r2 = await invite(blockedRow.id);
      expect(r2.status).toBe(422);
      expect(r2.body.error).toBe("blocked");

      // Paid (late): a refund question, not an invitation.
      const paid = person("Tia", "Upton");
      const t3 = at(9, 16);
      const paidAttempt = await lapsed(paid, t3);
      await takenBy(t3, "Uma", "Vance");
      await prisma.payment.create({
        data: {
          shopId,
          appointmentId: paidAttempt.id,
          stripePaymentIntentId: `pi_${randomToken(12)}`,
          stripeConnectAccountId: "acct_unf_paid",
          mode: "ahead",
          purpose: "booking",
          amount: 3500,
          applicationFeeAmount: 0,
          currency: "usd",
          status: "succeeded",
        },
      });
      const r3 = await invite(paidAttempt.id);
      expect(r3.status).toBe(422);
      expect(r3.body.error).toBe("paid");
      // No invitation went to anyone (the bookings that took the times get
      // their own ordinary confirmations).
      expect(sent.filter((m) => m.subject.startsWith("Pick another time"))).toHaveLength(0);
    } finally {
      await noMailer();
    }
  });

  it("refuses what it shouldn't do: unsubscribed, still on the card step, or no email able to go out", async () => {
    await useMailer();
    try {
      // Unsubscribed from this shop's emails.
      const quiet = person("Mo", "Nash");
      const tq = at(9, 9);
      await lapsed(quiet, tq);
      await takenBy(tq, "Moe", "Nye");
      const quietRow = (await rowFor(quiet))!;
      await prisma.client.update({ where: { id: quietRow.clientId! }, data: { emailOptedOut: true } });
      expect(((await rowFor(quiet)) as Row & { canInvite: boolean }).canInvite).toBe(false);
      const r1 = await invite(quietRow.id);
      expect(r1.status).toBe(422);
      expect(r1.body.error).toBe("unsubscribed");

      // Still on the card step.
      const live = person("Ned", "Oak");
      const attempt = await tryToBook(live, at(9, 10));
      const r2 = await invite(attempt.id);
      expect(r2.status).toBe(409);
      expect(r2.body.error).toBe("still_finishing");
      expect(sent.filter((m) => m.subject.startsWith("Pick another time"))).toHaveLength(0);
    } finally {
      await noMailer();
    }
    // No mailer at all: refused, and nothing stamped.
    const off = person("Oli", "Penn");
    const to = at(9, 11);
    await lapsed(off, to);
    await takenBy(to, "Ora", "Pike");
    const offRow = (await rowFor(off))!;
    const r3 = await invite(offRow.id);
    expect(r3.status).toBe(503);
    expect(((await rowFor(off)) as Row & { invitedAt: string | null }).invitedAt).toBeNull();
  });

  it("another shop can't invite this shop's clients", async () => {
    const who = person("Pia", "Quinn");
    await lapsed(who, at(9, 12));
    const row = (await rowFor(who))!;
    const other = await signup("invite-other");
    await request(app)
      .post("/api/shops")
      .set("Cookie", other.cookie)
      .send({ name: "Other Cuts", bookingUrl: "https://other.test", smsAttested: true });
    const res = await request(app)
      .post(`/api/booking/unfinished/${row.id}/invite`)
      .set("Cookie", other.cookie)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("Dismiss", () => {
  it("🔴 takes the person off - every try of theirs - and a later try lists them again", async () => {
    const who = person("Bea", "Frost");
    const one = await lapsed(who, at(6, 9));
    const two = await lapsed(who, at(6, 10));
    const res = await request(app)
      .post(`/api/booking/unfinished/${two.id}/dismiss`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(await rowFor(who)).toBeUndefined();
    const stamped = await prisma.appointment.findMany({
      where: { id: { in: [one.id, two.id] } },
      select: { unfinishedDismissedAt: true, dismissedAt: true, status: true },
    });
    // Its own column: the day view's dismiss and the row's status are untouched.
    for (const r of stamped) {
      expect(r.unfinishedDismissedAt).toBeInstanceOf(Date);
      expect(r.dismissedAt).toBeNull();
      expect(r.status).toBe("CANCELED");
    }
    const three = await lapsed(who, at(6, 11));
    expect(await rowFor(who)).toMatchObject({ id: three.id, attempts: 1 });
  });

  it("🔴 never takes off a NEWER try than the one tapped (a list read before it)", async () => {
    const who = person("Rex", "Moss");
    const older = await lapsed(who, at(11, 9));
    const newer = await lapsed(who, at(11, 10));
    // The shop's screen still shows the older try; Dismiss is tapped on it.
    const res = await request(app).post(`/api/booking/unfinished/${older.id}/dismiss`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(await rowFor(who)).toMatchObject({ id: newer.id, attempts: 1 });
  });

  it("refuses a client still on the card step - they may finish in a minute", async () => {
    const who = person("Cal", "Dunn");
    const attempt = await tryToBook(who, at(6, 12));
    const res = await request(app)
      .post(`/api/booking/unfinished/${attempt.id}/dismiss`)
      .set("Cookie", cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("still_finishing");
    expect((await rowFor(who))?.state).toBe("live");
  });

  it("refuses a real booking", async () => {
    const who = person("Dee", "Marsh");
    const attempt = await tryToBook(who, at(6, 13));
    await finish(attempt);
    const res = await request(app)
      .post(`/api/booking/unfinished/${attempt.id}/dismiss`)
      .set("Cookie", cookie);
    expect(res.status).toBe(404);
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { unfinishedDismissedAt: true },
    });
    expect(row.unfinishedDismissedAt).toBeNull();
  });
});

describe("only this shop's managers", () => {
  it("🔴 another shop can neither see the list nor dismiss from it", async () => {
    const who = person("Eli", "Shaw");
    const attempt = await lapsed(who, at(6, 14));
    const other = await signup("other");
    const otherShop = await request(app)
      .post("/api/shops")
      .set("Cookie", other.cookie)
      .send({ name: "Other Cuts", bookingUrl: "https://other.test", smsAttested: true });
    expect(otherShop.status).toBe(201);

    const theirs = await list(other.cookie);
    expect(theirs.rows.find((r) => r.id === attempt.id)).toBeUndefined();
    const res = await request(app)
      .post(`/api/booking/unfinished/${attempt.id}/dismiss`)
      .set("Cookie", other.cookie);
    expect(res.status).toBe(404);
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { unfinishedDismissedAt: true },
    });
    expect(row.unfinishedDismissedAt).toBeNull();
    expect(await rowFor(who)).toBeDefined();
  });

  it("🔴 a BARBER seat is refused (403), list and dismiss", async () => {
    const who = person("Fay", "Lowe");
    const attempt = await lapsed(who, at(7, 9));
    const seat = await signup("seat");
    await prisma.shopMember.create({ data: { shopId, userId: seat.id, role: "BARBER" } });
    const listed = await request(app).get("/api/booking/unfinished").set("Cookie", seat.cookie);
    expect(listed.status).toBe(403);
    expect(listed.body.error).toBe("forbidden_role");
    const tried = await request(app)
      .post(`/api/booking/unfinished/${attempt.id}/dismiss`)
      .set("Cookie", seat.cookie);
    expect(tried.status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    expect((await request(app).get("/api/booking/unfinished")).status).toBe(401);
  });
});
