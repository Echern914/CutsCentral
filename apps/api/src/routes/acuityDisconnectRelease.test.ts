import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { blockReference } from "../engines/acuityMirrorRules.js";
import { createApp } from "../app.js";

/**
 * DISCONNECTING MUST NOT ABANDON BLOCKS ON SOMEBODY'S REAL CALENDAR.
 *
 * 🔴 THE ORDER THAT WAS WRONG. `POST /acuity/disconnect` deleted the
 * AcuityConnection with no regard for the mirror. That connection holds the
 * ONLY credentials that can list or delete a block, and `reconcileShop`
 * returns immediately for a shop that is not connected - so every block
 * ChairBack had put on that calendar became permanently unreachable the
 * instant the token went. An ACTIVE one would hold the barber's chair shut
 * forever, over an appointment ChairBack was no longer mirroring, with nothing
 * left in the product pointing at it.
 *
 * So a disconnect REQUEST is now a release request: it queues every unsettled
 * block, keeps the credentials until each one is confirmed deleted or proven
 * absent, and refuses in the meantime.
 *
 * 🔴 AND IT NEVER TOUCHES THE APPOINTMENT. Disconnecting an integration must
 * not cancel somebody's haircut - the customer keeps the booking, only the
 * Acuity mirror of it goes.
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
  return {
    ...actual,
    getAcuityClientForShop: vi.fn(async () => acuityMock),
  };
});

const app = createApp();

let cookie = "";
let userId = "";
let shopId = "";
let staffId = "";
let serviceId = "";

const CAL = "cal_dis";
const NOW = new Date();
const START = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
/** Older than the 10-minute settle window, so "absent" is authoritative. */
const SETTLED_AGO = new Date(NOW.getTime() - 30 * 60 * 1000);

const email = `disc-${randomToken(6)}@test.local`.toLowerCase();

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Disc", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const created = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Disconnect Shop", bookingUrl: "https://dc.test", smsAttested: true });
  expect(created.status).toBe(201);
  shopId = created.body.id;
  userId = (
    await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { ownerId: true } })
  ).ownerId;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", acuityOutboundMode: "ENFORCE" },
  });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 20, price: 30 },
  });
  serviceId = service.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.staff.deleteMany({ where: { shopId } });
  await prisma.acuityConnection.deleteMany({ where: { shopId } });

  const conn = await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: "acct_dis",
      accessToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
    select: { connectedAt: true },
  });
  const staff = await prisma.staff.create({
    data: {
      shopId,
      name: "Barber",
      acuityCalendarId: CAL,
      acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1_000),
    },
  });
  staffId = staff.id;
});

afterEach(async () => {
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
});

let slot = 0;

async function seedBlock(opts: {
  state: "PENDING" | "ACTIVE" | "UNKNOWN" | "RELEASING";
  acuityBlockId?: string | null;
  attempts?: number;
  settled?: boolean;
}) {
  const startsAt = new Date(START.getTime() + slot * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 20 * 60 * 1000);
  slot += 1;
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Customer",
      status: "BOOKED",
      startsAt,
      endsAt,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  const row = await prisma.acuityOutboundBlock.create({
    data: {
      shopId,
      appointmentId: appt.id,
      staffId,
      acuityCalendarId: CAL,
      startsAt,
      endsAt,
      state: opts.state,
      attempts: opts.attempts ?? (opts.state === "PENDING" ? 0 : 1),
      acuityBlockId: opts.acuityBlockId ?? null,
    },
    select: { id: true },
  });
  if (opts.settled) {
    await prisma.$executeRaw`
      UPDATE "AcuityOutboundBlock" SET "lastCreateAttemptAt" = ${SETTLED_AGO.toISOString()}::timestamp
       WHERE "id" = ${row.id}`;
  }
  return { appointmentId: appt.id, outboxId: row.id, startsAt, endsAt };
}

const disconnect = (body: Record<string, unknown> = {}) =>
  request(app).post("/api/acuity/oauth/disconnect").set("Cookie", cookie).send(body);

const connectionExists = async () =>
  (await prisma.acuityConnection.count({ where: { shopId } })) === 1;

const blockRow = (id: string) =>
  prisma.acuityOutboundBlock.findUniqueOrThrow({ where: { id } });

describe("an ACTIVE block blocks the disconnect", () => {
  it("refuses, keeps the credentials, and deletes the remote block", async () => {
    const { appointmentId, outboxId } = await seedBlock({
      state: "ACTIVE",
      acuityBlockId: "blk_active",
    });
    // Acuity is down for the whole of the first request. Note `mockRejected-
    // Value`, not `...Once`: the route queues the release AND runs a reconcile
    // pass, so a single-shot failure would be retried and succeed within the
    // same request - which is correct behaviour, and would make this test
    // assert nothing about the refusal.
    acuityMock.deleteBlock.mockRejectedValue(
      Object.assign(new Error("gateway"), { status: 502 }),
    );

    const first = await disconnect();

    expect(first.status).toBe(409);
    expect(first.body.error).toBe("unresolved_acuity_releases");
    expect(first.body.unresolved).toBe(1);
    // 🔴 THE CREDENTIALS SURVIVE. Without them nothing could ever delete this.
    expect(await connectionExists()).toBe(true);
    // It was ASKED for, though - the request is the release request.
    expect((await blockRow(outboxId)).releaseRequested).toBe(true);

    // 🔴 AND THE CUSTOMER STILL HAS THEIR APPOINTMENT.
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(appt.status).toBe("BOOKED");
    expect(appt.canceledAt).toBeNull();

    // Acuity comes back; the retry deletes it and the disconnect completes.
    acuityMock.deleteBlock.mockReset();
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    const second = await disconnect();

    expect(second.status).toBe(200);
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_active");
    expect((await blockRow(outboxId)).state).toBe("RELEASED");
    expect(await connectionExists()).toBe(false);
    // Still booked, after the whole dance.
    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).status,
    ).toBe("BOOKED");
  });

  it("disconnects cleanly when there is nothing outstanding", async () => {
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(await connectionExists()).toBe(false);
  });
});

