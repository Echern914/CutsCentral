import request from "supertest";
import type { Express } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";

/**
 * A CLIENT'S SAVED CARD - end to end, against a fake Stripe.
 *
 * A barber: "save a universal card so appointments go straight through after
 * they select time". The owner: "in the client database they can also have
 * their card on file there so they don't have to keep adding it".
 *
 * What is pinned: a card is kept ONLY on the client's own tick and only once
 * its booking stands; the browser it was saved on books the next time with no
 * card step and no hold; nothing but possession (a device key, or a code texted
 * to the number on file) can use it - never a typed number, never for someone
 * else; a visit finishing never lets it go; removing it stops it being offered
 * and lets it go once nothing needs it; the shop's own bookings for the client
 * carry it; the client profile shows it.
 */

const fake = vi.hoisted(() => {
  type SI = {
    id: string;
    object: "setup_intent";
    status: string;
    client_secret: string;
    customer: string;
    payment_method: string | null;
    metadata: Record<string, string>;
  };
  const setupIntents = new Map<string, SI>();
  const calls = { detached: [] as string[], customers: 0, charged: [] as Record<string, unknown>[] };
  let n = 0;
  return {
    setupIntents,
    calls,
    client: {
      customers: {
        create: vi.fn(async () => {
          calls.customers += 1;
          return { id: `cus_sc_${++n}` };
        }),
      },
      setupIntents: {
        create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }) => {
          const id = `seti_sc_${++n}`;
          const si: SI = {
            id,
            object: "setup_intent",
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
        retrieve: vi.fn(async (id: string) => ({
          id,
          card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2030 },
        })),
        detach: vi.fn(async (id: string) => {
          calls.detached.push(id);
          return { id };
        }),
      },
      accounts: {
        retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })),
      },
      paymentIntents: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          calls.charged.push(params);
          const id = `pi_sc_${++n}`;
          return {
            id,
            object: "payment_intent",
            status: "succeeded",
            amount: params.amount,
            amount_received: params.amount,
            client_secret: `${id}_secret`,
            latest_charge: `ch_${id}`,
            metadata: params.metadata ?? {},
          };
        }),
      },
    },
    succeed(clientSecret: string) {
      const si = setupIntents.get(clientSecret.replace(/_secret$/, ""))!;
      si.status = "succeeded";
      si.payment_method = `pm_sc_${si.id}`;
      return si.payment_method;
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
const email = `sc-${randomToken(6)}@test.local`.toLowerCase();
let sent: { to: string; body: string }[] = [];
let hour = 9;

/** A fresh future time for every booking, so none collide. */
function nextSlot(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 3 + Math.floor((hour - 9) / 8));
  d.setUTCHours(9 + ((hour - 9) % 8), 0, 0, 0);
  hour += 1;
  return d.toISOString();
}

const SAM = { firstName: "Sam", lastName: "Saver", phone: "(302) 555-0142", email: "sam.saver@example.com" };

async function book(extra: Record<string, unknown> = {}, who: Record<string, unknown> = SAM) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({ staffId, serviceId, startsAt: nextSlot(), ...who, ...extra });
}

/** Book with the "save this card" tick and complete the card step. */
async function bookAndSave(): Promise<{ manageToken: string; key: string; pm: string }> {
  const res = await book({ saveCard: true });
  expect(res.status).toBe(201);
  const pm = fake.succeed(res.body.payment.clientSecret);
  const saved = await request(app).post(`/api/book/manage/${res.body.manageToken}/card-saved`);
  expect(saved.body.status).toBe("BOOKED");
  return { manageToken: res.body.manageToken, key: saved.body.savedCard?.token, pm };
}

