import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { blockReference } from "./acuityMirrorRules.js";
import {
  countUnresolvedReleases,
  reconcileShop,
  releaseAllForShop,
  releaseForAppointment,
  settleUnknownRelease,
} from "./acuityMirror.js";

/**
 * RELEASED IS A CLAIM THAT THE BARBER'S CALENDAR IS CLEAR.
 *
 * 🔴 THE BUG THIS FILE EXISTS FOR. `releaseForAppointment` and
 * `releaseAllForShop` flipped every non-terminal row to RELEASING before
 * calling `releaseRow`, which then re-read the row and asked
 * `if (row.state === "UNKNOWN") return` - a state it had just overwritten. The
 * guard could not fire. An ambiguous create was marked RELEASED holding no
 * block id, having deleted nothing, and the reconciler - which only scans
 * PENDING | UNKNOWN | RELEASING - never looked at it again. If that block
 * existed in Acuity it was orphaned permanently: the chair blocked on the
 * barber's real calendar over a slot ChairBack believed was free.
 *
 * THE INVARIANT, asserted from every direction below: a row reaches RELEASED
 * only when the delete was CONFIRMED, or absence was AUTHORITATIVELY PROVEN -
 * either nothing was ever dispatched, or a settled reference lookup came back
 * empty. Ambiguity is never rounded towards "done".
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

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;

const CAL = "cal_ur";
const NOW = new Date();
const START = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
const END = new Date(START.getTime() + 20 * 60 * 1000);
/** Older than VERIFY_SETTLE_MS (10 min), so "absent" counts as authoritative. */
const SETTLED_AGO = new Date(NOW.getTime() - 30 * 60 * 1000);

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `unrel-${randomToken(6)}@test.local`, passwordHash: "x", name: "U" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Unknown Release Shop",
      bookingUrl: "https://ur.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
      acuityOutboundMode: "ENFORCE",
    },
  });
  shopId = shop.id;
  const conn = await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: "acct_ur",
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

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

/**
 * An appointment plus one outbox row in whatever state the test needs.
 *
 * `attempts` matters: it is how the engine tells "we never asked Acuity"
 * (absence by construction) from "we asked and never heard back".
 */
/**
 * Every seeded appointment gets its OWN hour: `Appointment` is uniquely keyed
 * on (staffId, startsAt), so a test seeding two rows on one chair would
 * collide on the index rather than exercise anything.
 */
let seedSlot = 0;

async function seed(opts: {
  state: "PENDING" | "ACTIVE" | "UNKNOWN";
  attempts?: number;
  acuityBlockId?: string | null;
  settledAt?: Date;
  canceled?: boolean;
}) {
  const startsAt = new Date(START.getTime() + seedSlot * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 20 * 60 * 1000);
  seedSlot += 1;

  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Test",
      status: opts.canceled ? "CANCELED" : "BOOKED",
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
  if (opts.settledAt) {
    // The settle clock is lastCreateAttemptAt, so that is what a test ages.
    await prisma.$executeRaw`
      UPDATE "AcuityOutboundBlock" SET "lastCreateAttemptAt" = ${opts.settledAt.toISOString()}::timestamp
       WHERE "id" = ${row.id}`;
  }
  return { appointmentId: appt.id, outboxId: row.id, startsAt, endsAt };
}

const row = async (id: string) =>
  (await prisma.acuityOutboundBlock.findUniqueOrThrow({ where: { id } }));

/**
 * What Acuity's listing returns when OUR block really is there.
 *
 * Reads the row's own span rather than a shared constant: the reference match
 * checks calendar AND span, so a listing built from the wrong hour would read
 * as "not found" and quietly turn a found-block test into an absence test.
 */
async function listingContaining(outboxId: string, blockId = "blk_found") {
  const r = await row(outboxId);
  return [
    {
      id: blockId,
      calendarID: CAL,
      start: r.startsAt.toISOString(),
      end: r.endsAt.toISOString(),
      notes: blockReference(outboxId),
    },
  ];
}

