import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { earliestWalkInBackdate, randomToken } from "@chairback/config";

/**
 * THE AMBER PANEL MUST MEAN SOMEBODY ELSE WAS IN THE CHAIR.
 *
 * 🔴 WHAT WENT WRONG (drickcuttinup, Sept 2026, read from production). The
 * walk-in route treated "the reservation guard threw" as "double-booked". The
 * guard refuses a RESERVATION for reasons that are not occupancy - an UNBOOKED
 * targeted slot (a published offer, nobody in it) and the turnover buffer - so
 * 4 of Drick's first 5 walk-ins after the panel shipped tripped it on nothing
 * but his own unbooked "After/Before Hours" specials, and two of those then
 * recorded eight rows against his own full-day Acuity block. Meanwhile a REAL
 * overlap with an Acuity booking could never be named: the visit query's
 * NULL-end branch matched ~19,900 imported history rows, `take: 10` kept ten
 * from 2022, and the live booking fell off the end.
 *
 * So each case below is one half of a two-sided contract - the panel appears
 * for a separate, real occupant of the recorded time and for nothing else -
 * plus the backdated walk-in: a record of the past, with the same accounting
 * and none of the live walk-in's side effects.
 */
const sendToBarber = vi.hoisted(() =>
  vi.fn(async (_params: { kind: string }) => ({ pushed: true, texted: false, emailed: false })),
);
vi.mock("../services/barberNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/barberNotify.js")>()),
  sendToBarber,
}));
// Only the mirror describe connects a shop to Acuity; everywhere else no block
// is ever attempted, so this mock is inert there.
const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(async () => ({ id: `blk_${Math.random().toString(36).slice(2)}` })),
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

const { createApp } = await import("../app.js");
const app = createApp();
const password = "supersecret123";
const MIN = 60_000;

interface Shop {
  cookie: string;
  shopId: string;
  staffId: string;
  serviceId: string;
  clientId: string;
}
const shopIds: string[] = [];

