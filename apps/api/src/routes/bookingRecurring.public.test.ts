import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * A customer books a standing appointment from the public page.
 *
 * The engine (materializeSeries) is already proven by the barber's own form;
 * what THIS suite pins is the public contract around it:
 *
 *  - the page offers recurring exactly when the write would accept it (the
 *    read/write split is what produced the Aug-29 outage - never again);
 *  - a customer's cap is twelve, not the barber's fifty-two;
 *  - money and approval switch it off, because twelve deposits is a decision
 *    for a person, not a default;
 *  - a taken date is skipped and NAMED, never forced and never silent.
 */

// Stripe Connect is "live" only when the test says so. Real hasActiveAccess
// and everything else stay real - only the one predicate is scripted.
const stripeState = vi.hoisted(() => ({ connect: false }));
vi.mock("../billing/stripe.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../billing/stripe.js")>();
  return { ...real, connectEnabled: () => stripeState.connect };
});

import { createApp } from "../app.js";

const app = createApp();
const password = "supersecret123";
let cookie = "";
let shopId = "";
let slug = "";
let staffId = "";
let serviceId = "";

/** A future instant at the given hour UTC, `daysAhead` days out. */
function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

function customer() {
  return {
    firstName: "Ricky",
    lastName: "Tan",
    email: `ricky-${randomToken(5).toLowerCase()}@test.local`,
    phone: "(302) 555-0400",
    smsConsent: true,
  };
}