describe("UNKNOWN + a real remote block", () => {
  it("adopts the id and DELETES it, rather than guessing", async () => {
    const { appointmentId, outboxId } = await seed({ state: "UNKNOWN" });
    acuityMock.listBlocks.mockResolvedValue(await listingContaining(outboxId));
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    await releaseForAppointment(shopId, appointmentId);

    // The block we never had an id for was found, deleted, and only THEN
    // called released.
    expect(acuityMock.deleteBlock).toHaveBeenCalledTimes(1);
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_found");
    const after = await row(outboxId);
    expect(after.state).toBe("RELEASED");
    expect(after.acuityBlockId).toBe("blk_found");
  });

  it("leaves the row recoverable when the DELETE itself fails", async () => {
    const { appointmentId, outboxId } = await seed({ state: "UNKNOWN" });
    acuityMock.listBlocks.mockResolvedValue(await listingContaining(outboxId));
    acuityMock.deleteBlock.mockRejectedValue(
      Object.assign(new Error("gateway"), { status: 502 }),
    );

    await releaseForAppointment(shopId, appointmentId);

    // Found, so the id is ours - but the delete never confirmed, so RELEASED
    // would be a lie. RELEASING keeps it in the reconciler's queue.
    const after = await row(outboxId);
    expect(after.state).toBe("RELEASING");
    expect(after.acuityBlockId).toBe("blk_found");
  });
});

describe("UNKNOWN + authoritative absence", () => {
  it("marks RELEASED only once the listing has had time to settle", async () => {
    const { appointmentId, outboxId } = await seed({
      state: "UNKNOWN",
      settledAt: SETTLED_AGO,
    });
    acuityMock.listBlocks.mockResolvedValue([]); // nothing of ours there

    await releaseForAppointment(shopId, appointmentId);

    const after = await row(outboxId);
    expect(after.state).toBe("RELEASED");
    expect(after.lastError).toBe("absent_confirmed");
    // Nothing was deleted, because there was nothing to delete.
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
  });

  it("🔴 refuses to trust an empty listing that arrived too soon", async () => {
    // The create was seconds ago. Acuity's listing may simply not show it yet,
    // and believing "absent" here would mark RELEASED and orphan the very
    // block we were asked to remove.
    const { appointmentId, outboxId } = await seed({ state: "UNKNOWN" });
    acuityMock.listBlocks.mockResolvedValue([]);

    await releaseForAppointment(shopId, appointmentId);

    const after = await row(outboxId);
    expect(after.state).toBe("UNKNOWN");
    expect(after.releaseRequested).toBe(true);
  });
});

describe("an ambiguous LOOKUP stays retryable", () => {
  it("does not become RELEASED when the lookup times out", async () => {
    const { appointmentId, outboxId } = await seed({
      state: "UNKNOWN",
      settledAt: SETTLED_AGO,
    });
    acuityMock.listBlocks.mockRejectedValue(
      Object.assign(new Error("timeout"), { status: 504 }),
    );

    await releaseForAppointment(shopId, appointmentId);

    // 🔴 A failed lookup tells us NOTHING about the block. This is the case
    // most easily mistaken for "not there".
    const after = await row(outboxId);
    expect(after.state).toBe("UNKNOWN");
    expect(after.releaseRequested).toBe(true);
    expect(after.lastError).toBeTruthy();
  });

  it("converges on a later pass once the lookup works", async () => {
    const { appointmentId, outboxId } = await seed({
      state: "UNKNOWN",
      settledAt: SETTLED_AGO,
    });
    acuityMock.listBlocks.mockRejectedValueOnce(
      Object.assign(new Error("timeout"), { status: 504 }),
    );
    await releaseForAppointment(shopId, appointmentId);
    expect((await row(outboxId)).state).toBe("UNKNOWN");

    // Acuity comes back and the block is really there.
    acuityMock.listBlocks.mockResolvedValue(await listingContaining(outboxId));
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    await reconcileShop(shopId, NOW);

    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_found");
    expect((await row(outboxId)).state).toBe("RELEASED");
  });
});

