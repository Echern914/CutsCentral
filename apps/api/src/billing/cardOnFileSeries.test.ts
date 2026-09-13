import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";

/**
 * A STANDING APPOINTMENT at a shop that keeps a card on file.
 *
 * 🔴 WHY THIS SUITE EXISTS. On 2026-09-13 a barber booked twelve fortnightly
 * cuts through the public page. His shop was set to card_on_file with Stripe
 * Connect live. No card screen ever appeared, twelve chairs were confirmed,
 * and not one of them had a card behind it. Two independent failures lined up:
 *
 *   1. recurringOfferedTo consulted collectsPaymentUpFront, which knows only
 *      `ahead` and `deposit`, so a card-on-file shop was offered recurring by
 *      a gate whose whole job was to refuse shops that collect at booking.
 *   2. The series branch of the write returned `payment: null` and exited
 *      fifteen lines ABOVE the collection decision, so even had the gate been
 *      right, nothing in that path could have asked for a card.
 *
 * What this pins is the shape of the fix: ONE card for the whole series, the
 * chairs HELD rather than confirmed until it is saved, confirmation withheld
 * until then, and every failure mode landing somewhere safe.
 *
 * The Stripe fake is the one from cardOnFile.test.ts, kept deliberately small:
 * it records what we asked Stripe for and answers the minimum the code reads.
 */

type FakeSetupIntent = {
  id: string;
  object: "setup_intent";
  status: string;
  client_secret: string;
  customer: string;
  payment_method: string | null;
  metadata: Record<string, string>;
};