beforeAll(async () => {
  const email = `recur-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Recur", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Standing Cuts", bookingUrl: "https://recur.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;

  // Native, UTC (wall clock == UTC in the test math), short lead time.
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 365 });
  expect(patch.status).toBe(200);
  slug = patch.body.slug as string;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id as string;

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id as string;

  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startMin: 9 * 60,
    endMin: 17 * 60,
  }));
  const avail = await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules });
  expect(avail.status).toBe(200);
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
});

const page = () => request(app).get(`/api/book/${slug}`);
const book = (body: Record<string, unknown>) => request(app).post(`/api/book/${slug}`).send(body);

async function setShop(data: Record<string, unknown>) {
  await prisma.shop.update({ where: { id: shopId }, data });
}

/** Pay at the chair, no approval: the case recurring is FOR. */
async function payInPerson() {
  stripeState.connect = false;
  await setShop({
    paymentsMode: "off",
    requireBookingApproval: false,
    connectChargesEnabled: false,
    stripeConnectAccountId: null,
  });
}

describe("a standing appointment, booked by the customer", () => {
  it("🔴 lands every occurrence, each with its own manage token", async () => {
    await payInPerson();
    const anchor = futureAtHour(3, 10);
    const res = await book({
      ...customer(),
      staffId,
      serviceId,
      startsAt: anchor.toISOString(),
      recurrence: { interval: 2, count: 4 },
    });
    expect(res.status).toBe(201);
    expect(res.body.series.booked).toBe(4);
    expect(res.body.series.total).toBe(4);
    expect(res.body.series.skipped).toEqual([]);
    expect(res.body.payment).toBeNull();
    expect(res.body.pending).toBe(false);

    const rows = await prisma.appointment.findMany({
      where: { shopId, seriesId: res.body.series.id },
      orderBy: { startsAt: "asc" },
      select: { startsAt: true, status: true, manageToken: true, seriesOccurrenceIndex: true },
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === "BOOKED")).toBe(true);
    // Fortnightly, from the anchor.
    for (let i = 0; i < 4; i++) {
      expect(rows[i]!.startsAt.getTime()).toBe(anchor.getTime() + i * 14 * 86_400_000);
      expect(rows[i]!.seriesOccurrenceIndex).toBe(i);
    }
    // Every visit can be moved or cancelled on its own.
    expect(new Set(rows.map((r) => r.manageToken)).size).toBe(4);
    // The response's token is the FIRST visit's - the one the confirmation
    // email and "manage my appointment" link are about.
    expect(res.body.manageToken).toBe(rows[0]!.manageToken);
    // One client row for the whole series.
    const clients = await prisma.client.count({ where: { shopId, phone: "+13025550400" } });
    expect(clients).toBe(1);
  });

  it("🔴 a taken date is skipped and NAMED, never forced and never silent", async () => {
    await payInPerson();
    const anchor = futureAtHour(5, 11);
    // Somebody else already has occurrence #2's slot.
    const clash = new Date(anchor.getTime() + 2 * 7 * 86_400_000);
    const single = await book({
      ...customer(),
      firstName: "Someone",
      lastName: "Else",
      staffId,
      serviceId,
      startsAt: clash.toISOString(),
    });
    expect(single.status).toBe(201);

    const res = await book({
      ...customer(),
      staffId,
      serviceId,
      startsAt: anchor.toISOString(),
      recurrence: { interval: 1, count: 4 },
    });
    expect(res.status).toBe(201);
    expect(res.body.series.booked).toBe(3);
    expect(res.body.series.total).toBe(4);
    expect(res.body.series.skipped).toHaveLength(1);
    expect(res.body.series.skipped[0].startsAt).toBe(clash.toISOString());
    expect(res.body.series.skipped[0].reason).toBe("slot_taken");
  });

  it("caps a customer at twelve, and refuses a series of one", async () => {
    await payInPerson();
    const anchor = futureAtHour(7, 12);
    for (const recurrence of [
      { interval: 2, count: 13 },
      { interval: 2, count: 1 },
      { interval: 9, count: 4 },
      { interval: 0, count: 4 },
    ]) {
      const res = await book({
        ...customer(),
        staffId,
        serviceId,
        startsAt: anchor.toISOString(),
        recurrence,
      });
      expect(res.status, JSON.stringify(recurrence)).toBe(400);
    }
    // ...and the page advertises the same ceiling the write enforces.
    const p = await page();
    expect(p.body.shop.recurringMaxCount).toBe(12);
  });

  it("refuses to repeat a special or an add-on, rather than silently dropping it", async () => {
    await payInPerson();
    const anchor = futureAtHour(9, 13);
    const withAddOn = await book({
      ...customer(),
      staffId,
      serviceId,
      startsAt: anchor.toISOString(),
      addOnIds: ["anything"],
      recurrence: { interval: 2, count: 3 },
    });
    expect(withAddOn.status).toBe(400);
    const withSpecial = await book({
      ...customer(),
      staffId,
      serviceId,
      startsAt: anchor.toISOString(),
      targetedSlotId: "anything",
      recurrence: { interval: 2, count: 3 },
    });
    expect(withSpecial.status).toBe(400);
  });
});

describe("🔴 the page offers recurring exactly when the write accepts it", () => {
  /**
   * The read/write parity rule. Three shop configurations; for each, the GET
   * flag must equal whether the POST lands. A page that offers what the
   * write refuses is the Aug-29 outage with a different noun.
   */
  const configs: Array<[string, () => Promise<void>, boolean]> = [
    ["pays at the chair", payInPerson, true],
    [
      "takes a deposit with Stripe Connect live",
      async () => {
        stripeState.connect = true;
        await setShop({
          paymentsMode: "deposit",
          depositAmountCents: 2000,
          requireBookingApproval: false,
          connectChargesEnabled: true,
          stripeConnectAccountId: `acct_${randomToken(8)}`,
        });
      },
      false,
    ],
    [
      "wants to approve each booking",
      async () => {
        stripeState.connect = false;
        await setShop({
          paymentsMode: "off",
          requireBookingApproval: true,
          connectChargesEnabled: false,
          stripeConnectAccountId: null,
        });
      },
      false,
    ],
    [
      "is in deposit mode but Connect is NOT live (intent, not capability)",
      async () => {
        stripeState.connect = false;
        await setShop({
          paymentsMode: "deposit",
          depositAmountCents: 2000,
          requireBookingApproval: false,
          connectChargesEnabled: false,
          stripeConnectAccountId: null,
        });
      },
      // No card can be taken, so nothing is charged, so recurring is safe.
      true,
    ],
  ];

  let day = 12;
  for (const [label, configure, expected] of configs) {
    it(`a shop that ${label}: offered=${expected}, and the write agrees`, async () => {
      await configure();
      try {
        const p = await page();
        expect(p.status).toBe(200);
        expect(p.body.shop.recurringAvailable).toBe(expected);

        const res = await book({
          ...customer(),
          staffId,
          serviceId,
          startsAt: futureAtHour(day++, 14).toISOString(),
          recurrence: { interval: 2, count: 2 },
        });
        if (expected) {
          expect(res.status).toBe(201);
        } else {
          expect(res.status).toBe(409);
          expect(res.body.error).toBe("recurrence_unavailable");
        }
      } finally {
        await payInPerson();
      }
    });
  }

  it("a single booking is untouched by any of this", async () => {
    await payInPerson();
    const res = await book({
      ...customer(),
      staffId,
      serviceId,
      startsAt: futureAtHour(30, 15).toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.series).toBeUndefined();
  });
});