describe("release for one appointment", () => {
  it("an ACTIVE row still deletes by its id, exactly as before", async () => {
    const { appointmentId, outboxId } = await seed({
      state: "ACTIVE",
      acuityBlockId: "blk_active",
    });
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    await releaseForAppointment(shopId, appointmentId);

    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_active");
    expect((await row(outboxId)).state).toBe("RELEASED");
  });

  it("a PENDING row that never dispatched is released without any call", async () => {
    // attempts === 0: no create request ever left this process, so absence is
    // proven by construction. This is the ONE case where RELEASED needs no
    // network round-trip.
    const { appointmentId, outboxId } = await seed({ state: "PENDING", attempts: 0 });

    await releaseForAppointment(shopId, appointmentId);

    const after = await row(outboxId);
    expect(after.state).toBe("RELEASED");
    expect(after.lastError).toBe("never_dispatched");
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
    expect(acuityMock.listBlocks).not.toHaveBeenCalled();
  });

  it("🔴 a PENDING row that WAS attempted is not released blind", async () => {
    // attempts > 0 with no id means a create request went out and we never got
    // a usable answer back. Marking that RELEASED is the original bug wearing
    // a different state.
    const { appointmentId, outboxId } = await seed({ state: "PENDING", attempts: 2 });

    await releaseForAppointment(shopId, appointmentId);

    expect((await row(outboxId)).state).not.toBe("RELEASED");
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
  });
});

describe("shop-wide release (rollback)", () => {
  it("counts what is PROVEN gone, not what it touched", async () => {
    const active = await seed({ state: "ACTIVE", acuityBlockId: "blk_a" });
    const unknown = await seed({ state: "UNKNOWN" });
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    // The unknown one is too fresh to declare absent, and not in the listing.
    acuityMock.listBlocks.mockResolvedValue([]);

    const result = await releaseAllForShop(shopId);

    expect(result.requested).toBe(2);
    // 🔴 The old version returned `rows.length` - "released: 2" while one of
    // them was still unresolved on the calendar.
    expect(result.released).toBe(1);
    expect(result.unresolved).toBe(1);
    expect((await row(active.outboxId)).state).toBe("RELEASED");
    expect((await row(unknown.outboxId)).state).toBe("UNKNOWN");
  });

  it("resolves an unknown block by reference and deletes it", async () => {
    const { outboxId } = await seed({ state: "UNKNOWN", settledAt: SETTLED_AGO });
    acuityMock.listBlocks.mockResolvedValue(await listingContaining(outboxId, "blk_roll"));
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    const result = await releaseAllForShop(shopId);

    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_roll");
    expect(result.released).toBe(1);
    expect(result.unresolved).toBe(0);
  });
});

describe("restart and replay", () => {
  it("a worker that dies mid-release leaves the row claimable, not lost", async () => {
    // The process records the intent and then vanishes before resolving.
    const { appointmentId, outboxId } = await seed({
      state: "UNKNOWN",
      settledAt: SETTLED_AGO,
    });
    acuityMock.listBlocks.mockRejectedValue(new Error("process died"));
    await releaseForAppointment(shopId, appointmentId);

    const mid = await row(outboxId);
    expect(mid.state).toBe("UNKNOWN");
    expect(mid.releaseRequested).toBe(true);

    // A fresh reconciler pass - the "restart" - picks it up from the durable
    // intent alone, with no in-memory state carried over.
    acuityMock.listBlocks.mockResolvedValue(await listingContaining(outboxId, "blk_restart"));
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    await reconcileShop(shopId, NOW);

    expect((await row(outboxId)).state).toBe("RELEASED");
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_restart");
  });

  it("replaying the release is idempotent - one delete, not several", async () => {
    const { appointmentId, outboxId } = await seed({ state: "UNKNOWN" });
    acuityMock.listBlocks.mockResolvedValue(await listingContaining(outboxId, "blk_once"));
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    await releaseForAppointment(shopId, appointmentId);
    await releaseForAppointment(shopId, appointmentId);
    await reconcileShop(shopId, NOW);
    await settleUnknownRelease(outboxId, NOW);

    expect(acuityMock.deleteBlock).toHaveBeenCalledTimes(1);
    expect((await row(outboxId)).state).toBe("RELEASED");
  });

  it("a RELEASED row is never revisited", async () => {
    const { appointmentId, outboxId } = await seed({ state: "UNKNOWN" });
    acuityMock.listBlocks.mockResolvedValue(await listingContaining(outboxId));
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    await releaseForAppointment(shopId, appointmentId);
    expect((await row(outboxId)).state).toBe("RELEASED");

    vi.clearAllMocks();
    await reconcileShop(shopId, NOW);

    expect(acuityMock.listBlocks).not.toHaveBeenCalled();
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();
  });
});