const clientId = async () =>
  (await prisma.client.findFirstOrThrow({ where: { shopId, phone: "+13025550142" }, select: { id: true } })).id;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  process.env.DRY_RUN = "true";
  __resetEnvCacheForTests();
  // The code-text ceiling's windows persist in the shared test database; a
  // rerun inside the same hour must not find them already spent.
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "savedCardSms:" } } });
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input: { to: string; body: string }) => {
      sent.push({ to: input.to, body: input.body });
      return { sid: `TEST${sent.length}`, status: "sent" };
    },
  } as never);
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "SC", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Saved Cuts", bookingUrl: "https://book.test", smsAttested: true });
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
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 })) });
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: `acct_sc_${randomToken(6)}`, connectChargesEnabled: true },
  });
  const settings = await request(app)
    .patch("/api/payments/settings")
    .set("Cookie", cookie)
    .send({ paymentsMode: "card_on_file" });
  expect(settings.status).toBe(200);
});

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("keeping a card", () => {
  it("🔴 without the tick nothing is kept - the card belongs to that one visit, as always", async () => {
    const res = await book({}, { ...SAM, phone: "(302) 555-0101", email: "no.tick@example.com" });
    fake.succeed(res.body.payment.clientSecret);
    const saved = await request(app).post(`/api/book/manage/${res.body.manageToken}/card-saved`);
    expect(saved.body.status).toBe("BOOKED");
    expect(saved.body.savedCard).toBeUndefined();
    const client = await prisma.client.findFirstOrThrow({ where: { shopId, phone: "+13025550101" } });
    expect(await prisma.savedCard.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("ticking 'save this card' keeps it once the booking stands, and this browser gets a key", async () => {
    const { key, pm } = await bookAndSave();
    expect(key).toEqual(expect.any(String));
    const card = await prisma.savedCard.findFirstOrThrow({ where: { clientId: await clientId(), removedAt: null } });
    expect(card).toMatchObject({ stripePaymentMethodId: pm, brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 });
    expect(card.consentVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
    // The visit's own row hands the method over: releasing it can't detach it.
    const row = await prisma.cardOnFile.findFirstOrThrow({ where: { savedCardId: card.id } });
    expect(row.stripePaymentMethodId).toBeNull();
  });

  it("the key is handed out once - later phones prove themselves with a code", async () => {
    const res = await book({ saveCard: true }, { ...SAM, phone: "(302) 555-0102", email: "once@example.com" });
    fake.succeed(res.body.payment.clientSecret);
    const first = await request(app).post(`/api/book/manage/${res.body.manageToken}/card-saved`);
    const again = await request(app).post(`/api/book/manage/${res.body.manageToken}/card-saved`);
    expect(first.body.savedCard?.token).toEqual(expect.any(String));
    expect(again.body.savedCard).toBeUndefined();
  });
});

describe("booking with the saved card", () => {
  let key: string;
  let pm: string;
  beforeAll(async () => {
    ({ key, pm } = await bookAndSave());
  });

  it("🔴 the same browser books straight through - no card step, no hold, the card on the appointment", async () => {
    const res = await book({ savedCardToken: key });
    expect(res.status).toBe(201);
    expect(res.body.payment).toBeNull();
    expect(res.body.savedCard).toEqual({ brand: "visa", last4: "4242" });
    const appt = await prisma.appointment.findUniqueOrThrow({
      where: { manageToken: res.body.manageToken },
      select: { id: true, status: true, holdReason: true, cardOnFile: true },
    });
    expect(appt.status).toBe("BOOKED");
    expect(appt.holdReason).toBeNull();
    expect(appt.cardOnFile).toMatchObject({ status: "saved", stripePaymentMethodId: null });
    // And every charge path resolves the saved card's method through it.
    const { paymentMethodFor } = await import("../billing/cardOnFile.js");
    expect(await paymentMethodFor(shopId, appt.id, null)).toBe(pm);
  });

  it("🔴 a made-up key books nothing on anyone's card - the ordinary card step instead", async () => {
    const res = await book({ savedCardToken: "x".repeat(43) });
    expect(res.status).toBe(201);
    expect(res.body.savedCardRefused).toBe(true);
    expect(res.body.payment.kind).toBe("setup");
  });

  it("🔴 the key never books someone ELSE: another person's number on the form gets the card step", async () => {
    const res = await book({ savedCardToken: key }, { ...SAM, firstName: "Other", phone: "(302) 555-0199", email: "other@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.savedCardRefused).toBe(true);
    expect(res.body.payment.kind).toBe("setup");
  });

  it("🔴 a visit finishing never lets the saved card go", async () => {
    const res = await book({ savedCardToken: key });
    const cancel = await request(app).post(`/api/book/manage/${res.body.manageToken}/cancel`).send({});
    expect(cancel.status).toBe(200);
    expect(fake.calls.detached).not.toContain(pm);
    const card = await prisma.savedCard.findFirstOrThrow({ where: { stripePaymentMethodId: pm } });
    expect(card.removedAt).toBeNull();
    expect(card.detachedAt).toBeNull();
  });

  it("the shop's own booking for the client carries it too", async () => {
    const created = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, firstName: "Sam", startsAt: nextSlot(), clientId: await clientId() });
    expect(created.status).toBe(201);
    const row = await prisma.cardOnFile.findUniqueOrThrow({ where: { appointmentId: created.body.id } });
    expect(row.savedCardId).not.toBeNull();
    expect(row.serviceChargeConsentAt).toBeNull(); // only ever the client's own tick
  });

  it("the client's profile shows it - brand, last four, expiry", async () => {
    const res = await request(app).get(`/api/dashboard/clients/${await clientId()}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.client.savedCard).toMatchObject({ brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 });
  });
});

describe("a new phone: a code to the number on file", () => {
  it("🔴 the code goes to the client's number; the right code unlocks the card on this phone", async () => {
    const code = await request(app).post(`/api/book/${slug}/saved-card/code`).send({ phone: SAM.phone });
    expect(code.body).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+13025550142");
    const digits = /(\d{6}) is your code/.exec(sent[0]!.body)![1]!;

    const wrong = await request(app)
      .post(`/api/book/${slug}/saved-card/verify`)
      .send({ phone: SAM.phone, code: digits === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);

    const right = await request(app).post(`/api/book/${slug}/saved-card/verify`).send({ phone: SAM.phone, code: digits });
    expect(right.status).toBe(200);
    const newKey = right.body.savedCard.token as string;
    const booked = await book({ savedCardToken: newKey });
    expect(booked.body.payment).toBeNull();
    expect(booked.body.savedCard).toEqual({ brand: "visa", last4: "4242" });
  });

  it("🔴 a number with no saved card gets the same answer, and nothing is sent", async () => {
    const res = await request(app).post(`/api/book/${slug}/saved-card/code`).send({ phone: "(302) 555-0177" });
    expect(res.body).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it("asking again inside a minute sends nothing new", async () => {
    await request(app).post(`/api/book/${slug}/saved-card/code`).send({ phone: SAM.phone });
    expect(sent).toHaveLength(0);
  });
});

describe("a new phone while texting is off - as production has been since 2026-09-22", () => {
  // The suites run with texting ON (vitest.setup.ts), which is how a code that
  // could never have gone out in production first passed here.
  afterEach(() => {
    process.env.SMS_ENABLED = "true";
    delete process.env.SMS_SIGNIN_ENABLED;
    __resetEnvCacheForTests();
  });

  it("🔴 the code still goes - one the client asked for follows the sign-in switch, not the texting one", async () => {
    await bookAndSaveAs("(302) 555-0181", "off.one@example.com");
    sent = [];
    process.env.SMS_ENABLED = "false";
    __resetEnvCacheForTests();
    const res = await request(app).post(`/api/book/${slug}/saved-card/code`).send({ phone: "(302) 555-0181" });
    expect(res.body).toEqual({ ok: true });
    expect(sent.map((s) => s.to)).toEqual(["+13025550181"]);
    expect(sent[0]!.body).toMatch(/^\d{6} is your code/);
  });

  it("SMS_SIGNIN_ENABLED=false stops them too - the page is told, and falls back to the card", async () => {
    await bookAndSaveAs("(302) 555-0182", "off.two@example.com");
    sent = [];
    process.env.SMS_ENABLED = "false";
    process.env.SMS_SIGNIN_ENABLED = "false";
    __resetEnvCacheForTests();
    const res = await request(app).post(`/api/book/${slug}/saved-card/code`).send({ phone: "(302) 555-0182" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "codes_unavailable" });
    expect(sent).toHaveLength(0);
  });
});

describe("the platform ceiling on code texts", () => {
  afterEach(() => {
    delete process.env.SAVED_CARD_SMS_HOURLY_CAP;
  });

  it("🔴 past it nothing is sent, the answer is the same, and no code or cooldown is left behind", async () => {
    await bookAndSaveAs("(302) 555-0183", "cap.one@example.com");
    await bookAndSaveAs("(302) 555-0184", "cap.two@example.com");
    sent = [];
    await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "savedCardSms:" } } });
    process.env.SAVED_CARD_SMS_HOURLY_CAP = "1";
    const first = await request(app).post(`/api/book/${slug}/saved-card/code`).send({ phone: "(302) 555-0183" });
    const second = await request(app).post(`/api/book/${slug}/saved-card/code`).send({ phone: "(302) 555-0184" });
    expect(first.body).toEqual({ ok: true });
    expect(second.body).toEqual({ ok: true });
    expect(sent.map((s) => s.to)).toEqual(["+13025550183"]);
    const refused = await prisma.savedCard.findFirstOrThrow({
      where: { shopId, removedAt: null, client: { phone: "+13025550184" } },
      select: { id: true },
    });
    expect(await prisma.savedCardCode.count({ where: { savedCardId: refused.id } })).toBe(0);
  });
});

describe("taking it off the shop's file", () => {
  it("🔴 never offered again; a booking already made keeps it until it is done, then it is let go", async () => {
    const { key, pm, manageToken } = await bookAndSaveAs("(302) 555-0160", "remover@example.com");
    const upcoming = await book({ savedCardToken: key }, { ...SAM, phone: "(302) 555-0160", email: "remover@example.com" });
    expect(upcoming.body.payment).toBeNull();

    const removed = await request(app).post(`/api/book/manage/${manageToken}/saved-card/remove`);
    expect(removed.body).toEqual({ ok: true, removed: 1 });

    // Not offered again.
    const after = await book({ savedCardToken: key }, { ...SAM, phone: "(302) 555-0160", email: "remover@example.com" });
    expect(after.body.savedCardRefused).toBe(true);
    // The booking made with it still has it...
    const appt = await prisma.appointment.findUniqueOrThrow({
      where: { manageToken: upcoming.body.manageToken },
      select: { id: true },
    });
    const { paymentMethodFor } = await import("../billing/cardOnFile.js");
    expect(await paymentMethodFor(shopId, appt.id, null)).toBe(pm);
    expect(fake.calls.detached).not.toContain(pm);
    // ...until every appointment that needed it is done.
    for (const t of [manageToken, upcoming.body.manageToken]) {
      await request(app).post(`/api/book/manage/${t}/cancel`).send({});
    }
    expect(fake.calls.detached).toContain(pm);
  });
});

describe("🔴 the manage page: possession, never a phone number", () => {
  // Anyone who books with the client's number lands on the client's record and
  // gets a manage link of their own. That link may show and remove only a
  // card its own booking saved or was booked with - the same rule the booking
  // page lives by (billing/savedCard.ts).
  it("someone else booking on the client's number sees no card, and cannot take it off", async () => {
    const phone = "(302) 555-0162";
    const { pm } = await bookAndSaveAs(phone, "owner.card@example.com");
    const stranger = await book({}, { ...SAM, firstName: "Mallory", phone, email: "mallory@example.com" });
    expect(stranger.status).toBe(201);
    const card = await prisma.savedCard.findFirstOrThrow({ where: { stripePaymentMethodId: pm } });
    // The same record - which is exactly why the record cannot be the test.
    const strangerAppt = await prisma.appointment.findUniqueOrThrow({
      where: { manageToken: stranger.body.manageToken },
      select: { clientId: true },
    });
    expect(strangerAppt.clientId).toBe(card.clientId);

    const page = await request(app).get(`/api/book/manage/${stranger.body.manageToken}`);
    expect(page.status).toBe(200);
    expect(page.body.savedCard).toBeNull();
    expect(JSON.stringify(page.body)).not.toContain("4242");

    const removed = await request(app).post(`/api/book/manage/${stranger.body.manageToken}/saved-card/remove`);
    expect(removed.body).toEqual({ ok: true, removed: 0 });
    const after = await prisma.savedCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.removedAt).toBeNull();
    expect(await prisma.savedCardDevice.count({ where: { savedCardId: card.id, revokedAt: { not: null } } })).toBe(0);
    expect(fake.calls.detached).not.toContain(pm);
  });

  it("the booking that saved it, and one booked with it, show it - and either can take it off", async () => {
    const phone = "(302) 555-0163";
    const mail = "shows.card@example.com";
    const { key, manageToken } = await bookAndSaveAs(phone, mail);
    const saving = await request(app).get(`/api/book/manage/${manageToken}`);
    expect(saving.body.savedCard).toEqual({ brand: "visa", last4: "4242" });

    const using = await book({ savedCardToken: key }, { ...SAM, phone, email: mail });
    expect(using.body.payment).toBeNull();
    const usingPage = await request(app).get(`/api/book/manage/${using.body.manageToken}`);
    expect(usingPage.body.savedCard).toEqual({ brand: "visa", last4: "4242" });

    const removed = await request(app).post(`/api/book/manage/${using.body.manageToken}/saved-card/remove`);
    expect(removed.body).toEqual({ ok: true, removed: 1 });
    expect((await request(app).get(`/api/book/manage/${manageToken}`)).body.savedCard).toBeNull();
  });
});

describe("the card itself is the last word", () => {
  it("🔴 a card marked removed is refused even if a device key for it was somehow never revoked", async () => {
    const { key } = await bookAndSaveAs("(302) 555-0161", "second.wall@example.com");
    const client = await prisma.client.findFirstOrThrow({ where: { shopId, phone: "+13025550161" } });
    // Only the card is marked - its device keys are left as they were.
    await prisma.savedCard.updateMany({ where: { clientId: client.id }, data: { removedAt: new Date() } });
    const res = await book({ savedCardToken: key }, { ...SAM, phone: "(302) 555-0161", email: "second.wall@example.com" });
    expect(res.body.savedCardRefused).toBe(true);
    expect(res.body.payment.kind).toBe("setup");
  });
});

describe("the barber's checkout", () => {
  const CHECKOUT = { ...SAM, phone: "(302) 555-0170", email: "checkout@example.com" };
  let key: string;
  let pm: string;
  beforeAll(async () => {
    // The checkout surface ships dark; it is switched on for these tests only.
    process.env.SERVICE_CHECKOUT_ENABLED = "true";
    __resetEnvCacheForTests();
    ({ key, pm } = await bookAndSaveAs(CHECKOUT.phone, CHECKOUT.email));
  });
  afterAll(() => {
    delete process.env.SERVICE_CHECKOUT_ENABLED;
    __resetEnvCacheForTests();
  });

  /** The barber pressed Done. */
  const done = (id: string) => prisma.appointment.update({ where: { id }, data: { status: "COMPLETED" } });
  const checkout = (id: string) => request(app).get(`/api/checkout/appointments/${id}`).set("Cookie", cookie);

  it("🔴 charges the saved card for the service, on a booking where the client allowed it", async () => {
    fake.calls.charged.length = 0;
    const res = await book({ savedCardToken: key, serviceChargeConsent: true }, CHECKOUT);
    expect(res.body.payment).toBeNull();
    const { id } = await prisma.appointment.findUniqueOrThrow({
      where: { manageToken: res.body.manageToken },
      select: { id: true },
    });
    await done(id);
    const state = await checkout(id);
    expect(state.status).toBe(200);
    expect(state.body.methods.savedCard).toMatchObject({ available: true, card: { brand: "visa", last4: "4242" } });

    const charged = await request(app)
      .post(`/api/checkout/appointments/${id}/charge-card`)
      .set("Cookie", cookie)
      .send({ amountCents: 3500, requestId: `req_${randomToken(12)}` });
    expect(charged.body.result).toBe("paid");
    expect(fake.calls.charged).toHaveLength(1);
    expect(fake.calls.charged[0]!.payment_method).toBe(pm);
  });

  it("🔴 a booking the shop made carries it for fees - the service still needs the client's own tick", async () => {
    const client = await prisma.client.findFirstOrThrow({
      where: { shopId, phone: "+13025550170" },
      select: { id: true },
    });
    const created = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, firstName: "Sam", startsAt: nextSlot(), clientId: client.id });
    expect(created.status).toBe(201);
    await done(created.body.id);
    const state = await checkout(created.body.id);
    expect(state.body.methods.savedCard).toMatchObject({ available: false, blocker: "no_service_consent" });
  });
});

async function bookAndSaveAs(phone: string, mail: string) {
  const res = await book({ saveCard: true }, { ...SAM, phone, email: mail });
  const pm = fake.succeed(res.body.payment.clientSecret);
  const saved = await request(app).post(`/api/book/manage/${res.body.manageToken}/card-saved`);
  return { manageToken: res.body.manageToken as string, key: saved.body.savedCard.token as string, pm };
}