describe("an ambiguous create keeps the credentials too", () => {
  it("stays recoverable when the lookup times out, then settles", async () => {
    const { outboxId } = await seedBlock({ state: "UNKNOWN", settled: true });
    acuityMock.listBlocks.mockRejectedValueOnce(
      Object.assign(new Error("timeout"), { status: 504 }),
    );

    const first = await disconnect();

    expect(first.status).toBe(409);
    expect(await connectionExists()).toBe(true);
    // A failed lookup taught us nothing; the row must not have been called done.
    expect((await blockRow(outboxId)).state).toBe("UNKNOWN");

    // The listing works on the retry and the block really is there.
    const r = await blockRow(outboxId);
    acuityMock.listBlocks.mockResolvedValue([
      {
        id: "blk_unknown",
        calendarID: CAL,
        start: r.startsAt.toISOString(),
        end: r.endsAt.toISOString(),
        notes: blockReference(outboxId),
      },
    ]);
    acuityMock.deleteBlock.mockReset();
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    const second = await disconnect();

    expect(second.status).toBe(200);
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_unknown");
    expect((await blockRow(outboxId)).state).toBe("RELEASED");
    expect(await connectionExists()).toBe(false);
  });

  it("completes once absence is authoritatively proven", async () => {
    const { outboxId } = await seedBlock({ state: "UNKNOWN", settled: true });
    acuityMock.listBlocks.mockResolvedValue([]); // nothing of ours, and settled

    const res = await disconnect();

    expect(res.status).toBe(200);
    const after = await blockRow(outboxId);
    expect(after.state).toBe("RELEASED");
    expect(after.lastError).toBe("absent_confirmed");
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
    expect(await connectionExists()).toBe(false);
  });

  it("refuses while an unsettled absence is still only a guess", async () => {
    // The create was moments ago: an empty listing is not yet evidence.
    await seedBlock({ state: "UNKNOWN" });
    acuityMock.listBlocks.mockResolvedValue([]);

    const res = await disconnect();

    expect(res.status).toBe(409);
    expect(await connectionExists()).toBe(true);
  });
});

describe("replay and concurrency", () => {
  it("a replayed disconnect deletes once and then completes", async () => {
    const { outboxId } = await seedBlock({ state: "ACTIVE", acuityBlockId: "blk_once" });
    acuityMock.deleteBlock.mockReset();
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    const a = await disconnect();
    const b = await disconnect();
    const c = await disconnect();

    expect(a.status).toBe(200);
    // Already disconnected: idempotent, not an error.
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    // 🔴 ONE delete, not three. A RELEASED row is skipped by every path.
    expect(acuityMock.deleteBlock).toHaveBeenCalledTimes(1);
    expect((await blockRow(outboxId)).state).toBe("RELEASED");
  });

  it("two disconnects racing settle on one outcome", async () => {
    const { outboxId } = await seedBlock({ state: "ACTIVE", acuityBlockId: "blk_race" });
    acuityMock.deleteBlock.mockReset();
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    // Not a barrier - this asserts CONVERGENCE, not contention. Whatever order
    // Postgres serialises these in, the end state is one deleted block and a
    // disconnected shop, and neither caller sees a 500.
    const [x, y] = await Promise.all([disconnect(), disconnect()]);

    expect([x.status, y.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect((await blockRow(outboxId)).state).toBe("RELEASED");
    expect(await connectionExists()).toBe(false);
  });
});

describe("force", () => {
  it("never claims release - it records the rows as knowingly stranded", async () => {
    const { appointmentId, outboxId } = await seedBlock({ state: "UNKNOWN" });
    acuityMock.listBlocks.mockResolvedValue([]); // too fresh to be authoritative

    expect((await disconnect()).status).toBe(409);

    const forced = await disconnect({ force: true });

    expect(forced.status).toBe(200);
    expect(await connectionExists()).toBe(false);
    const after = await blockRow(outboxId);
    // 🔴 NOT RELEASED. "We gave up while it was still unknown" and "the
    // calendar is clear" are different facts, and only one of them is true.
    expect(after.state).not.toBe("RELEASED");
    expect(after.lastError).toBe("disconnected_before_release");
    // The appointment is still the customer's.
    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).status,
    ).toBe("BOOKED");
  });
});