describe("no orphans, and no false RELEASED", () => {
  it("🔴 a block that exists is never left behind a RELEASED row", async () => {
    // The end-to-end shape of the original bug: ambiguous create, cancel
    // arrives, and Acuity really does hold the block.
    const { appointmentId, outboxId } = await seed({ state: "UNKNOWN", canceled: true });
    acuityMock.listBlocks.mockResolvedValue(await listingContaining(outboxId, "blk_orphan"));
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    await releaseForAppointment(shopId, appointmentId);

    const after = await row(outboxId);
    // Either it is RELEASED *because the delete happened*, or it is not
    // RELEASED at all. What must never happen is RELEASED with no delete.
    expect(after.state).toBe("RELEASED");
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_orphan");
  });

  it("no path marks RELEASED while the remote truth is unknown", async () => {
    // Every ambiguous shape at once: fresh-absent, lookup-failed, attempted-
    // but-unconfirmed. None may reach RELEASED.
    const fresh = await seed({ state: "UNKNOWN" });
    const attempted = await seed({ state: "PENDING", attempts: 3 });
    acuityMock.listBlocks.mockResolvedValue([]);

    await releaseAllForShop(shopId);

    expect((await row(fresh.outboxId)).state).not.toBe("RELEASED");
    expect((await row(attempted.outboxId)).state).not.toBe("RELEASED");
  });
});

describe("the disconnect gate", () => {
  it("counts a promised-but-unproven release as a blocker", async () => {
    const { appointmentId } = await seed({ state: "UNKNOWN" });
    acuityMock.listBlocks.mockResolvedValue([]); // too fresh to be authoritative
    await releaseForAppointment(shopId, appointmentId);

    // 🔴 Deleting the AcuityConnection removes the only credentials that could
    // ever find this block, and reconcileShop returns immediately for a shop
    // that is not connected. This count is what stops the disconnect.
    expect(await countUnresolvedReleases(shopId)).toBe(1);
  });

  it("🔴 counts an ACTIVE block too - disconnecting would abandon it", async () => {
    await seed({ state: "ACTIVE", acuityBlockId: "blk_live" });

    // An earlier revision of this file treated a live mirror of a live
    // appointment as "not an unresolved release", on the grounds that whether
    // disconnect should remove it was a product question. That was wrong on
    // correctness grounds: once the credentials are gone nothing can find or
    // delete this block, so it holds the barber's chair shut forever over an
    // appointment ChairBack is no longer mirroring. Being ACTIVE makes it MORE
    // certain to exist remotely, not less - it is the one state where we KNOW
    // there is a real block out there.
    expect(await countUnresolvedReleases(shopId)).toBe(1);
  });

  it("counts a FAILED create as settled - there is nothing to delete", async () => {
    // A definitive refusal means Acuity looked at the create and declined it,
    // so no block was ever made. Blocking a disconnect on that would be
    // refusing over a block that provably does not exist.
    const s = await seed({ state: "UNKNOWN" });
    await prisma.acuityOutboundBlock.update({
      where: { id: s.outboxId },
      data: { state: "FAILED" },
    });

    expect(await countUnresolvedReleases(shopId)).toBe(0);
  });

  it("clears once the release is proven", async () => {
    const { appointmentId } = await seed({ state: "UNKNOWN", settledAt: SETTLED_AGO });
    acuityMock.listBlocks.mockResolvedValue([]);
    await releaseForAppointment(shopId, appointmentId);

    expect(await countUnresolvedReleases(shopId)).toBe(0);
  });
});
