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
    charges: [] as {
      amount: number;
      payment_method: string;
      on_behalf_of?: string;
      transfer_data?: { destination: string };
    }[],
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
      paymentIntents: {
        create: vi.fn(async (params: {
          amount: number;
          payment_method: string;
          on_behalf_of?: string;
          transfer_data?: { destination: string };
        }) => {
          // Stripe refuses a detached method. Modelling that is the whole point
          // of the rollback test below: without it, "detached" would be a
          // bookkeeping detail rather than a loss of coverage.
          if (calls.detached.includes(params.payment_method)) {
            throw Object.assign(new Error("payment method has been detached"), {
              type: "StripeInvalidRequestError",
              code: "payment_method_unattached",
            });
          }
          calls.charges.push(params);
          return {
            id: `pi_fake_${++n}`,
            status: "succeeded",
            amount_received: params.amount,
            latest_charge: `ch_fake_${n}`,
          };
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
 * Book a weekly series. Each test gets its own (day, hour) cell rather than its
 * own start WEEK: a weekly series from day 3 occupies days 3, 10 and 17, so two
 * tests starting a week apart collide on two of their three occurrences and the
 * second silently books fewer. Availability is 09:00-17:00, so hours run 9..16
 * on day 3 and then continue on day 4, which cannot overlap day 3's grid.
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
  // This suite exercises the ACTIVATED feature. The gate's own behaviour - that
  // a shared-card series cannot be created while it is off - is pinned in
  // routes/bookingRecurring.public.test.ts.
  process.env.SERIES_CARD_ON_FILE_ENABLED = "true";
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
  delete process.env.SERIES_CARD_ON_FILE_ENABLED;
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

  it("🔴 EVERY occurrence can resolve the card through the real charging path", async () => {
    // The point of the whole feature. Filing the card against the anchor alone
    // would leave occurrences two and three with nothing to charge, and a
    // no-show on either would find no card at all.
    const body = await bookSeries(3, 16, 3);
    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);
    await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`).send({});

    const occ = await occurrencesOf(body.series!.id);
    expect(occ).toHaveLength(3);
    const rows = await prisma.cardOnFile.findMany({
      where: { appointmentId: { in: occ.map((a) => a.id) } },
      select: { appointmentId: true, status: true, stripePaymentMethodId: true, last4: true },
    });
    // One chargeable row per occurrence, every one showing the saved card.
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe("saved");
      expect(r.last4).toBe("4242");
    }
    // 🔴 ONLY THE ANCHOR HOLDS THE METHOD, and that is the rollback property:
    // the PREVIOUS release path detaches any method it finds with no notion of
    // siblings, so a copy carrying one would let an old instance strip the card
    // from the whole series. With none, the copies are inert to that code.
    const withMethod = rows.filter((r) => r.stripePaymentMethodId);
    expect(withMethod).toHaveLength(1);

    // And a NON-anchor occurrence really can be charged through the live path.
    const { chargeCardOnFile } = await import("./cardOnFile.js");
    const nonAnchor = occ[2]!;
    const before = fake.calls.charges.length;
    const outcome = await chargeCardOnFile({
      shopId,
      appointmentId: nonAnchor.id,
      cents: 1500,
      reason: "no_show",
      description: "No-show fee",
    });
    expect(outcome.outcome).toBe("charged");
    expect(fake.calls.charges.length - before).toBe(1);
    expect(fake.calls.charges.at(-1)!.amount).toBe(1500);
  });

  it("🔴 finishing ONE visit does not detach the card the later visits need", async () => {
    const body = await bookSeries(3, 9, 3);
    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);
    await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`).send({});

    const occ = await occurrencesOf(body.series!.id);
    const { releaseCardOnFile } = await import("./cardOnFile.js");
    const detachedBefore = fake.calls.detached.length;

    // The first visit happened and is done with the card.
    await releaseCardOnFile({ shopId, appointmentId: occ[0]!.id, reason: "completed" });
    // Its own row is released...
    const first = await prisma.cardOnFile.findUnique({
      where: { appointmentId: occ[0]!.id },
      select: { status: true },
    });
    expect(first!.status).toBe("released");
    // ...but the card itself is still attached, because two visits remain.
    expect(fake.calls.detached.length).toBe(detachedBefore);
    const rest = await prisma.cardOnFile.findMany({
      where: { appointmentId: { in: [occ[1]!.id, occ[2]!.id] } },
      select: { status: true },
    });
    expect(rest.every((r) => r.status === "saved")).toBe(true);

    // Only the LAST one to let go actually detaches it.
    await releaseCardOnFile({ shopId, appointmentId: occ[1]!.id, reason: "completed" });
    expect(fake.calls.detached.length).toBe(detachedBefore);
    await releaseCardOnFile({ shopId, appointmentId: occ[2]!.id, reason: "completed" });
    expect(fake.calls.detached.length).toBe(detachedBefore + 1);
  });

  it("🔴 the webhook and the browser racing produce ONE confirmation, not two", async () => {
    const body = await bookSeries(4, 10, 2);
    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);

    // The webhook path and the browser's verify path, both for the same card.
    const { markCardSaved } = await import("./cardOnFile.js");
    const si = fake.setupIntents.get(card!.stripeSetupIntentId)!;
    const viaWebhook = await markCardSaved(si as never, { eventId: "evt_race_1" });
    const viaBrowser = await request(app)
      .post(`/api/book/manage/${body.manageToken}/card-saved`)
      .send({});

    expect(viaWebhook).toBe("saved");
    expect(viaBrowser.status).toBe(200);

    // Exactly one of them did the work; the other found nothing to do.
    const occ = await occurrencesOf(body.series!.id);
    expect(occ.every((a) => a.status === "BOOKED")).toBe(true);

    // The confirmation stamp is the at-most-once record, and there is one
    // series confirmation - on the anchor - however many callers raced.
    const stamped = await prisma.appointment.findMany({
      where: { seriesId: body.series!.id, confirmationEmailSentAt: { not: null } },
      select: { id: true },
    });
    expect(stamped.length).toBeLessThanOrEqual(1);
  });

  it("🔴 an intent carrying another shop's id cannot confirm this shop's series", async () => {
    const body = await bookSeries(4, 11, 2);
    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);

    // Same real card row, but the intent claims to belong to a different shop.
    // Tenant isolation must refuse it rather than promote someone else's chairs.
    const si = fake.setupIntents.get(card!.stripeSetupIntentId)!;
    const foreign = { ...si, metadata: { ...si.metadata, shopId: `shop_${randomToken(8)}` } };
    const { markCardSaved } = await import("./cardOnFile.js");
    const outcome = await markCardSaved(foreign as never, { eventId: "evt_foreign" });

    // Nothing was confirmed and nothing was saved under the wrong tenant.
    expect(outcome).not.toBe("saved");
    const occ = await occurrencesOf(body.series!.id);
    expect(occ.every((a) => a.status === "PENDING")).toBe(true);
    const after = await cardFor(body.series!.id);
    expect(after!.status).toBe("pending");
  });

  it("🔴 a date lost while the card was typed is NOT counted as booked", async () => {
    const body = await bookSeries(5, 10, 3);
    const occ = await occurrencesOf(body.series!.id);
    expect(occ).toHaveLength(3);

    // Somebody else takes the middle chair while the customer is on the card
    // screen. A real competing booking, not a doctored row.
    //
    // Offset by ten minutes on purpose: it OVERLAPS the held slot, which is
    // what the promotion guard checks, while avoiding the partial unique on
    // (staffId, startsAt) that the held row already occupies. Booking exactly
    // on top of a live hold is refused by the database, so a competitor in
    // real life arrives beside it, not on it.
    const stolen = occ[1]!;
    const rivalStart = new Date(stolen.startsAt.getTime() + 10 * 60_000);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Walk",
        lastName: "In",
        status: "BOOKED",
        startsAt: rivalStart,
        endsAt: new Date(rivalStart.getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
    });

    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);
    const saved = await request(app)
      .post(`/api/book/manage/${body.manageToken}/card-saved`)
      .send({});
    expect(saved.status).toBe(200);

    // Two landed, one did not - and the count the screen reads says exactly
    // that rather than rounding the series up to three.
    expect(saved.body.series.booked).toBe(2);
    const after = await occurrencesOf(body.series!.id);
    expect(after.filter((a) => a.status === "BOOKED")).toHaveLength(2);
    const lost = after.find((a) => a.id === stolen.id);
    expect(lost!.status).not.toBe("BOOKED");
  });

  it("🔴 when NOTHING survives, the screen is told zero and the card is let go", async () => {
    const body = await bookSeries(5, 11, 3);
    const seriesId = body.series!.id;
    await prisma.appointment.updateMany({
      where: { seriesId },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });
    const card = await cardFor(seriesId);
    fake.succeed(card!.stripeSetupIntentId);

    const saved = await request(app)
      .post(`/api/book/manage/${body.manageToken}/card-saved`)
      .send({});
    expect(saved.status).toBe(200);
    // Zero, stated plainly - never "you're booked" over an empty series.
    expect(saved.body.series.booked).toBe(0);
    expect(saved.body.status).not.toBe("BOOKED");
    const after = await cardFor(seriesId);
    expect(after!.status).toBe("released");
  });

  it("🔴 another customer's intent cannot confirm this customer's series", async () => {
    // Two real standing appointments at the same shop, two different people.
    const mine = await bookSeries(5, 12, 2);
    const theirs = await bookSeries(5, 13, 2);
    const theirCard = await cardFor(theirs.series!.id);
    fake.succeed(theirCard!.stripeSetupIntentId);

    // THEIR card clears. Mine must be untouched by it.
    const { markCardSaved } = await import("./cardOnFile.js");
    const si = fake.setupIntents.get(theirCard!.stripeSetupIntentId)!;
    expect(await markCardSaved(si as never, { eventId: "evt_theirs" })).toBe("saved");

    const mineOcc = await occurrencesOf(mine.series!.id);
    expect(mineOcc.every((a) => a.status === "PENDING")).toBe(true);
    const mineCard = await cardFor(mine.series!.id);
    expect(mineCard!.status).toBe("pending");
    // And theirs really did land, so the test is not passing vacuously.
    const theirOcc = await occurrencesOf(theirs.series!.id);
    expect(theirOcc.every((a) => a.status === "BOOKED")).toBe(true);
  });

  it("🔴 an intent naming a card row we do not have confirms nothing", async () => {
    const body = await bookSeries(5, 14, 2);
    const card = await cardFor(body.series!.id);

    // An intent that succeeded somewhere we have no record of: the card id it
    // names belongs to no row of ours. Nothing may be promoted on its word.
    //
    // 🔴 THIS IS NOT THE ACCOUNT-CONTEXT TEST, and naming it as though it were
    // would overstate it. Rejecting an event from the wrong Stripe account
    // happens at the SIGNATURE boundary in billing/connect.ts, before this
    // function is reached at all - pinned by webhooks.integrity.test.ts ("an
    // invalid signature causes no database mutation" and the live-mode
    // refusal). This covers a different hole: an accepted event naming a card
    // we do not own. The routing half is the test above.
    const foreign = {
      id: `seti_other_${randomToken(6)}`,
      object: "setup_intent",
      status: "succeeded",
      client_secret: "cs_other",
      customer: `cus_other_${randomToken(6)}`,
      payment_method: `pm_other_${randomToken(6)}`,
      metadata: {
        shopId,
        appointmentId: (await occurrencesOf(body.series!.id))[0]!.id,
        cardOnFileId: `cof_${randomToken(10)}`,
      },
    };
    const { markCardSaved } = await import("./cardOnFile.js");
    const outcome = await markCardSaved(foreign as never, { eventId: "evt_outside" });
    // It names a card we do not have, so it cannot mark one saved.
    expect(outcome).not.toBe("saved");

    const occ = await occurrencesOf(body.series!.id);
    expect(occ.every((a) => a.status === "PENDING")).toBe(true);
    const after = await cardFor(body.series!.id);
    expect(after!.status).toBe("pending");
  });

  it("🔴 THE ROLLBACK HAZARD: old-code release strips a live sibling's card", async () => {
    /**
     * 🔴 THIS IS THE EXECUTION THE ACTIVATION GATE EXISTS TO PREVENT.
     *
     * The API that shipped before this work detaches whatever payment method
     * it finds on a card row, with no notion of siblings:
     *
     *     if (row.stripePaymentMethodId) {
     *       await stripeClient().paymentMethods.detach(row.stripePaymentMethodId);
     *     }
     *
     * Run that against a series ANCHOR whose later visits are still live and
     * the whole series loses its card, while the customer still sees one on
     * file. Deployment order cannot prevent it: during a rolling deploy one old
     * instance serving one completion is enough.
     *
     * The test below performs exactly that detach, then proves a sibling can no
     * longer be charged - and that the CURRENT release path, on the same
     * anchor, leaves the sibling chargeable.
     */
    const body = await bookSeries(6, 10, 3);
    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);
    await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`).send({});

    const occ = await occurrencesOf(body.series!.id);
    const anchor = await prisma.cardOnFile.findUnique({
      where: { seriesId: body.series!.id },
      select: { stripePaymentMethodId: true },
    });
    const method = anchor!.stripePaymentMethodId!;
    const { chargeCardOnFile, releaseCardOnFile } = await import("./cardOnFile.js");

    // FIRST, the code as it stands: releasing the anchor while siblings are
    // live must NOT let the method go.
    await releaseCardOnFile({ shopId, appointmentId: occ[0]!.id, reason: "completed" });
    expect(fake.calls.detached).not.toContain(method);
    const stillWorks = await chargeCardOnFile({
      shopId,
      appointmentId: occ[2]!.id,
      cents: 1000,
      reason: "no_show",
      description: "No-show fee",
    });
    expect(stillWorks.outcome).toBe("charged");

    // NOW the old behaviour, performed verbatim against the same method while
    // occurrence 2 is still live and unbilled.
    await fake.client.paymentMethods.detach(method);

    const afterOldCode = await chargeCardOnFile({
      shopId,
      appointmentId: occ[1]!.id,
      cents: 1000,
      reason: "no_show",
      description: "No-show fee",
    });
    // The sibling is uncovered. Not charged in error - simply unprotected,
    // which is the loss the gate and the rollback floor exist to avoid.
    expect(afterOldCode.outcome).not.toBe("charged");
  });

  it("🔴 the charge is aimed by OUR shop row, not by anything Stripe sent us", async () => {
    /**
     * WHERE ACCOUNT CONTEXT IS ENFORCED, and it is not here.
     *
     * A forged or foreign event never reaches this code: billing/connect.ts
     * verifyConnectWebhook accepts only payloads signed with OUR endpoint
     * secrets, and routes/webhooks.integrity.test.ts already pins that an
     * invalid signature causes no database mutation at all, and that a
     * live-mode event is refused by a test-mode process.
     *
     * What is left to show is the second layer: even for an event we DO accept,
     * the connected account that money is aimed at is read from our own shop
     * row and never from the payload. The SetupIntent metadata carries no
     * account field, so there is nothing there to trust in the first place -
     * this asserts the destination is the shop's stored account.
     */
    const body = await bookSeries(6, 11, 2);
    const card = await cardFor(body.series!.id);
    fake.succeed(card!.stripeSetupIntentId);
    await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`).send({});

    const occ = await occurrencesOf(body.series!.id);
    const { chargeCardOnFile } = await import("./cardOnFile.js");
    const before = fake.calls.charges.length;
    const out = await chargeCardOnFile({
      shopId,
      appointmentId: occ[1]!.id,
      cents: 2000,
      reason: "no_show",
      description: "No-show fee",
    });
    expect(out.outcome).toBe("charged");
    expect(fake.calls.charges.length - before).toBe(1);

    const charge = fake.calls.charges.at(-1)!;
    expect(charge.on_behalf_of).toBe(ACCT);
    expect(charge.transfer_data?.destination).toBe(ACCT);

    // And the intent we were handed never named an account, so the routing
    // could not have come from it even had the code wanted to use it.
    const si = fake.setupIntents.get(card!.stripeSetupIntentId)!;
    expect(si.metadata).not.toHaveProperty("on_behalf_of");
    expect(si.metadata).not.toHaveProperty("account");
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
