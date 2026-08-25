import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The read behind the appointment sheet. These tests are about what the
 * endpoint is willing to SAY:
 *
 *  - contact it actually has, resolved from the record that reaches the person
 *  - payment ONLY where ChairBack took the money; "external" everywhere else
 *  - never card data, never another shop's booking
 */

const app = createApp();
let agent: ReturnType<typeof request.agent>;
let shopId: string;
let otherShopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;

function slotAt(hourUtc: number, dayOffset = 7): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  const email = `detail-${randomToken(6).toLowerCase()}@test.local`;
  agent = request.agent(app);
  const signup = await agent
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2", name: "D", smsAttested: true });
  expect(signup.status).toBeLessThan(400);

  const created = await agent
    .post("/api/shops")
    .send({ name: "Detail Shop", bookingUrl: "https://detail.test", smsAttested: true });
  expect(created.status).toBe(201);
  await agent
    .patch("/api/shops/me")
    .send({ bookingMode: "native", timezone: "America/New_York" });
  shopId = (await agent.get("/api/shops/me")).body.id;

  const user = await prisma.user.findUnique({ where: { email } });
  const other = await prisma.shop.create({
    data: {
      ownerId: user!.id,
      name: "Other Detail Shop",
      bookingUrl: "https://other-detail.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
  });
  otherShopId = other.id;

  staffId = (await prisma.staff.create({ data: { shopId, name: "Dev" } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Skin fade", durationMin: 45, price: 40 },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `tel:+12015550134`,
        magicToken: randomToken(),
        firstName: "Marcus",
        lastName: "Dean",
        phone: "+12015550134",
        email: "marcus@example.test",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
});

beforeEach(async () => {
  await prisma.payment.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
});

async function makeAppt(
  over: Partial<{
    status: "BOOKED" | "PENDING" | "COMPLETED" | "CANCELED";
    clientId: string | null;
    phone: string | null;
    email: string | null;
    visitId: string | null;
    paidAmount: number | null;
    paidMethod: string | null;
    paidAt: Date | null;
    notes: string | null;
  }> = {},
) {
  const startsAt = slotAt(15);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: over.clientId === undefined ? clientId : over.clientId,
      firstName: "Marcus",
      lastName: "Dean",
      phone: over.phone === undefined ? null : over.phone,
      email: over.email === undefined ? null : over.email,
      status: over.status ?? "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 45 * 60_000),
      priceAtBooking: 40,
      notes: over.notes ?? null,
      visitId: over.visitId ?? null,
      paidAmount: over.paidAmount ?? null,
      paidMethod: over.paidMethod ?? null,
      paidAt: over.paidAt ?? null,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

const getAppt = (id: string) =>
  agent.get(`/api/booking/appointments/${encodeURIComponent(id)}/detail`);
const getVisit = (id: string) =>
  agent.get(`/api/booking/visits/${encodeURIComponent(id)}/detail`);

describe("a native ChairBack booking", () => {
  it("carries the full booking, its contact and a real payment state", async () => {
    const a = await makeAppt({ notes: "comping the beard" });
    const res = await getAppt(a.id);
    expect(res.status).toBe(200);

    expect(res.body.source).toBe("appointment");
    expect(res.body.origin).toBe("chairback");
    expect(res.body.originLabel).toBe("ChairBack");
    expect(res.body.status).toBe("upcoming");
    // The full name, never a truncation - the card's whole job.
    expect(res.body.clientName).toBe("Marcus Dean");
    expect(res.body.serviceName).toBe("Skin fade");
    expect(res.body.staffName).toBe("Dev");
    expect(res.body.durationMin).toBe(45);
    expect(res.body.timezone).toBe("America/New_York");
    expect(res.body.price).toBe(40);
    expect(res.body.notes).toBe("comping the beard");

    expect(res.body.contact.phone).toBe("+12015550134");
    expect(res.body.contact.phoneDisplay).toBe("(201) 555-0134");
    expect(res.body.contact.email).toBe("marcus@example.test");

    expect(res.body.payment.state).toBe("unpaid");
    expect(res.body.payment.totalCents).toBe(4000);
    expect(res.body.payment.remainingCents).toBe(4000);
    expect(res.body.editable).toBe(true);
    expect(res.body.readOnlyReason).toBeNull();
  });

  it("reports money collected at the chair", async () => {
    const a = await makeAppt({ paidAmount: 40, paidMethod: "cash", paidAt: new Date() });
    const res = await getAppt(a.id);
    expect(res.body.checkedOutAt).not.toBeNull();
    expect(res.body.payment.state).toBe("paid");
    expect(res.body.payment.remainingCents).toBe(0);
    expect(res.body.payment.inPersonCents).toBe(4000);
    expect(res.body.payment.method).toBe("cash");
  });

  it("reports an online deposit with the balance still owed", async () => {
    const a = await makeAppt();
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: a.id,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: 1500,
        status: "succeeded",
      },
    });
    const res = await getAppt(a.id);
    expect(res.body.payment.state).toBe("deposit");
    expect(res.body.payment.onlineCents).toBe(1500);
    expect(res.body.payment.remainingCents).toBe(2500);
  });

  it("NEVER returns card data or a Stripe id, on any payment path", async () => {
    const a = await makeAppt({ paidAmount: 40, paidMethod: "card" });
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: a.id,
        stripePaymentIntentId: `pi_secret_${randomToken(10)}`,
        stripeChargeId: `ch_secret_${randomToken(10)}`,
        stripeConnectAccountId: "acct_secret_test",
        mode: "ahead",
        amount: 4000,
        status: "succeeded",
      },
    });
    const res = await getAppt(a.id);
    expect(res.status).toBe(200);
    expect(res.body.payment.card).toBeNull();
    expect(res.body.payment.receiptUrl).toBeNull();
    // Nothing provider-shaped anywhere in the payload, not just in `payment`.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("pi_secret");
    expect(raw).not.toContain("ch_secret");
    expect(raw).not.toContain("acct_");
    expect(raw).not.toMatch(/stripe/i);
  });

  it("a COMPED cut is settled, not still owing the full ticket", async () => {
    const a = await makeAppt({ paidAmount: 0, paidMethod: "other", paidAt: new Date() });
    const res = await getAppt(a.id);
    expect(res.body.payment.state).toBe("paid");
    expect(res.body.payment.remainingCents).toBe(0);
    expect(res.body.checkedOutAt).not.toBeNull();
  });

  it("a terminal booking is read-only, and says why", async () => {
    const a = await makeAppt({ status: "CANCELED" });
    const res = await getAppt(a.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("canceled");
    expect(res.body.editable).toBe(false);
    expect(res.body.readOnlyReason).toBe("not_editable");
  });
});

