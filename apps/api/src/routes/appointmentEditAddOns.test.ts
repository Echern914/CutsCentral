import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * ADD-ONS ON AN EDIT. A barber could tick a beard trim on New appointment but
 * not on a booking that already existed ("I still can't put an add on while
 * editing my clients appointments"). PATCH /appointments/:id now takes the
 * booking's whole add-on set, and everything the edit route already promised
 * still holds: a longer booking is checked like any other change of time,
 * money never moves on a paid booking, an Acuity-owned booking stays
 * read-only - and an add-on the booking will not carry is REFUSED, never
 * quietly dropped.
 */

const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  listBlocks: vi.fn(),
  listCalendars: vi.fn(),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));
vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return { ...actual, getAcuityClientForShop: vi.fn(async () => acuityMock) };
});

const app = createApp();
let agent: ReturnType<typeof request.agent>;
let shopId: string;
let otherShopId: string;
let staffA: string;
let svcCut: string;
let svcColor: string;
let clientId: string;
/** +15 min, +$10, every service. */
let beard: string;
/** +0 min, $0, every service. */
let towel: string;
/** +20 min, +$15, ONLY with svcCut. */
let design: string;
/** Switched off. */
let retired: string;
/** Another shop's. */
let foreign: string;

function slotAt(hourUtc: number, dayOffset = 7): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  const email = `editaddons-${randomToken(6).toLowerCase()}@test.local`;
  agent = request.agent(app);
  const signup = await agent
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2", name: "E", smsAttested: true });
  expect(signup.status).toBeLessThan(400);
  const created = await agent
    .post("/api/shops")
    .send({ name: "Add-on Edit Shop", bookingUrl: "https://addon-edit.test", smsAttested: true });
  expect(created.status).toBe(201);
  await agent
    .patch("/api/shops/me")
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 0, bookingMaxDays: 400 });
  shopId = (await agent.get("/api/shops/me")).body.id;
  // Set directly: the Acuity mirror engages only for a native-booking shop.
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });

  const user = await prisma.user.findUnique({ where: { email } });
  otherShopId = (
    await prisma.shop.create({
      data: {
        ownerId: user!.id,
        name: "Other",
        bookingUrl: "https://other-addon.test",
        webhookSecret: randomToken(),
        bookingMode: "native",
      },
    })
  ).id;

  staffA = (await prisma.staff.create({ data: { shopId, name: "A" } })).id;
  svcCut = (await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 30 } })).id;
  svcColor = (
    await prisma.service.create({ data: { shopId, name: "Color", durationMin: 60, price: 80 } })
  ).id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId: svcCut, staffId: staffA },
      { shopId, serviceId: svcColor, staffId: staffA },
    ],
  });
  for (let wd = 0; wd < 7; wd++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId: staffA, weekday: wd, startMin: 0, endMin: 24 * 60 },
    });
  }
  clientId = (
    await prisma.client.create({
      data: { shopId, acuityClientKey: randomToken(8), magicToken: randomToken(), firstName: "Sam" },
    })
  ).id;

  const mk = (data: { shopId?: string; name: string; durationMin: number; price: number | null; serviceIds?: string[]; active?: boolean }) =>
    prisma.serviceAddOn
      .create({
        data: {
          shopId: data.shopId ?? shopId,
          name: data.name,
          durationMin: data.durationMin,
          price: data.price,
          serviceIds: data.serviceIds ?? [],
          active: data.active ?? true,
        },
        select: { id: true },
      })
      .then((r) => r.id);
  beard = await mk({ name: "Beard trim", durationMin: 15, price: 10 });
  towel = await mk({ name: "Hot towel", durationMin: 0, price: 0 });
  design = await mk({ name: "Design", durationMin: 20, price: 15, serviceIds: [svcCut] });
  retired = await mk({ name: "Retired rinse", durationMin: 10, price: 5, active: false });
  foreign = await mk({ shopId: otherShopId, name: "Foreign", durationMin: 10, price: 5 });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
});

beforeEach(async () => {
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.payment.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.appointmentPriceChange.deleteMany({ where: { shopId } });
});

type Snap = { id?: string; name: string; durationMin: number; price: number | null };

