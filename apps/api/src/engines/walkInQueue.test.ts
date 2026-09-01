import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { raceBehindRowLock } from "../testing/raceBarrier.js";
import { randomToken } from "@chairback/config";
import {
  assignEntry,
  cancelEntry,
  claimEntry,
  createEntryByStaff,
  editEntry,
  listQueue,
  markLeft,
  markNoShow,
  markReady,
  reorderEntry,
  returnToLine,
  WalkInDuplicateEntryError,
  WalkInIllegalTransitionError,
  WalkInQueueFullError,
  WalkInStaleTransitionError,
  WALK_IN_MAX_ACTIVE,
  type QueueActor,
} from "./walkInQueue.js";
import { POSITION_GAP } from "./walkInLifecycle.js";

/**
 * The queue engine's promises, raced for real against the test database:
 *
 *   - every transition is a status-CAS: stale/repeated/raced actions are
 *     0-count misses, never partial writes;
 *   - two simultaneous claims produce EXACTLY one winner;
 *   - ordering survives reorder + renumber with no silent shuffles;
 *   - one live spot per phone, freed the moment an entry goes terminal;
 *   - the audit trail rides inside the same transaction.
 *
 * Every timestamp is injected (`now` is a parameter) - nothing here depends
 * on the day the suite runs.
 */

let userId: string;
let shopId: string;
let chairA: string;
let chairB: string;
let svc30: string;
let svc15: string;
let phoneSeq = 0;

const NOW = new Date("2026-09-02T15:00:00.000Z");

// userId is filled in beforeAll - a staff-actor audit row must name someone
// (the DB CHECK refuses an unattributed one, which one early draft of this
// suite proved by accident).
const MANAGER: Extract<QueueActor, { kind: "manager" }> = {
  kind: "manager",
  userId: null,
  staffId: null,
};
const barberOn = (staffId: string): Extract<QueueActor, { kind: "barber" }> => ({
  kind: "barber",
  userId: null,
  staffId,
});