async function makeShop(label: string): Promise<Shop> {
  const email = `wtruth-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://t.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const shopId = shop.body.id as string;
  shopIds.push(shopId);
  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", cookie)
        .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 })
    ).status,
  ).toBe(200);
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Chair" });
  expect(staff.status).toBe(201);
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staff.body.id] });
  expect(svc.status).toBe(201);
  const client = await prisma.client.create({
    data: { shopId, acuityClientKey: `tel:+1555${randomToken(7)}`, magicToken: randomToken(), firstName: "Synced" },
    select: { id: true },
  });
  return { cookie, shopId, staffId: staff.body.id, serviceId: svc.body.id, clientId: client.id };
}

/** Everything a case can leave behind. Refuses an unset id: Prisma reads
 *  `{ shopId: undefined }` as NO filter, which would wipe the shared test DB. */
async function wipe(shopId: string) {
  if (!shopId) throw new Error("wipe() without a shopId");
  await prisma.bookingConflict.deleteMany({ where: { shopId } });
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.tierOpening.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.externalBlock.deleteMany({ where: { shopId } });
  await prisma.targetedSlot.deleteMany({ where: { shopId } });
}

const walkIn = (s: Shop, body: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/booking/appointments/walk-in")
    .set("Cookie", s.cookie)
    .send({ amount: 30, staffId: s.staffId, ...body });

const rowsFor = (shopId: string) =>
  prisma.bookingConflict.findMany({
    where: { shopId },
    select: { receiptId: true, conflictingId: true, conflictingKind: true },
  });

function appointment(
  s: Shop,
  status: "BOOKED" | "COMPLETED",
  start: Date,
  minutes: number,
  extra: { completedAt?: Date } = {},
) {
  return prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      firstName: "Booked",
      status,
      startsAt: start,
      endsAt: new Date(start.getTime() + minutes * MIN),
      manageToken: randomToken(),
      ...extra,
    },
    select: { id: true },
  });
}

function visit(
  s: Shop,
  status: "SCHEDULED" | "COMPLETED" | "CANCELED",
  start: Date,
  end: Date | null,
  extra: { completedAt?: Date; canceledAt?: Date } = {},
) {
  return prisma.visit.create({
    data: {
      shopId: s.shopId,
      clientId: s.clientId,
      acuityAppointmentId: `acu-${randomToken(8)}`,
      status,
      scheduledAt: start,
      endAt: end,
      ...extra,
    },
    select: { id: true },
  });
}

/** Long enough for a fire-and-forget alert to have shown up, if one were coming. */
const settle = () => new Promise((r) => setTimeout(r, 300));
/** A whole minute, well in the past: what a datetime picker hands back. */
const minutesAgo = (m: number) => new Date(Math.floor((Date.now() - m * MIN) / MIN) * MIN);

let A: Shop;
let B: Shop;

beforeAll(async () => {
  A = await makeShop("Truth A");
  B = await makeShop("Truth B");
});

beforeEach(async () => {
  await wipe(A.shopId);
  await wipe(B.shopId);
  await prisma.shop.update({ where: { id: A.shopId }, data: { bookingBufferMin: 0 } });
  sendToBarber.mockClear();
  acuityMock.createBlock.mockClear();
});

afterAll(async () => {
  for (const id of shopIds) await prisma.shop.deleteMany({ where: { id } });
});

describe("the panel appears for a real, separate occupant - and for nothing else", () => {
  it("no overlap: an empty chair records clean - no panel, no row, no alert", async () => {
    const res = await walkIn(A);
    expect(res.status).toBe(201);
    expect(res.body.conflict).toBeUndefined();
    await settle();
    expect(await rowsFor(A.shopId)).toEqual([]);
    expect(sendToBarber).not.toHaveBeenCalled();
  });

  it("🔴 an UNBOOKED special - even with the barber's own full-day block on it - is not a double booking", async () => {
    // Drick's shape exactly: a recurring "After/Before Hours" special nobody
    // booked, and a whole-day block he put in Acuity, both over the time he
    // was actually cutting. Neither has anyone in it.
    await prisma.targetedSlot.create({
      data: {
        shopId: A.shopId,
        staffId: A.staffId,
        serviceId: A.serviceId,
        startsAt: new Date(Date.now() - 10 * MIN),
        durationMin: 120,
        price: 60,
        active: true,
      },
    });
    const dayStart = new Date(new Date().setUTCHours(0, 0, 0, 0));
    await prisma.externalBlock.create({
      data: {
        shopId: A.shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: dayStart,
        endsAt: new Date(dayStart.getTime() + 24 * 60 * MIN),
        reason: "Closed",
      },
    });

    const res = await walkIn(A);
    expect(res.status).toBe(201);
    expect(res.body.conflict).toBeUndefined();
    await settle();
    expect(await rowsFor(A.shopId)).toEqual([]);
    expect(sendToBarber).not.toHaveBeenCalled();
  });

  it("a turnover buffer is not an overlap", async () => {
    // Starts five minutes after the walk-in's half hour ends: inside a
    // 15-minute buffer (the RESERVATION guard refuses it), outside the time.
    await prisma.shop.update({ where: { id: A.shopId }, data: { bookingBufferMin: 15 } });
    await appointment(A, "BOOKED", new Date(Date.now() + 35 * MIN), 30);
    const res = await walkIn(A);
    expect(res.status).toBe(201);
    expect(res.body.conflict).toBeUndefined();
    expect(await rowsFor(A.shopId)).toEqual([]);
  });

  it("🔴 SELF-EXCLUSION: a walk-in is never reported against itself - only against the one before it", async () => {
    const first = await walkIn(A, { operationId: `op-${randomToken(12)}` });
    expect(first.status).toBe(201);
    // Its own row is not a conflict: nothing else is in the chair.
    expect(first.body.conflict).toBeUndefined();

    const op = `op-${randomToken(12)}`;
    const second = await walkIn(A, { operationId: op });
    expect(second.status).toBe(201);
    // The first cut is still in the chair by the record, so it IS a separate
    // occupant - and the only one. The new receipt never names itself.
    expect(second.body.conflict.withAppointmentIds).toEqual([first.body.id]);
    expect(await rowsFor(A.shopId)).toEqual([
      { receiptId: second.body.id, conflictingId: first.body.id, conflictingKind: "appointment" },
    ]);

    // A retry of the second submission replays the same answer and adds nothing.
    const replay = await walkIn(A, { operationId: op });
    expect(replay.body.id).toBe(second.body.id);
    expect(replay.body.conflict.withAppointmentIds).toEqual([first.body.id]);
    expect(await rowsFor(A.shopId)).toHaveLength(1);
  });

  it("genuine overlap: a booked appointment across now is named, recorded and alerted", async () => {
    const booked = await appointment(A, "BOOKED", new Date(Date.now() - 5 * MIN), 30);
    const res = await walkIn(A);
    expect(res.status).toBe(201);
    expect(res.body.conflict.withAppointmentIds).toEqual([booked.id]);
    expect(await rowsFor(A.shopId)).toEqual([
      { receiptId: res.body.id, conflictingId: booked.id, conflictingKind: "appointment" },
    ]);
    await vi.waitFor(() => expect(sendToBarber).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(sendToBarber.mock.calls[0]![0].kind).toBe("conflict");
  });

  it("🔴 ACUITY overlap is NAMED, even behind years of imported history with no end time", async () => {
    // Production drickcuttinup: ~19,900 SCHEDULED visits with endAt NULL from
    // its Acuity import. The unbounded NULL-end branch matched all of them,
    // take:10 kept ten from 2022, and the live booking was never named.
    await prisma.visit.createMany({
      data: Array.from({ length: 40 }, (_, i) => ({
        shopId: A.shopId,
        clientId: A.clientId,
        acuityAppointmentId: `hist-${randomToken(8)}`,
        status: "SCHEDULED" as const,
        scheduledAt: new Date(Date.UTC(2022, 9, 3 + (i % 25), 14, 0, 0)),
        endAt: null,
      })),
    });
    const live = await visit(A, "SCHEDULED", new Date(Date.now() - 5 * MIN), new Date(Date.now() + 40 * MIN));

    const res = await walkIn(A);
    expect(res.status).toBe(201);
    // A visit is not an Appointment, so no id in the list - but it IS reported.
    expect(res.body.conflict).toEqual({ withAppointmentIds: [] });
    // ...and, the part that was broken, it is named: one durable row, for the
    // live booking, and none for the history.
    expect(await rowsFor(A.shopId)).toEqual([
      { receiptId: res.body.id, conflictingId: live.id, conflictingKind: "visit" },
    ]);
    await vi.waitFor(() => expect(sendToBarber).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it("a block is listed alongside a real occupant, never on its own", async () => {
    const live = await visit(A, "SCHEDULED", new Date(Date.now() - 5 * MIN), new Date(Date.now() + 25 * MIN));
    const block = await prisma.externalBlock.create({
      data: {
        shopId: A.shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: new Date(Date.now() - 60 * MIN),
        endsAt: new Date(Date.now() + 60 * MIN),
      },
      select: { id: true },
    });
    const res = await walkIn(A);
    const rows = await rowsFor(A.shopId);
    expect(rows.map((r) => `${r.conflictingKind}:${r.conflictingId}`).sort()).toEqual(
      [`block:${block.id}`, `visit:${live.id}`].sort(),
    );
    expect(res.body.conflict).toEqual({ withAppointmentIds: [] });
  });
});

describe("a walk-in written down after the fact", () => {
  it("is recorded AT the stated time, with exactly the live walk-in's accounting", async () => {
    const at = minutesAgo(180);
    const live = await walkIn(A, { amount: 45, method: "card" });
    const back = await walkIn(A, { amount: 45, method: "card", occurredAt: at.toISOString() });
    expect(back.status).toBe(201);

    const select = {
      clientId: true,
      firstName: true,
      status: true,
      serviceId: true,
      staffId: true,
      priceAtBooking: true,
      paidAmount: true,
      paidMethod: true,
      completedAt: true,
      visitId: true,
      holdExpiresAt: true,
      startsAt: true,
      endsAt: true,
      paidAt: true,
    } as const;
    const liveRow = await prisma.appointment.findUniqueOrThrow({ where: { id: live.body.id }, select });
    const backRow = await prisma.appointment.findUniqueOrThrow({ where: { id: back.body.id }, select });

    // Dated when it happened: the cut, and the money taken for it.
    expect(backRow.startsAt.toISOString()).toBe(at.toISOString());
    expect(backRow.paidAt!.toISOString()).toBe(at.toISOString());
    expect(backRow.endsAt.getTime() - backRow.startsAt.getTime()).toBe(30 * MIN);
    // Everything else is the live walk-in's row, field for field.
    const { startsAt: _s1, endsAt: _e1, paidAt: _p1, ...liveRest } = liveRow;
    const { startsAt: _s2, endsAt: _e2, paidAt: _p2, ...backRest } = backRow;
    expect(backRest).toEqual(liveRest);
    expect(backRest.status).toBe("COMPLETED");
    expect(backRest.clientId).toBeNull();
    // No loyalty, no client book entry - same as live.
    expect(await prisma.punchLedger.count({ where: { shopId: A.shopId } })).toBe(0);
    expect(await prisma.visit.count({ where: { shopId: A.shopId } })).toBe(0);
  });

  it("🔴 its span ends by the moment it is recorded - it takes no bookable time", async () => {
    // Ten minutes ago with a half-hour cut: unclipped, it would still be "in
    // the chair" for twenty minutes, flag the next booking and hold its time.
    const next = await appointment(A, "BOOKED", new Date(Date.now() + 5 * MIN), 30);
    const back = await walkIn(A, { occurredAt: minutesAgo(10).toISOString() });
    const answeredAt = Date.now();
    expect(back.status).toBe(201);
    expect(back.body.conflict).toBeUndefined();
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: back.body.id },
      select: { startsAt: true, endsAt: true },
    });
    expect(row.endsAt.getTime()).toBeLessThanOrEqual(answeredAt);
    expect(row.endsAt.getTime()).toBeGreaterThan(row.startsAt.getTime());
    // The next customer's booking is exactly as it was.
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: next.id } })).status).toBe("BOOKED");
  });

  it("🔴 the future is refused, and so is anything that is not a time - nothing written", async () => {
    const before = await prisma.appointment.count({ where: { shopId: A.shopId } });
    const future = await walkIn(A, { occurredAt: new Date(Date.now() + 60 * MIN).toISOString() });
    expect(future.status).toBe(400);
    expect(future.body.error).toBe("occurred_at_not_in_past");
    for (const bad of ["yesterday", "2026-09-21T10:00:00", 1737000000000]) {
      expect((await walkIn(A, { occurredAt: bad })).status).toBe(400);
    }
    expect(await prisma.appointment.count({ where: { shopId: A.shopId } })).toBe(before);
  });

  it("🔴 a genuine overlap IN THE PAST is still flagged - and the other booking is left untouched", async () => {
    // A booking that happened and was promoted to COMPLETED held the chair
    // then. Judged "as of now" it would be invisible - which is how a
    // backdated walk-in could hide a real double booking.
    const T = minutesAgo(2 * 24 * 60);
    const past = await appointment(A, "COMPLETED", T, 30, { completedAt: new Date(T.getTime() + 30 * MIN) });
    const snapshot = () => prisma.appointment.findUniqueOrThrow({ where: { id: past.id } });
    const before = await snapshot();

    const back = await walkIn(A, { occurredAt: new Date(T.getTime() + 10 * MIN).toISOString() });
    expect(back.status).toBe(201);
    expect(back.body.conflict.withAppointmentIds).toEqual([past.id]);
    expect(await rowsFor(A.shopId)).toEqual([
      { receiptId: back.body.id, conflictingId: past.id, conflictingKind: "appointment" },
    ]);
    // Not one field of the other booking moved - updatedAt included.
    expect(await snapshot()).toEqual(before);
  });

  it("...a past Acuity booking is flagged too, and a cancelled one is not", async () => {
    const T = minutesAgo(26 * 60);
    const happened = await visit(A, "COMPLETED", T, new Date(T.getTime() + 45 * MIN), {
      completedAt: new Date(T.getTime() + 45 * MIN),
    });
    await visit(A, "CANCELED", T, new Date(T.getTime() + 45 * MIN), { canceledAt: T });
    const back = await walkIn(A, { occurredAt: new Date(T.getTime() + 15 * MIN).toISOString() });
    expect(back.body.conflict).toEqual({ withAppointmentIds: [] });
    expect(await rowsFor(A.shopId)).toEqual([
      { receiptId: back.body.id, conflictingId: happened.id, conflictingKind: "visit" },
    ]);
  });
});

describe("🔴 a backdated walk-in has no side effects beyond its own row", () => {
  let C: Shop;

  beforeAll(async () => {
    // ENFORCING, connected and mapped, so a LIVE walk-in really does mirror -
    // without that, "the backdated one did not mirror" would prove nothing.
    C = await makeShop("Truth Mirror");
    await prisma.shop.update({ where: { id: C.shopId }, data: { acuityOutboundMode: "ENFORCE" } });
    const conn = await prisma.acuityConnection.create({
      data: { shopId: C.shopId, acuityAccountId: `ACC_${randomToken(6)}`, accessToken: "enc" },
      select: { connectedAt: true },
    });
    await prisma.staff.update({
      where: { id: C.staffId },
      data: { acuityCalendarId: "cal_main", acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1_000) },
    });
  });

  beforeEach(async () => {
    await wipe(C.shopId);
  });

  /**
   * A loyalty-tier hold, still live, on the chair's UPCOMING time - the kind
   * the reservation guard releases when a barber-driven write covers it. (A
   * hold must lapse before its slot starts - `TierOpening_hold_before_start_check`
   * - so no hold can ever be live over time already gone.)
   */
  const heldOpening = () =>
    prisma.tierOpening.create({
      data: {
        shopId: C.shopId,
        staffId: C.staffId,
        serviceId: C.serviceId,
        startsAt: new Date(Date.now() + 10 * MIN),
        endsAt: new Date(Date.now() + 40 * MIN),
        minTier: "GOLD",
        heldUntil: new Date(Date.now() + 5 * MIN),
      },
      select: { id: true },
    });
  const openingStatus = async (id: string) =>
    (await prisma.tierOpening.findUniqueOrThrow({ where: { id } })).status;
  const outboxFor = (appointmentId: string) =>
    prisma.acuityOutboundBlock.count({ where: { shopId: C.shopId, appointmentId } });
  const messages = async () =>
    (await prisma.nudge.count({ where: { shopId: C.shopId } })) +
    (await prisma.emailIntent.count({ where: { shopId: C.shopId } }));

  it("CONTROL: a live walk-in mirrors to Acuity and releases a hold on the time it now fills", async () => {
    const opening = await heldOpening();
    const res = await walkIn(C);
    expect(res.status).toBe(201);
    expect(await outboxFor(res.body.id)).toBe(1);
    await vi.waitFor(() => expect(acuityMock.createBlock).toHaveBeenCalledTimes(1));
    expect(await openingStatus(opening.id)).toBe("RELEASED");
  });

  it("backdated: no Acuity create, no alert, no customer message - even over a real past overlap", async () => {
    const at = minutesAgo(3 * 60);
    // A genuine overlap, so the alert is genuinely due - and still not sent.
    const past = await appointment(C, "COMPLETED", new Date(at.getTime() - 10 * MIN), 30);
    const messagesBefore = await messages();

    const res = await walkIn(C, { occurredAt: at.toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.conflict.withAppointmentIds).toEqual([past.id]);
    await settle();

    expect(await outboxFor(res.body.id)).toBe(0);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
    expect(sendToBarber).not.toHaveBeenCalled();
    expect(await messages()).toBe(messagesBefore);
    // The evidence still waits in the inbox.
    expect(await prisma.bookingConflict.count({ where: { shopId: C.shopId } })).toBe(1);
  });

  it("backdated minutes ago: a customer's hold on the time just after it is left alone", async () => {
    // A half-hour cut logged as starting 15 minutes ago would, at full length
    // and through the guard, cover this hold's slot and release it - handing
    // a promised opening away over a cut that is already finished.
    const opening = await heldOpening();
    const res = await walkIn(C, { occurredAt: minutesAgo(15).toISOString() });
    expect(res.status).toBe(201);
    expect(await openingStatus(opening.id)).toBe("HELD");
    expect(await outboxFor(res.body.id)).toBe(0);
  });
});

describe("🔴 the 30-day window, counted in the SHOP's calendar days", () => {
  let N: Shop; // America/New_York
  let K: Shop; // Pacific/Kiritimati, UTC+14

  beforeAll(async () => {
    N = await makeShop("Truth Window NY");
    await prisma.shop.update({ where: { id: N.shopId }, data: { timezone: "America/New_York" } });
    K = await makeShop("Truth Window Kiritimati");
    await prisma.shop.update({ where: { id: K.shopId }, data: { timezone: "Pacific/Kiritimati" } });
  });

  beforeEach(async () => {
    await wipe(N.shopId);
    await wipe(K.shopId);
  });

  const receipts = (s: Shop) => prisma.appointment.count({ where: { shopId: s.shopId } });

  it("EXACTLY 30 days back - the first minute of that shop-local day - is recorded; the minute before is not", async () => {
    const earliest = earliestWalkInBackdate(new Date(), "America/New_York");
    const before = await receipts(N);

    const tooOld = await walkIn(N, { occurredAt: new Date(earliest.getTime() - MIN).toISOString() });
    expect(tooOld.status).toBe(400);
    expect(tooOld.body.error).toBe("occurred_at_too_old");
    expect(await receipts(N)).toBe(before);

    const edge = await walkIn(N, { occurredAt: earliest.toISOString() });
    expect(edge.status).toBe(201);
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: edge.body.id },
      select: { startsAt: true },
    });
    expect(row.startsAt.toISOString()).toBe(earliest.toISOString());
  });

  it("OVER 30 days back is refused - 31, 45 and 365 days - and nothing is written", async () => {
    const before = await receipts(N);
    for (const days of [31, 45, 365]) {
      const res = await walkIn(N, { occurredAt: new Date(Date.now() - days * 24 * 60 * MIN).toISOString() });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("occurred_at_too_old");
    }
    expect(await receipts(N)).toBe(before);
  });

  it("a FUTURE time is refused, even one second ahead", async () => {
    const res = await walkIn(N, { occurredAt: new Date(Date.now() + 1000).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("occurred_at_not_in_past");
  });

  it("🔴 the SHOP's zone draws the line, not UTC's - one instant, two answers", async () => {
    // A (UTC) and K (+14) open their windows at different instants whatever
    // the time of day; probe the minute before the later of the two.
    const now = new Date();
    const utc = earliestWalkInBackdate(now, "UTC");
    const kir = earliestWalkInBackdate(now, "Pacific/Kiritimati");
    expect(utc.getTime()).not.toBe(kir.getTime());
    const [later, earlier] = utc.getTime() > kir.getTime() ? [A, K] : [K, A];
    const probe = new Date(Math.max(utc.getTime(), kir.getTime()) - MIN).toISOString();

    const refused = await walkIn(later, { occurredAt: probe });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("occurred_at_too_old");
    expect((await walkIn(earlier, { occurredAt: probe })).status).toBe(201);
  });

  describe("DST, with the server's clock pinned", () => {
    // Date ONLY: faking timers too would stall the HTTP stack. And always a
    // PAST instant - the session cookie was issued today, so a pinned clock
    // beyond its expiry answers 401 before the route is ever reached.
    const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("🔴 SPRING FORWARD: exactly 720 hours back is refused - local midnight 30 days back is the line", async () => {
      at("2026-03-20T04:30:00Z"); // 20 Mar 00:30 EDT
      // 720 hours ago is 17 Feb 23:30 EST - the 31st calendar day back,
      // because the clocks lost an hour in between.
      const hours = await walkIn(N, { occurredAt: "2026-02-18T04:30:00.000Z" });
      expect(hours.status).toBe(400);
      expect(hours.body.error).toBe("occurred_at_too_old");
      // 18 Feb 00:00 EST - the first minute of the 30th day back.
      expect((await walkIn(N, { occurredAt: "2026-02-18T05:00:00.000Z" })).status).toBe(201);
    });

    it("🔴 FALL BACK: the line is still local midnight, an hour and a half past 720 hours", async () => {
      at("2025-11-16T05:30:00Z"); // 16 Nov 2025 00:30 EST; clocks fell back 2 Nov
      // 720 hours ago (17 Oct 01:30 EDT) is inside: the calendar window runs longer.
      expect((await walkIn(N, { occurredAt: "2025-10-17T05:30:00.000Z" })).status).toBe(201);
      // 17 Oct 00:00 EDT is the first minute; 23:59 the night before is not.
      expect((await walkIn(N, { occurredAt: "2025-10-17T04:00:00.000Z" })).status).toBe(201);
      const tooOld = await walkIn(N, { occurredAt: "2025-10-17T03:59:00.000Z" });
      expect(tooOld.status).toBe(400);
      expect(tooOld.body.error).toBe("occurred_at_too_old");
    });
  });
});

describe("tenancy and authorization, enforced on the server", () => {
  it("another shop's chair is refused, backdated or not - nothing written anywhere", async () => {
    const counts = async () => [
      await prisma.appointment.count({ where: { shopId: A.shopId } }),
      await prisma.appointment.count({ where: { shopId: B.shopId } }),
    ];
    const before = await counts();
    for (const body of [{}, { occurredAt: minutesAgo(60).toISOString() }]) {
      const res = await request(app)
        .post("/api/booking/appointments/walk-in")
        .set("Cookie", A.cookie)
        .send({ amount: 30, staffId: B.staffId, ...body });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("staff_not_found");
    }
    expect(await counts()).toEqual(before);
  });

  it("another shop's bookings, visits and blocks never flag this shop's receipt", async () => {
    const T = minutesAgo(90);
    for (const start of [T, new Date(Date.now() - 5 * MIN)]) {
      await appointment(B, "BOOKED", start, 45);
      await visit(B, "SCHEDULED", start, new Date(start.getTime() + 45 * MIN));
      await prisma.externalBlock.create({
        data: {
          shopId: B.shopId,
          externalId: `acuity:${randomToken(6)}`,
          startsAt: start,
          endsAt: new Date(start.getTime() + 45 * MIN),
        },
      });
    }
    const back = await walkIn(A, { occurredAt: new Date(T.getTime() + 5 * MIN).toISOString() });
    const live = await walkIn(A);
    expect(back.body.conflict).toBeUndefined();
    expect(live.body.conflict).toBeUndefined();
    expect(await rowsFor(A.shopId)).toEqual([]);
  });

  it("🔴 a BARBER seat cannot record one at all - refused by the server, not hidden by the UI", async () => {
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: `wtruth-barber-${randomToken(6)}@test.local`, password, name: "Seat", smsAttested: true });
    const barberCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    await prisma.shopMember.create({
      data: { shopId: A.shopId, userId: signup.body.id as string, role: "BARBER" },
    });
    const before = await prisma.appointment.count({ where: { shopId: A.shopId } });
    const res = await request(app)
      .post("/api/booking/appointments/walk-in")
      .set("Cookie", barberCookie)
      .send({ amount: 30, staffId: A.staffId, occurredAt: minutesAgo(30).toISOString() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_role");
    expect(await prisma.appointment.count({ where: { shopId: A.shopId } })).toBe(before);
    await prisma.shopMember.deleteMany({ where: { shopId: A.shopId, userId: signup.body.id as string } });
  });
});