/** A 30-minute $30 cut at 15:00, optionally already carrying add-ons. */
async function makeAppt(over: { startsAt?: Date; minutes?: number; price?: number | null; addOns?: Snap[]; serviceId?: string; visitId?: string } = {}) {
  const startsAt = over.startsAt ?? slotAt(15);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId: staffA,
      serviceId: over.serviceId ?? svcCut,
      clientId,
      firstName: "Sam",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + (over.minutes ?? 30) * 60_000),
      priceAtBooking: over.price === null ? null : new Prisma.Decimal((over.price ?? 30).toFixed(2)),
      addOns: (over.addOns ?? []) as unknown as Prisma.InputJsonValue,
      visitId: over.visitId ?? null,
      manageToken: randomToken(),
    },
    select: { id: true, startsAt: true, endsAt: true },
  });
}

const patch = (id: string, body: unknown) =>
  agent.patch(`/api/booking/appointments/${id}`).send(body as object);

async function readRow(id: string) {
  const row = await prisma.appointment.findUniqueOrThrow({ where: { id } });
  return {
    minutes: Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000),
    price: row.priceAtBooking === null ? null : Number(row.priceAtBooking),
    addOns: row.addOns as unknown as Snap[],
    row,
  };
}

const BEARD_SNAP = (): Snap => ({ id: beard, name: "Beard trim", durationMin: 15, price: 10 });

describe("adding and removing", () => {
  it("adds an add-on: the booking grows by its minutes and its price, and it is snapshotted", async () => {
    const a = await makeAppt();
    const res = await patch(a.id, { addOnIds: [beard] });
    expect(res.status).toBe(200);
    const r = await readRow(a.id);
    expect(r.minutes).toBe(45);
    expect(r.price).toBe(40);
    expect(r.addOns).toEqual([BEARD_SNAP()]);
    expect(r.row.startsAt.toISOString()).toBe(a.startsAt.toISOString());
  });

  it("🔴 the price it adds is LEDGERED like a typed price change", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { addOnIds: [beard] })).status).toBe(200);
    const ledger = await prisma.appointmentPriceChange.findMany({ where: { appointmentId: a.id } });
    expect(ledger.map((l) => [l.fromPriceCents, l.toPriceCents])).toEqual([[3000, 4000]]);
  });

  it("[] removes every add-on, taking back exactly what each one added", async () => {
    const a = await makeAppt({ minutes: 45, price: 40, addOns: [BEARD_SNAP()] });
    expect((await patch(a.id, { addOnIds: [] })).status).toBe(200);
    const r = await readRow(a.id);
    expect(r.minutes).toBe(30);
    expect(r.price).toBe(30);
    expect(r.addOns).toEqual([]);
  });

  it("an add-on KEPT through an edit keeps the price it was booked at, even if the shop repriced it", async () => {
    // Booked when the beard trim was $8 / 10 min; the shop has since made it
    // $10 / 15 min. Adding a towel must not re-price the beard.
    const old: Snap = { id: beard, name: "Beard trim", durationMin: 10, price: 8 };
    const a = await makeAppt({ minutes: 40, price: 38, addOns: [old] });
    expect((await patch(a.id, { addOnIds: [beard, towel] })).status).toBe(200);
    const r = await readRow(a.id);
    expect(r.price).toBe(38);
    expect(r.minutes).toBe(40);
    expect(r.addOns).toEqual([old, { id: towel, name: "Hot towel", durationMin: 0, price: 0 }]);
  });

  it("leaving addOnIds out leaves the add-ons alone", async () => {
    const a = await makeAppt({ minutes: 45, price: 40, addOns: [BEARD_SNAP()] });
    expect((await patch(a.id, { notes: "just a note" })).status).toBe(200);
    const r = await readRow(a.id);
    expect(r.addOns).toEqual([BEARD_SNAP()]);
    expect(r.minutes).toBe(45);
    expect(r.price).toBe(40);
  });

  it("a priceless booking gains only the add-on's figure", async () => {
    const a = await makeAppt({ price: null });
    expect((await patch(a.id, { addOnIds: [beard] })).status).toBe(200);
    expect((await readRow(a.id)).price).toBe(10);
  });

  it("a walk-in's extra services (no id) ride through an add-on edit untouched", async () => {
    const extra: Snap = { name: "Lineup", durationMin: 10, price: 5 };
    const a = await makeAppt({ minutes: 40, price: 35, addOns: [extra] });
    expect((await patch(a.id, { addOnIds: [beard] })).status).toBe(200);
    const r = await readRow(a.id);
    expect(r.addOns).toEqual([extra, BEARD_SNAP()]);
    expect(r.minutes).toBe(55);
    expect(r.price).toBe(45);
  });

  it("the detail read hands the sheet each add-on's frozen minutes and price", async () => {
    const a = await makeAppt({ minutes: 45, price: 40, addOns: [BEARD_SNAP()] });
    const res = await agent.get(`/api/booking/appointments/${a.id}/detail`);
    expect(res.status).toBe(200);
    expect(res.body.addOns).toEqual([BEARD_SNAP()]);
  });

  it("the edit context lists the shop's ACTIVE add-ons with the services each goes with", async () => {
    const res = await agent.get("/api/booking/appointments/edit-context");
    expect(res.status).toBe(200);
    const ids = res.body.addOns.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining([beard, towel, design]));
    expect(ids).not.toContain(retired);
    expect(ids).not.toContain(foreign);
    expect(res.body.addOns.find((a: { id: string }) => a.id === design).serviceIds).toEqual([svcCut]);
  });
});