function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(1000 + phoneSeq).padStart(4, "0")}`;
}

async function makeEntry(over: { phone?: string | null; serviceIds?: string[]; preferredStaffId?: string } = {}) {
  return createEntryByStaff({
    shopId,
    timezone: "UTC",
    actor: MANAGER,
    input: {
      firstName: `Walkin${++phoneSeq}`,
      phone: over.phone === undefined ? freshPhone() : over.phone,
      serviceIds: over.serviceIds ?? [svc30],
      preferredStaffId: over.preferredStaffId,
    },
    now: NOW,
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wq-${randomToken(6)}@test.local`, name: "WQ" },
    select: { id: true },
  });
  userId = user.id;
  MANAGER.userId = userId;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Queue Cuts",
      slug: `wq-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
      walkInEnabled: true,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
    select: { id: true },
  });
  shopId = shop.id;
  chairA = (await prisma.staff.create({ data: { shopId, name: "Ava" } })).id;
  chairB = (await prisma.staff.create({ data: { shopId, name: "Ben" } })).id;
  svc30 = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
    })
  ).id;
  svc15 = (
    await prisma.service.create({
      data: { shopId, name: "Lineup", durationMin: 15, price: 20 },
    })
  ).id;
});

afterAll(async () => {
  await prisma.walkInEvent.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("create + snapshots + ordering", () => {
  it("appends with the gap, snapshots services, audits in the same commit", async () => {
    const e1 = await makeEntry({ serviceIds: [svc30, svc15] });
    const e2 = await makeEntry();

    expect(e2.position - e1.position).toBe(POSITION_GAP);
    expect(e1.services.map((s) => s.name)).toEqual(["Fade", "Lineup"]);
    expect(e1.totalDurationMin).toBe(45);
    expect(e1.services[0]!.price).toBe(40);
    expect(e1.joinedAt).toBe(NOW.toISOString());

    const events = await prisma.walkInEvent.findMany({
      where: { shopId, entryId: e1.id },
    });
    expect(events.map((ev) => ev.type)).toEqual(["entry.created_by_staff"]);
    // The audit row carries codes and counts, never the customer.
    expect(JSON.stringify(events[0]!.metadata)).not.toContain("Walkin");
  });

  it("the board lists active entries in (position, joinedAt, id) order", async () => {
    const list = await listQueue(shopId);
    const positions = list.map((e) => e.position);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("one live spot per phone: a second active entry with the same number refuses", async () => {
    const phone = freshPhone();
    await makeEntry({ phone });
    await expect(makeEntry({ phone })).rejects.toBeInstanceOf(
      WalkInDuplicateEntryError,
    );
  });

  it("a terminal entry frees its phone for a rejoin", async () => {
    const phone = freshPhone();
    const e = await makeEntry({ phone });
    await markLeft({ shopId, entryId: e.id, actor: MANAGER, now: NOW });
    const again = await makeEntry({ phone });
    expect(again.id).not.toBe(e.id);
  });

  it("refuses when the shop's line is at the platform ceiling", async () => {
    // A second shop so the rows don't pollute the main fixtures.
    const shop2 = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Full Cuts",
        slug: `wqf-${randomToken(5)}`.toLowerCase(),
        webhookSecret: randomToken(),
        timezone: "UTC",
        walkInEnabled: true,
      },
      select: { id: true },
    });
    const svc = await prisma.service.create({
      data: { shopId: shop2.id, name: "Cut", durationMin: 30 },
    });
    await prisma.walkInEntry.createMany({
      data: Array.from({ length: WALK_IN_MAX_ACTIVE }, (_, i) => ({
        shopId: shop2.id,
        firstName: `Bulk${i}`,
        source: "STAFF",
        status: "WAITING",
        position: (i + 1) * POSITION_GAP,
        joinedAt: NOW,
      })),
    });
    await expect(
      createEntryByStaff({
        shopId: shop2.id,
        timezone: "UTC",
        actor: MANAGER,
        input: { firstName: "OneTooMany", serviceIds: [svc.id] },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(WalkInQueueFullError);
  });
});

describe("🔴 concurrency: exactly one winner", () => {
  it("two simultaneous claims -> one ASSIGNED, one stale", async () => {
    const e = await makeEntry();
    // 🔴 A BARRIER, not Promise.all. The guard here is the claim's
    // compare-and-set (WHERE status = the status we read), and only a real
    // interleaving exercises it: both callers must READ the entry as WAITING
    // and only then reach their UPDATE. Holding the row with SELECT ... FOR
    // UPDATE gives exactly that - a plain SELECT does not block, so both read
    // WAITING, then both queue at the write. Promise.all alone let the first
    // call finish before the second started, and this test passed with the
    // CAS deleted.
    const { results, settledEarly } = await raceBehindRowLock(
      "WalkInEntry",
      e.id,
      [
        () => claimEntry({ shopId, entryId: e.id, actor: barberOn(chairA), now: NOW }),
        () => claimEntry({ shopId, entryId: e.id, actor: barberOn(chairB), now: NOW }),
      ],
    );
    // Nobody may finish before the barrier lifts: a claim that completed early
    // never contended for anything, and this test would be theatre.
    expect(settledEarly).toBe(0);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser fails one of two honest ways, depending on when its read
    // lands relative to the winner's commit: a 0-count CAS (read WAITING,
    // then lost the row) or an illegal-from-ASSIGNED (read after commit).
    // Either way: refused, nothing written.
    const reason = (lost[0] as PromiseRejectedResult).reason as Error;
    expect(
      reason instanceof WalkInStaleTransitionError ||
        reason instanceof WalkInIllegalTransitionError,
    ).toBe(true);

    const row = await prisma.walkInEntry.findUnique({ where: { id: e.id } });
    expect(row!.status).toBe("ASSIGNED");
    expect([chairA, chairB]).toContain(row!.assignedStaffId);
    // Exactly ONE claim audit row - the loser wrote nothing.
    const claims = await prisma.walkInEvent.count({
      where: { shopId, entryId: e.id, type: "entry.claimed" },
    });
    expect(claims).toBe(1);
  });

  it("claim vs cancel: exactly one of them decides", async () => {
    const e = await makeEntry();
    // Same barrier: both transitions read WAITING, both queue at their CAS.
    const { results, settledEarly } = await raceBehindRowLock(
      "WalkInEntry",
      e.id,
      [
        () => claimEntry({ shopId, entryId: e.id, actor: barberOn(chairA), now: NOW }),
        () => cancelEntry({ shopId, entryId: e.id, actor: MANAGER, now: NOW }),
      ],
    );
    expect(settledEarly).toBe(0);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    const row = await prisma.walkInEntry.findUnique({ where: { id: e.id } });
    expect(["ASSIGNED", "CANCELED"]).toContain(row!.status);
  });

  it("a repeated ready is refused and changes nothing - not even the stamp", async () => {
    const e = await makeEntry();
    await claimEntry({ shopId, entryId: e.id, actor: barberOn(chairA), now: NOW });
    const t1 = new Date(NOW.getTime() + 60_000);
    await markReady({ shopId, entryId: e.id, actor: barberOn(chairA), now: t1 });
    const t2 = new Date(NOW.getTime() + 120_000);
    await expect(
      markReady({ shopId, entryId: e.id, actor: barberOn(chairA), now: t2 }),
    ).rejects.toBeInstanceOf(WalkInIllegalTransitionError);
    const row = await prisma.walkInEntry.findUnique({ where: { id: e.id } });
    expect(row!.readyAt!.toISOString()).toBe(t1.toISOString());
  });

  it("a failed transition writes NO audit row", async () => {
    const e = await makeEntry();
    await expect(
      markReady({ shopId, entryId: e.id, actor: MANAGER, now: NOW }),
    ).rejects.toBeInstanceOf(WalkInIllegalTransitionError); // WAITING -> READY
    const events = await prisma.walkInEvent.findMany({
      where: { shopId, entryId: e.id },
    });
    expect(events.map((ev) => ev.type)).toEqual(["entry.created_by_staff"]);
  });

  it("a barber cannot move another chair's customer (structural 0-count)", async () => {
    const e = await makeEntry();
    await claimEntry({ shopId, entryId: e.id, actor: barberOn(chairA), now: NOW });
    await expect(
      markReady({ shopId, entryId: e.id, actor: barberOn(chairB), now: NOW }),
    ).rejects.toBeInstanceOf(WalkInStaleTransitionError);
  });
});

describe("assignment + return", () => {
  it("manager reassignment moves the chair and audits the old one", async () => {
    const e = await makeEntry();
    await assignEntry({ shopId, entryId: e.id, staffId: chairA, actor: MANAGER, now: NOW });
    const moved = await assignEntry({ shopId, entryId: e.id, staffId: chairB, actor: MANAGER, now: NOW });
    expect(moved.assignedStaffId).toBe(chairB);
    const events = await prisma.walkInEvent.findMany({
      where: { shopId, entryId: e.id, type: "entry.assigned" },
    });
    expect(events).toHaveLength(2);
    // 🔴 Asserted as a SET, deliberately - NOT ordered by createdAt. That column
    // is TIMESTAMP(3), so two assignments a millisecond apart carry the SAME
    // stamp and `orderBy: createdAt` is a genuine tie that Postgres resolves
    // however it likes. It read as a flake that only appeared under load.
    const froms = events.map(
      (ev) => (ev.metadata as { fromStaffId?: string }).fromStaffId ?? null,
    );
    // Exactly one of the two records a MOVE, and it moved off chair A; the
    // original assignment came from nowhere and names no previous chair.
    expect(froms.filter((f) => f !== null)).toEqual([chairA]);
    expect(froms.filter((f) => f === null)).toHaveLength(1);
  });

  it("return to line keeps the position and clears exactly the trio", async () => {
    const e = await makeEntry();
    await claimEntry({ shopId, entryId: e.id, actor: barberOn(chairA), now: NOW });
    await markReady({ shopId, entryId: e.id, actor: barberOn(chairA), now: NOW });
    const back = await returnToLine({
      shopId,
      entryId: e.id,
      actor: barberOn(chairA),
      now: NOW,
    });
    expect(back.status).toBe("WAITING");
    expect(back.position).toBe(e.position);
    expect(back.assignedStaffId).toBeNull();
    expect(back.assignedAt).toBeNull();
    expect(back.readyAt).toBeNull();
    expect(back.joinedAt).toBe(e.joinedAt);
  });

  it("no-show requires a summons: ASSIGNED yes, the stamps land", async () => {
    const e = await makeEntry();
    await assignEntry({ shopId, entryId: e.id, staffId: chairA, actor: MANAGER, now: NOW });
    const t = new Date(NOW.getTime() + 300_000);
    const gone = await markNoShow({ shopId, entryId: e.id, actor: MANAGER, now: t });
    expect(gone.status).toBe("NO_SHOW");
    expect(gone.noShowAt).toBe(t.toISOString());
  });
});

describe("reorder", () => {
  /** A dedicated shop per reorder test - position math needs a queue nobody
   * else's leftovers are sitting in. */
  async function freshQueue(n: number) {
    const shop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: `Reorder ${randomToken(4)}`,
        slug: `wqr-${randomToken(5)}`.toLowerCase(),
        webhookSecret: randomToken(),
        timezone: "UTC",
        walkInEnabled: true,
      },
      select: { id: true },
    });
    const svc = await prisma.service.create({
      data: { shopId: shop.id, name: "Cut", durationMin: 30 },
    });
    const entries = [];
    for (let i = 0; i < n; i++) {
      entries.push(
        await createEntryByStaff({
          shopId: shop.id,
          timezone: "UTC",
          actor: MANAGER,
          input: { firstName: `Q${i}`, serviceIds: [svc.id] },
          now: new Date(NOW.getTime() + i * 1000),
        }),
      );
    }
    return { shopId: shop.id, entries };
  }

  it("moves to the front and between neighbors by midpoint", async () => {
    const q = await freshQueue(3);
    const [a, b, c] = q.entries;
    const moved = await reorderEntry({
      shopId: q.shopId,
      entryId: c!.id,
      afterEntryId: null,
      expectedPosition: c!.position,
      actor: MANAGER,
      now: NOW,
    });
    expect(moved.position).toBeLessThan(a!.position);
    const between = await reorderEntry({
      shopId: q.shopId,
      entryId: c!.id,
      afterEntryId: a!.id,
      expectedPosition: moved.position,
      actor: MANAGER,
      now: NOW,
    });
    expect(between.position).toBeGreaterThan(a!.position);
    expect(between.position).toBeLessThan(b!.position);
  });

  it("a stale expectedPosition is refused, not silently re-aimed", async () => {
    const q = await freshQueue(2);
    await expect(
      reorderEntry({
        shopId: q.shopId,
        entryId: q.entries[1]!.id,
        afterEntryId: null,
        expectedPosition: q.entries[1]!.position + 7, // a stale board
        actor: MANAGER,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(WalkInStaleTransitionError);
  });

  it("a closed gap renumbers the whole queue and preserves the intended order", async () => {
    const q = await freshQueue(3);
    const [a, b, c] = q.entries;
    // Force adjacency: no midpoint exists between a and b.
    await prisma.walkInEntry.update({ where: { id: a!.id }, data: { position: 10 } });
    await prisma.walkInEntry.update({ where: { id: b!.id }, data: { position: 11 } });
    const moved = await reorderEntry({
      shopId: q.shopId,
      entryId: c!.id,
      afterEntryId: a!.id,
      expectedPosition: c!.position,
      actor: MANAGER,
      now: NOW,
    });
    const rows = await prisma.walkInEntry.findMany({
      where: { shopId: q.shopId },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    });
    expect(rows.map((r) => r.id)).toEqual([a!.id, c!.id, b!.id]);
    // Renumbered: strictly increasing, gap restored.
    expect(rows.map((r) => r.position)).toEqual([
      POSITION_GAP,
      2 * POSITION_GAP,
      3 * POSITION_GAP,
    ]);
    expect(moved.position).toBe(2 * POSITION_GAP);
  });

  it("only a WAITING entry can be reordered", async () => {
    const q = await freshQueue(2);
    const [a] = q.entries;
    await assignEntry({ shopId: q.shopId, entryId: a!.id, staffId: chairA, actor: MANAGER, now: NOW })
      .catch(() => null); // chairA belongs to the main shop - expected to fail
    // Use a chair in THIS shop instead.
    const chair = await prisma.staff.create({
      data: { shopId: q.shopId, name: "Rex" },
    });
    await assignEntry({ shopId: q.shopId, entryId: a!.id, staffId: chair.id, actor: MANAGER, now: NOW });
    await expect(
      reorderEntry({
        shopId: q.shopId,
        entryId: a!.id,
        afterEntryId: null,
        expectedPosition: a!.position,
        actor: MANAGER,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(WalkInIllegalTransitionError);
  });
});

describe("edit", () => {
  it("replaces the service snapshots wholesale and recomputes the total", async () => {
    const e = await makeEntry({ serviceIds: [svc30] });
    const edited = await editEntry({
      shopId,
      timezone: "UTC",
      entryId: e.id,
      actor: MANAGER,
      now: NOW,
      patch: { serviceIds: [svc15, svc30], note: "beard too" },
    });
    expect(edited.services.map((s) => s.name)).toEqual(["Lineup", "Fade"]);
    expect(edited.totalDurationMin).toBe(45);
    expect(edited.note).toBe("beard too");
  });

  it("details freeze once READY", async () => {
    const e = await makeEntry();
    await claimEntry({ shopId, entryId: e.id, actor: barberOn(chairA), now: NOW });
    await markReady({ shopId, entryId: e.id, actor: barberOn(chairA), now: NOW });
    await expect(
      editEntry({
        shopId,
        timezone: "UTC",
        entryId: e.id,
        actor: MANAGER,
        now: NOW,
        patch: { note: "too late" },
      }),
    ).rejects.toBeInstanceOf(WalkInIllegalTransitionError);
  });
});