describe("missing contact", () => {
  it("a client with no phone or email yields null actions, not empty strings", async () => {
    const bare = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `anon:${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "Nophone",
      },
    });
    const a = await makeAppt({ clientId: bare.id });
    const res = await getAppt(a.id);
    expect(res.body.contact.phone).toBeNull();
    expect(res.body.contact.phoneDisplay).toBeNull();
    expect(res.body.contact.email).toBeNull();
  });

  it("a clientless walk-in falls back to what the booker typed", async () => {
    const a = await makeAppt({
      clientId: null,
      phone: "+12015559999",
      email: "walkin@example.test",
    });
    const res = await getAppt(a.id);
    expect(res.body.clientId).toBeNull();
    expect(res.body.contact.phone).toBe("+12015559999");
    expect(res.body.contact.email).toBe("walkin@example.test");
  });

  it("an unusable phone is DROPPED rather than offered as a dead Call button", async () => {
    const a = await makeAppt({ clientId: null, phone: "call me!!" });
    const res = await getAppt(a.id);
    expect(res.body.contact.phone).toBeNull();
  });
});

describe("an Acuity-synced booking", () => {
  async function makeVisit(clientOver?: string) {
    return prisma.visit.create({
      data: {
        shopId,
        clientId: clientOver ?? clientId,
        acuityAppointmentId: randomToken(8),
        status: "SCHEDULED",
        scheduledAt: slotAt(18),
        endAt: new Date(slotAt(18).getTime() + 30 * 60_000),
        price: 35,
        serviceName: "Beard trim",
      },
      select: { id: true },
    });
  }

  it("shows the SYNCED contact and refuses to characterize the money", async () => {
    const v = await makeVisit();
    const res = await getVisit(v.id);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("visit");
    expect(res.body.origin).toBe("external");
    expect(res.body.clientName).toBe("Marcus Dean");
    expect(res.body.serviceName).toBe("Beard trim");
    // The contact the ingest matched into THIS shop's client, already E.164.
    expect(res.body.contact.phone).toBe("+12015550134");
    expect(res.body.contact.email).toBe("marcus@example.test");
    // The whole point: ChairBack saw no money, so it claims none.
    expect(res.body.payment.state).toBe("external");
    expect(res.body.payment.remainingCents).toBeNull();
    expect(res.body.payment.collectedCents).toBe(0);
    expect(res.body.editable).toBe(false);
    expect(res.body.readOnlyReason).toBe("external");
  });

  it("labels the source from a connection that actually exists, and links to it", async () => {
    const v = await makeVisit();
    // No connection on file: a truthful label, and no button to a login page
    // the barber has no account on.
    let res = await getVisit(v.id);
    expect(res.body.originLabel).toBe("your booking platform");
    expect(res.body.externalManageUrl).toBeNull();

    await prisma.acuityConnection.create({
      data: { shopId, acuityAccountId: randomToken(6), accessToken: "tok" },
    });
    res = await getVisit(v.id);
    expect(res.body.originLabel).toBe("Acuity");
    expect(res.body.externalManageUrl).toContain("acuityscheduling.com");
    await prisma.acuityConnection.deleteMany({ where: { shopId } });
  });

  it("a NATIVE row already promoted to a Visit is external too", async () => {
    const v = await makeVisit();
    const a = await makeAppt({
      visitId: v.id,
      paidAmount: 40,
      paidMethod: "cash",
      paidAt: new Date(),
    });
    const res = await getAppt(a.id);
    expect(res.body.origin).toBe("external");
    expect(res.body.payment.state).toBe("external");
    // Even a local chair-checkout row discloses nothing once Acuity owns it.
    expect(res.body.payment.inPersonCents).toBe(0);
    expect(res.body.editable).toBe(false);
    expect(res.body.readOnlyReason).toBe("external");
  });
});

describe("tenant isolation", () => {
  it("another shop's appointment is NOT FOUND, never merely forbidden", async () => {
    const foreignStaff = await prisma.staff.create({
      data: { shopId: otherShopId, name: "X" },
    });
    const foreignService = await prisma.service.create({
      data: { shopId: otherShopId, name: "S", durationMin: 30, price: 10 },
    });
    const foreignClient = await prisma.client.create({
      data: {
        shopId: otherShopId,
        acuityClientKey: randomToken(8),
        magicToken: randomToken(),
        firstName: "Secret",
        phone: "+12015550001",
        email: "secret@other.test",
      },
    });
    const foreign = await prisma.appointment.create({
      data: {
        shopId: otherShopId,
        staffId: foreignStaff.id,
        serviceId: foreignService.id,
        clientId: foreignClient.id,
        firstName: "Secret",
        status: "BOOKED",
        startsAt: slotAt(15),
        endsAt: slotAt(16),
        manageToken: randomToken(),
      },
      select: { id: true },
    });

    const res = await getAppt(foreign.id);
    expect(res.status).toBe(404);
    // Not one byte of the other tenant's contact leaks through the error.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("+12015550001");
    expect(raw).not.toContain("secret@other.test");
  });

  it("another shop's synced visit is NOT FOUND", async () => {
    const foreignClient = await prisma.client.create({
      data: {
        shopId: otherShopId,
        acuityClientKey: randomToken(8),
        magicToken: randomToken(),
        firstName: "Hidden",
        phone: "+12015550002",
      },
    });
    const foreign = await prisma.visit.create({
      data: {
        shopId: otherShopId,
        clientId: foreignClient.id,
        acuityAppointmentId: randomToken(8),
        status: "SCHEDULED",
        scheduledAt: slotAt(15),
        endAt: slotAt(16),
      },
      select: { id: true },
    });
    const res = await getVisit(foreign.id);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("+12015550002");
  });

  it("an unknown id is not found", async () => {
    expect((await getAppt("appt_nope")).status).toBe(404);
    expect((await getVisit("visit_nope")).status).toBe(404);
  });
});

/**
 * WHETHER THIS SHOP MAY TEXT THIS CLIENT. The sheet disables its Text action
 * from this field, so a wrong answer here is either a dead button or a TCPA
 * violation. Both "no"s are asserted separately because only one of them is
 * the barber's to fix.
 */
describe("sms reachability", () => {
  async function setConsent(over: {
    phone?: string | null;
    optedOut?: boolean;
    smsConsentAt?: Date | null;
  }) {
    await prisma.client.update({
      where: { id: clientId },
      data: {
        ...(over.phone !== undefined ? { phone: over.phone } : {}),
        ...(over.optedOut !== undefined ? { optedOut: over.optedOut } : {}),
        ...(over.smsConsentAt !== undefined ? { smsConsentAt: over.smsConsentAt } : {}),
      },
    });
  }

  afterEach(async () => {
    await setConsent({ phone: "+12015550134", optedOut: false, smsConsentAt: null });
  });

  it("says ok, with the date the opt-in was captured", async () => {
    const when = new Date("2026-06-03T12:00:00.000Z");
    await setConsent({ optedOut: false, smsConsentAt: when });
    const res = await getAppt((await makeAppt()).id);
    expect(res.body.sms.state).toBe("ok");
    expect(res.body.sms.consentAt).toBe(when.toISOString());
  });

  it("a client who never opted in is no_consent, not ok", async () => {
    await setConsent({ optedOut: false, smsConsentAt: null });
    const res = await getAppt((await makeAppt()).id);
    expect(res.body.sms.state).toBe("no_consent");
    expect(res.body.sms.consentAt).toBeNull();
  });

  it("a STOP outranks a consent that was once given", async () => {
    // The specific truth matters: opted_out is the one the barber CANNOT undo,
    // so it must not be reported as the softer, fixable no_consent.
    await setConsent({ optedOut: true, smsConsentAt: new Date("2026-01-01T00:00:00.000Z") });
    const res = await getAppt((await makeAppt()).id);
    expect(res.body.sms.state).toBe("opted_out");
    expect(res.body.sms.consentAt).toBeNull();
  });

  it("no number on file is no_phone, whatever the consent says", async () => {
    await setConsent({ phone: null, smsConsentAt: new Date() });
    const res = await getAppt((await makeAppt()).id);
    expect(res.body.sms.state).toBe("no_phone");
  });

  it("a clientless walk-in has no consent record at all", async () => {
    const a = await makeAppt({ clientId: null, phone: "+12015550199" });
    const res = await getAppt(a.id);
    expect(res.body.sms.state).toBe("no_client");
    // The appointment's own number is still dialable - a CALL needs no consent.
    expect(res.body.contact.phone).toBe("+12015550199");
  });

  it("an Acuity-synced booking is not textable by default", async () => {
    // The ingest matches a client and normalizes the phone, but never captures
    // an opt-in. A synced client therefore looks reachable and is not.
    const v = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: randomToken(8),
        status: "SCHEDULED",
        scheduledAt: slotAt(15),
        endAt: slotAt(16),
      },
      select: { id: true },
    });
    const res = await getVisit(v.id);
    expect(res.body.sms.state).toBe("no_consent");
  });
});

/**
 * THE REST OF THEIR BOOK. Three back, three forward, and nothing that would
 * mislead: no cancelled row in "upcoming", no booking counted twice, and never
 * a byte of contact detail riding along.
 */
describe("client history", () => {
  async function pastAppt(
    daysAgo: number,
    over: { status?: "COMPLETED" | "NO_SHOW" | "CANCELED"; visitId?: string | null } = {},
  ) {
    const startsAt = slotAt(15, -daysAgo);
    return prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId,
        firstName: "Marcus",
        lastName: "Dean",
        status: over.status ?? "COMPLETED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 45 * 60_000),
        priceAtBooking: 40,
        visitId: over.visitId ?? null,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
  }
  async function futureAppt(daysAhead: number, status: "BOOKED" | "CANCELED" = "BOOKED") {
    const startsAt = slotAt(15, daysAhead);
    return prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId,
        firstName: "Marcus",
        lastName: "Dean",
        status,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 45 * 60_000),
        priceAtBooking: 40,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
  }

  it("returns the most recent three, newest first", async () => {
    for (const d of [2, 9, 30, 60]) await pastAppt(d);
    const res = await getAppt((await makeAppt()).id);
    const prev = res.body.history.previous;
    expect(prev).toHaveLength(3);
    expect(prev[0].startsAt > prev[1].startsAt).toBe(true);
    expect(prev[1].startsAt > prev[2].startsAt).toBe(true);
    // The 60-day-old one fell off the end, not the 2-day-old one.
    expect(new Date(prev[2].startsAt).getTime()).toBeGreaterThan(slotAt(15, -31).getTime());
  });

  it("returns the next three, soonest first, and never the booking being viewed", async () => {
    const viewing = await futureAppt(7);
    for (const d of [10, 14, 21, 28]) await futureAppt(d);
    const res = await getAppt(viewing.id);
    const up = res.body.history.upcoming;
    expect(up).toHaveLength(3);
    expect(up.map((u: { id: string }) => u.id)).not.toContain(viewing.id);
    expect(up[0].startsAt < up[1].startsAt).toBe(true);
  });

  it("a cancelled future booking is in neither list", async () => {
    await futureAppt(10, "CANCELED");
    const res = await getAppt((await makeAppt({ status: "BOOKED" })).id);
    expect(res.body.history.upcoming).toHaveLength(0);
    expect(res.body.history.previous).toHaveLength(0);
  });

  it("carries the service, the status and the price - and no contact detail", async () => {
    await pastAppt(3);
    const res = await getAppt((await makeAppt()).id);
    const [line] = res.body.history.previous;
    expect(line.serviceName).toBe("Skin fade");
    expect(line.status).toBe("completed");
    expect(line.price).toBe(40);
    // A history line is a date, a service and a status. Nothing else.
    const raw = JSON.stringify(res.body.history);
    expect(raw).not.toContain("+12015550134");
    expect(raw).not.toContain("marcus@example.test");
    expect(raw).not.toContain("Marcus");
  });

  it("a booking promoted to a Visit is counted once, not twice", async () => {
    // The same dedupe predicate the agenda uses: a native row that Acuity has
    // taken over exists as BOTH an Appointment and a Visit.
    const v = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: randomToken(8),
        status: "COMPLETED",
        scheduledAt: slotAt(15, -5),
        endAt: slotAt(16, -5),
      },
      select: { id: true },
    });
    await pastAppt(5, { visitId: v.id });
    const res = await getAppt((await makeAppt()).id);
    expect(res.body.history.previous).toHaveLength(1);
  });

  it("never reaches into another shop's book", async () => {
    const foreignClient = await prisma.client.create({
      data: {
        shopId: otherShopId,
        acuityClientKey: "tel:+12015550777",
        magicToken: randomToken(),
        firstName: "Marcus",
        lastName: "Dean",
        phone: "+12015550777",
      },
    });
    const foreignStaff = await prisma.staff.create({
      data: { shopId: otherShopId, name: "Other" },
    });
    const foreignService = await prisma.service.create({
      data: { shopId: otherShopId, name: "Other fade", durationMin: 30, price: 30 },
    });
    await prisma.appointment.create({
      data: {
        shopId: otherShopId,
        staffId: foreignStaff.id,
        serviceId: foreignService.id,
        clientId: foreignClient.id,
        firstName: "Marcus",
        lastName: "Dean",
        status: "COMPLETED",
        startsAt: slotAt(15, -4),
        endsAt: slotAt(16, -4),
        manageToken: randomToken(),
      },
    });
    const res = await getAppt((await makeAppt()).id);
    expect(res.body.history.previous).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain("+12015550777");
  });

  it("a walk-in with no client has an empty book, not an error", async () => {
    const res = await getAppt((await makeAppt({ clientId: null })).id);
    expect(res.status).toBe(200);
    expect(res.body.history).toEqual({ previous: [], upcoming: [] });
  });
});