describe("🔴 refused, never dropped", () => {
  for (const [label, id] of [
    ["switched off", () => retired],
    ["another shop's", () => foreign],
    ["made up", () => "nope"],
  ] as const) {
    it(`an add-on that is ${label} is refused and the booking is untouched`, async () => {
      const a = await makeAppt();
      const res = await patch(a.id, { addOnIds: [beard, id()] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_add_on");
      const r = await readRow(a.id);
      expect(r.addOns).toEqual([]);
      expect(r.minutes).toBe(30);
      expect(r.price).toBe(30);
    });
  }

  it("another service's add-on is refused", async () => {
    const a = await makeAppt({ serviceId: svcColor, minutes: 60, price: 80 });
    const res = await patch(a.id, { addOnIds: [design] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_add_on");
  });

  it("a service change the booking's add-on doesn't go with is refused BY NAME", async () => {
    const snap: Snap = { id: design, name: "Design", durationMin: 20, price: 15 };
    const a = await makeAppt({ minutes: 50, price: 45, addOns: [snap] });
    const res = await patch(a.id, { serviceId: svcColor });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_add_on");
    expect(res.body.message).toContain("Design");
    const r = await readRow(a.id);
    expect(r.row.serviceId).toBe(svcCut);
    expect(r.addOns).toEqual([snap]);
  });

  it("the same service change with the add-on taken off goes through, at the new service's length plus what's left", async () => {
    const a = await makeAppt({
      minutes: 65,
      price: 55,
      addOns: [{ id: design, name: "Design", durationMin: 20, price: 15 }, BEARD_SNAP()],
    });
    const res = await patch(a.id, { serviceId: svcColor, addOnIds: [beard] });
    expect(res.status).toBe(200);
    const r = await readRow(a.id);
    expect(r.row.serviceId).toBe(svcColor);
    expect(r.addOns).toEqual([BEARD_SNAP()]);
    expect(r.minutes).toBe(60 + 15);
    // A service change never re-priced a booking on its own; the Design's $15 comes off.
    expect(r.price).toBe(40);
  });
});

describe("length goes through the same conflict handling as any edit", () => {
  it("🔴 an add-on that runs into the next booking is refused as an overlap - and Book anyway lands it", async () => {
    const start = slotAt(15);
    await makeAppt({ startsAt: new Date(start.getTime() + 30 * 60_000) }); // 15:30
    const a = await makeAppt({ startsAt: start });
    const res = await patch(a.id, { addOnIds: [beard] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
    expect(res.body.code).toBe("OVERLAP");
    let r = await readRow(a.id);
    expect(r.minutes).toBe(30);
    expect(r.addOns).toEqual([]);
    expect(r.price).toBe(30);

    const forced = await patch(a.id, { addOnIds: [beard], overlapConfirmation: res.body.confirmation });
    expect(forced.status).toBe(200);
    r = await readRow(a.id);
    expect(r.minutes).toBe(45);
    expect(r.row.overlapForcedAt).not.toBeNull();
  });

  it("a 0-minute add-on doesn't touch the time at all", async () => {
    const start = slotAt(15);
    await makeAppt({ startsAt: new Date(start.getTime() + 30 * 60_000) });
    const a = await makeAppt({ startsAt: start });
    await prisma.appointment.update({ where: { id: a.id }, data: { confirmationSentAt: new Date() } });
    expect((await patch(a.id, { addOnIds: [towel] })).status).toBe(200);
    const r = await readRow(a.id);
    expect(r.minutes).toBe(30);
    // No time moved, so no re-confirmation either.
    expect(r.row.confirmationSentAt).not.toBeNull();
  });

  it("an explicit duration in the same edit wins: it is the TOTAL, add-ons included", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { addOnIds: [beard], durationMin: 50 })).status).toBe(200);
    expect((await readRow(a.id)).minutes).toBe(50);
  });

  it("a typed price in the same edit wins over the add-on sum", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { addOnIds: [beard], price: 35 })).status).toBe(200);
    const r = await readRow(a.id);
    expect(r.price).toBe(35);
    expect(r.addOns).toEqual([BEARD_SNAP()]);
  });
});