const fake = vi.hoisted(() => {
  const setupIntents = new Map<string, FakeSetupIntent>();
  const calls = {
    customers: [] as unknown[],
    setupIntents: [] as { customer: string; metadata: Record<string, string> }[],
    detached: [] as string[],
  };
  let n = 0;
  // When true the next setupIntents.create throws, standing in for Stripe
  // being unreachable at exactly the wrong moment.
  const failure = { nextCreateThrows: false };
  return {
    setupIntents,
    calls,
    failure,
    client: {
      customers: {
        create: vi.fn(async (params: unknown) => {
          calls.customers.push(params);
          return { id: `cus_fake_${++n}` };
        }),
      },
      setupIntents: {
        create: vi.fn(
          async (params: { customer: string; metadata: Record<string, string> }) => {
            if (failure.nextCreateThrows) {
              failure.nextCreateThrows = false;
              throw new Error("stripe is having a moment");
            }
            calls.setupIntents.push(params);
            const id = `seti_fake_${++n}`;
            const si: FakeSetupIntent = {
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
          },
        ),
        retrieve: vi.fn(async (id: string) => {
          const si = setupIntents.get(id);
          if (!si) throw new Error(`no such setup intent ${id}`);
          return si;
        }),
      },
      paymentMethods: {
        retrieve: vi.fn(async (id: string) => ({ id, card: { brand: "visa", last4: "4242" } })),
        detach: vi.fn(async (id: string) => {
          calls.detached.push(id);
          return { id };
        }),
      },
      accounts: {
        retrieve: vi.fn(async () => ({
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        })),
      },
    },
    /** The customer typed a card and Stripe accepted it. */
    succeed(id: string) {
      const si = setupIntents.get(id)!;
      si.status = "succeeded";
      si.payment_method = `pm_fake_${id}`;
    },
  };
});

vi.mock("./stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripe.js")>()),
  stripeClient: () => fake.client,
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
const email = `cofseries-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

interface SeriesBody {
  manageToken: string;
  payment: { kind: string; clientSecret: string; amountCents: number } | null;
  series: { id: string; booked: number; held: boolean; total: number } | null;
}

/**
 * Book a weekly series. Each test uses its OWN HOUR rather than its own start
 * day: a weekly series from day 3 occupies days 3, 10 and 17, so two tests
 * starting a week apart collide on two of their three occurrences and the
 * second one silently books fewer. Distinct hours keep them independent.
 */
async function bookSeries(daysAhead: number, hourUtc: number, count = 3) {
  const res = await request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: futureAtHour(daysAhead, hourUtc).toISOString(),
      firstName: "Standing",
      lastName: "Regular",
      phone: "(302) 555-0177",
      email: `cust-${randomToken(4)}@example.com`,
      recurrence: { interval: 1, count },
    });
  expect(res.status).toBe(201);
  return res.body as SeriesBody;
}

/** Every appointment row of a series, in date order. */
const occurrencesOf = (seriesId: string) =>
  prisma.appointment.findMany({
    where: { seriesId },
    select: { id: true, status: true, holdReason: true, holdExpiresAt: true, startsAt: true },
    orderBy: { startsAt: "asc" },
  });

const cardFor = (seriesId: string) =>
  prisma.cardOnFile.findUnique({
    where: { seriesId },
    select: { id: true, status: true, seriesId: true, appointmentId: true, stripeSetupIntentId: true },
  });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "COFSeries", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Standing Card Cuts", bookingUrl: "https://standing.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 365 });
  expect(patch.status).toBe(200);
  slug = patch.body.slug;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Kids Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;
  const avail = await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });
  expect(avail.status).toBe(200);

  // Connect live, and the shop keeps a card: Drick's exact configuration.
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      stripeConnectAccountId: ACCT,
      connectChargesEnabled: true,
      paymentsMode: "card_on_file",
      requireBookingApproval: false,
    },
  });
});

afterAll(async () => {
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

describe("a standing appointment at a card-on-file shop", () => {
  it("🔴 asks for ONE card and confirms NOTHING until it is saved", async () => {
    const before = fake.calls.setupIntents.length;
    const body = await bookSeries(3, 10, 3);

    // The card screen is demanded. This is the assertion that would have
    // failed on 2026-09-13: `payment` was null and the customer sailed through.
    expect(body.payment).not.toBeNull();
    expect(body.payment!.kind).toBe("setup");
    expect(body.payment!.amountCents).toBe(0);
    expect(body.payment!.clientSecret).toMatch(/^seti_fake_/);

    // ONE intent for three occurrences, not three.
    expect(fake.calls.setupIntents.length - before).toBe(1);

    // Nothing is a booking yet. Every chair is held.
    const occ = await occurrencesOf(body.series!.id);
    expect(occ).toHaveLength(3);
    for (const a of occ) {
      expect(a.status).toBe("PENDING");
      expect(a.holdReason).toBe("payment");
      expect(a.holdExpiresAt).not.toBeNull();
    }

    // And the response says so, rather than claiming three bookings.
    expect(body.series!.held).toBe(true);
    expect(body.series!.booked).toBe(3);
  });

  it("🔴 files the one card against the series, not against one occurrence", async () => {
    const body = await bookSeries(3, 11, 3);
    const card = await cardFor(body.series!.id);
    expect(card).not.toBeNull();
    expect(card!.seriesId).toBe(body.series!.id);
    expect(card!.status).toBe("pending");

    // The anchor is where it is filed, so every lookup-by-appointment that
    // already existed keeps working.
    const occ = await occurrencesOf(body.series!.id);
    expect(card!.appointmentId).toBe(occ[0]!.id);
  });

  it("🔴 saving the card confirms EVERY occurrence, on one confirmation", async () => {
    const body = await bookSeries(3, 12, 3);
    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);

    // The browser tells us the card cleared; the server verifies it itself
    // rather than believing the browser.
    const saved = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`).send({});
    expect(saved.status).toBe(200);
    expect(saved.body.status).toBe("BOOKED");

    const occ = await occurrencesOf(body.series!.id);
    expect(occ).toHaveLength(3);
    for (const a of occ) {
      expect(a.status).toBe("BOOKED");
      expect(a.holdReason).toBeNull();
      expect(a.holdExpiresAt).toBeNull();
    }
    const after = await cardFor(body.series!.id);
    expect(after!.status).toBe("saved");
  });

  it("🔴 a second card-saved call changes nothing (retry is safe)", async () => {
    const body = await bookSeries(3, 13, 2);
    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);

    const first = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`).send({});
    expect(first.status).toBe(200);
    const detachedBefore = fake.calls.detached.length;

    const second = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`).send({});
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("BOOKED");

    const occ = await occurrencesOf(body.series!.id);
    expect(occ.every((a) => a.status === "BOOKED")).toBe(true);
    // Nothing was released on the replay - the card is still the shop's.
    expect(fake.calls.detached.length).toBe(detachedBefore);
    const after = await cardFor(body.series!.id);
    expect(after!.status).toBe("saved");
  });

  it("🔴 a card saved AFTER the hold lapsed confirms nothing and is released", async () => {
    const body = await bookSeries(3, 14, 3);
    const seriesId = body.series!.id;

    // The customer wandered off and came back too late. Expire every hold the
    // way the clock would have.
    await prisma.appointment.updateMany({
      where: { seriesId },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });

    const card = await cardFor(seriesId);
    fake.succeed(card!.stripeSetupIntentId);
    const saved = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`).send({});
    expect(saved.status).toBe(200);

    // No chair was taken from whoever might have booked it since.
    const occ = await occurrencesOf(seriesId);
    expect(occ.every((a) => a.status !== "BOOKED")).toBe(true);

    // And the card is not kept for appointments that will never happen.
    const after = await cardFor(seriesId);
    expect(after!.status).toBe("released");
  });

  it("🔴 Stripe being unreachable costs nobody their standing appointment", async () => {
    fake.failure.nextCreateThrows = true;
    const body = await bookSeries(3, 15, 3);

    // No card screen, because there is no intent to confirm.
    expect(body.payment).toBeNull();
    expect(body.series!.held).toBe(false);

    // But the series is real and confirmed - they pay at the chair, which is
    // the same fallback a single booking already had.
    const occ = await occurrencesOf(body.series!.id);
    expect(occ).toHaveLength(3);
    for (const a of occ) expect(a.status).toBe("BOOKED");
  });
});