describe("money never moves here", () => {
  async function pay(appointmentId: string, amount: number) {
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        purpose: "booking",
        amount,
        status: "succeeded",
      },
    });
  }

  it("🔴 a PAID booking refuses an add-on that changes its total, and nothing is written", async () => {
    const a = await makeAppt();
    await pay(a.id, 3000);
    const res = await patch(a.id, { addOnIds: [beard] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("price_change_on_paid");
    const r = await readRow(a.id);
    expect(r.addOns).toEqual([]);
    expect(r.minutes).toBe(30);
    expect(r.price).toBe(30);
  });

  it("🔴 a PAID booking can't drop a priced add-on either - that would shrink a paid total", async () => {
    const a = await makeAppt({ minutes: 45, price: 40, addOns: [BEARD_SNAP()] });
    await pay(a.id, 4000);
    const res = await patch(a.id, { addOnIds: [] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("price_change_on_paid");
  });

  it("a PAID booking still takes a free add-on (no money moves)", async () => {
    const a = await makeAppt();
    await pay(a.id, 3000);
    expect((await patch(a.id, { addOnIds: [towel] })).status).toBe(200);
    expect((await readRow(a.id)).addOns.map((x) => x.id)).toEqual([towel]);
  });

  it("a DEPOSIT booking takes a priced add-on: the new total still covers the deposit", async () => {
    const a = await makeAppt();
    await pay(a.id, 1000);
    expect((await patch(a.id, { addOnIds: [beard] })).status).toBe(200);
    expect((await readRow(a.id)).price).toBe(40);
  });
});

describe("Acuity", () => {
  it("🔴 a booking Acuity owns is still read-only, add-ons included", async () => {
    const visit = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: "1764227999",
        status: "SCHEDULED",
        scheduledAt: slotAt(15),
        endAt: slotAt(16),
      },
      select: { id: true },
    });
    const a = await makeAppt({ visitId: visit.id });
    const res = await patch(a.id, { addOnIds: [beard] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("synced_appointment_readonly");
    expect((await readRow(a.id)).addOns).toEqual([]);
  });

  describe("a ChairBack booking mirrored onto Acuity", () => {
    let blockSeq = 0;
    beforeAll(async () => {
      await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "ENFORCE" } });
      const conn = await prisma.acuityConnection.create({
        data: { shopId, acuityAccountId: `ACC_${randomToken(6)}`, accessToken: "enc", refreshToken: "enc" },
        select: { connectedAt: true },
      });
      await prisma.staff.update({
        where: { id: staffA },
        data: { acuityCalendarId: "cal_main", acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1000) },
      });
    });
    afterAll(async () => {
      await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
      await prisma.acuityConnection.deleteMany({ where: { shopId } });
      await prisma.staff.update({ where: { id: staffA }, data: { acuityCalendarId: null, acuityCalendarMappedAt: null } });
      await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
    });
    afterEach(() => {
      acuityMock.createBlock.mockReset();
      acuityMock.deleteBlock.mockReset();
      acuityMock.listBlocks.mockReset();
    });

    it("🔴 the longer booking is blocked on Acuity at its NEW end, exactly as a duration edit is", async () => {
      acuityMock.createBlock.mockImplementation(async () => ({ id: `blk-${++blockSeq}` }));
      acuityMock.deleteBlock.mockResolvedValue(undefined);
      acuityMock.listBlocks.mockResolvedValue([]);
      const a = await makeAppt();
      const res = await patch(a.id, { addOnIds: [beard] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.mirror).toBe("active");
      const live = await prisma.acuityOutboundBlock.findMany({
        where: { appointmentId: a.id, state: "ACTIVE" },
        select: { startsAt: true, endsAt: true },
      });
      expect(live).toHaveLength(1);
      expect(live[0]!.startsAt.toISOString()).toBe(a.startsAt.toISOString());
      expect(live[0]!.endsAt.toISOString()).toBe(
        new Date(a.startsAt.getTime() + 45 * 60_000).toISOString(),
      );
    });
  });
});
