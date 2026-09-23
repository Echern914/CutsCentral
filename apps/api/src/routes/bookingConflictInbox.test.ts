import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * THE MANAGER CONFLICT INBOX.
 *
 * The booking-integrity P0 made a double-booked chair durable but unreadable:
 * the row existed and nothing could open it. This is the reader, and the rules
 * it has to keep are mostly about what it must NOT do -
 *
 *   * it must not change a booking (resolving is bookkeeping, not rescheduling);
 *   * it must not delete anything (the history is the point);
 *   * it must not show one shop another shop's collisions;
 *   * it must not let a barber seat in at all;
 *   * it must not copy customer data into a second surface;
 *   * it must not let a second resolver overwrite the first one's name.
 */
const app = createApp();
const password = "supersecret123";

interface Shop {
  cookie: string;
  shopId: string;
  staffId: string;
  serviceId: string;
  ownerId: string;
}
let A: Shop;
let B: Shop;

async function makeShop(label: string): Promise<Shop> {
  const email = `cinbox-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://c.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: `${label} Chair` });
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staff.body.id] });
  const row = await prisma.shop.findUniqueOrThrow({
    where: { id: shop.body.id },
    select: { ownerId: true },
  });
  return {
    cookie,
    shopId: shop.body.id,
    staffId: staff.body.id,
    serviceId: svc.body.id,
    ownerId: row.ownerId,
  };
}

/** A receipt-shaped appointment to hang conflicts off. */
async function appointment(s: Shop, minuteOffset: number, status = "COMPLETED") {
  const startsAt = new Date(Date.UTC(2026, 9, 5, 10, minuteOffset, 0));
  return prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      firstName: "Walk-in",
      status: status as "COMPLETED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

let seq = 0;
/** One conflict row, written straight in - the writer is the P0's, not ours. */
async function conflict(
  s: Shop,
  over: Partial<{
    receiptId: string;
    conflictingId: string;
    conflictingKind: string;
    detectedAt: Date;
    resolvedAt: Date | null;
  }> = {},
) {
  seq += 1;
  return prisma.bookingConflict.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      receiptId: over.receiptId ?? `receipt-${seq}`,
      conflictingId: over.conflictingId ?? `other-${seq}`,
      conflictingKind: over.conflictingKind ?? "appointment",
      overlapStart: new Date(Date.UTC(2026, 9, 5, 10, 0, 0)),
      overlapEnd: new Date(Date.UTC(2026, 9, 5, 10, 30, 0)),
      source: "walk_in_quick_log",
      ...(over.detectedAt ? { detectedAt: over.detectedAt } : {}),
      ...(over.resolvedAt !== undefined ? { resolvedAt: over.resolvedAt } : {}),
    },
    select: { id: true },
  });
}

const list = (s: Shop, q = "") =>
  request(app).get(`/api/booking-conflicts${q}`).set("Cookie", s.cookie);
const resolve = (s: Shop, id: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/booking-conflicts/${id}/resolve`).set("Cookie", s.cookie).send(body);
const resolveAll = (s: Shop, body: Record<string, unknown>) =>
  request(app).post("/api/booking-conflicts/resolve-all").set("Cookie", s.cookie).send(body);

beforeAll(async () => {
  A = await makeShop("Inbox A");
  B = await makeShop("Inbox B");
});

beforeEach(async () => {
  await prisma.bookingConflict.deleteMany({ where: { shopId: { in: [A.shopId, B.shopId] } } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [A.shopId, B.shopId] } } });
});

describe("1. shop isolation", () => {
  it("🔴 never shows another shop's conflicts", async () => {
    await conflict(A);
    await conflict(B);
    await conflict(B);

    const a = await list(A);
    expect(a.status).toBe(200);
    expect(a.body.items).toHaveLength(1);
    expect(a.body.unresolvedCount).toBe(1);

    const b = await list(B);
    expect(b.body.items).toHaveLength(2);
    expect(b.body.unresolvedCount).toBe(2);
  });

  it("🔴 cannot resolve another shop's conflict - 404, not 403", async () => {
    const theirs = await conflict(B);
    // 404 so the answer does not confirm the row exists somewhere else.
    expect((await resolve(A, theirs.id)).status).toBe(404);
    const after = await prisma.bookingConflict.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(after.resolvedAt).toBeNull();
  });
});

describe("2. manager authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await request(app).get("/api/booking-conflicts")).status).toBe(401);
  });

  it("🔴 a BARBER seat is refused (403 forbidden_role), list and resolve", async () => {
    const barberEmail = `cinbox-barber-${randomToken(6)}@test.local`.toLowerCase();
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: barberEmail, password, name: "Barber", smsAttested: true });
    const barberUserId = signup.body.id as string;
    const barberCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    await prisma.shopMember.create({
      data: { shopId: A.shopId, userId: barberUserId, role: "BARBER" },
    });

    const row = await conflict(A);
    const listed = await request(app).get("/api/booking-conflicts").set("Cookie", barberCookie);
    expect(listed.status).toBe(403);
    expect(listed.body.error).toBe("forbidden_role");

    const tried = await request(app)
      .post(`/api/booking-conflicts/${row.id}/resolve`)
      .set("Cookie", barberCookie)
      .send({});
    expect(tried.status).toBe(403);
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: row.id } })).resolvedAt,
    ).toBeNull();

    await prisma.shopMember.deleteMany({ where: { shopId: A.shopId, userId: barberUserId } });
  });

  it("a MANAGER seat is allowed", async () => {
    const mEmail = `cinbox-mgr-${randomToken(6)}@test.local`.toLowerCase();
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: mEmail, password, name: "Mgr", smsAttested: true });
    const uid = signup.body.id as string;
    const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    await prisma.shopMember.create({ data: { shopId: A.shopId, userId: uid, role: "MANAGER" } });
    await conflict(A);
    const r = await request(app).get("/api/booking-conflicts").set("Cookie", c);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    await prisma.shopMember.deleteMany({ where: { shopId: A.shopId, userId: uid } });
  });
});

describe("3. ordering and pagination", () => {
  it("newest first, and pages without skipping or repeating", async () => {
    const base = Date.UTC(2026, 9, 5, 12, 0, 0);
    for (let i = 0; i < 5; i++) {
      await conflict(A, { detectedAt: new Date(base + i * 60_000) });
    }
    const p1 = await list(A, "?limit=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    // Newest first.
    expect(new Date(p1.body.items[0].detectedAt).getTime()).toBeGreaterThan(
      new Date(p1.body.items[1].detectedAt).getTime(),
    );

    const c1 = encodeURIComponent(JSON.stringify(p1.body.nextCursor));
    const p2 = await list(A, `?limit=2&cursor=${c1}`);
    expect(p2.body.items).toHaveLength(2);
    const c2 = encodeURIComponent(JSON.stringify(p2.body.nextCursor));
    const p3 = await list(A, `?limit=2&cursor=${c2}`);
    expect(p3.body.items).toHaveLength(1);
    // Last page: no cursor, so the client knows to stop.
    expect(p3.body.nextCursor).toBeNull();

    const seen = [...p1.body.items, ...p2.body.items, ...p3.body.items].map(
      (i: { id: string }) => i.id,
    );
    expect(new Set(seen).size).toBe(5);
  });

  it("🔴 rows sharing a detectedAt still page correctly (the id tiebreak)", async () => {
    // One walk-in can record several conflicts in the same instant; without the
    // id tiebreak a cursor on the timestamp alone loses or repeats them.
    const same = new Date(Date.UTC(2026, 9, 5, 13, 0, 0));
    for (let i = 0; i < 4; i++) await conflict(A, { detectedAt: same });
    const p1 = await list(A, "?limit=2");
    const c1 = encodeURIComponent(JSON.stringify(p1.body.nextCursor));
    const p2 = await list(A, `?limit=2&cursor=${c1}`);
    const ids = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("caps the page size whatever is asked for", async () => {
    expect((await list(A, "?limit=999")).status).toBe(400);
  });
});

describe("4. the unresolved count", () => {
  it("counts only open ones", async () => {
    await conflict(A);
    await conflict(A);
    await conflict(A, { resolvedAt: new Date() });
    expect((await list(A)).body.unresolvedCount).toBe(2);
  });

  it("🔴 stays the OPEN count even when listing resolved ones", async () => {
    // It drives a "you have N to deal with" badge; it must not drop to 0
    // because somebody switched the filter.
    await conflict(A);
    await conflict(A, { resolvedAt: new Date() });
    const resolved = await list(A, "?status=resolved");
    expect(resolved.body.items).toHaveLength(1);
    expect(resolved.body.unresolvedCount).toBe(1);
    expect((await list(A, "?status=all")).body.items).toHaveLength(2);
  });

  it("defaults to the open list", async () => {
    await conflict(A);
    await conflict(A, { resolvedAt: new Date() });
    expect((await list(A)).body.items).toHaveLength(1);
  });
});

describe("5. every conflict kind renders", () => {
  it("appointment, visit and block all come back with their kind", async () => {
    await conflict(A, { conflictingKind: "appointment" });
    await conflict(A, { conflictingKind: "visit" });
    await conflict(A, { conflictingKind: "block" });
    const kinds = (await list(A)).body.items.map((i: { kind: string }) => i.kind).sort();
    expect(kinds).toEqual(["appointment", "block", "visit"]);
  });
});

describe("6. context, and records that are gone", () => {
  it("links the real appointment when it still exists", async () => {
    const receipt = await appointment(A, 0);
    const other = await appointment(A, 10, "BOOKED");
    await conflict(A, { receiptId: receipt.id, conflictingId: other.id });
    const item = (await list(A)).body.items[0];
    expect(item.receipt.exists).toBe(true);
    expect(item.receipt.id).toBe(receipt.id);
    expect(item.conflicting.exists).toBe(true);
    expect(item.conflicting.status).toBe("BOOKED");
    expect(item.conflicting.startsAt).toBeTruthy();
  });

  it("🔴 a DELETED referenced record still renders, marked gone", async () => {
    const receipt = await appointment(A, 20);
    await conflict(A, { receiptId: receipt.id, conflictingId: "vanished-id" });
    await prisma.appointment.delete({ where: { id: receipt.id } });

    const res = await list(A);
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    // The conflict outlives both bookings on purpose - it is the record that
    // the chair WAS double-booked. A missing reference is a rendering state,
    // never a 500.
    expect(item.receipt.exists).toBe(false);
    expect(item.receipt.startsAt).toBeNull();
    expect(item.conflicting.exists).toBe(false);
  });

  it("🔴 exposes NO customer information", async () => {
    const receipt = await prisma.appointment.create({
      data: {
        shopId: A.shopId,
        staffId: A.staffId,
        serviceId: A.serviceId,
        firstName: "Marcus",
        lastName: "Delgado",
        phone: "+18455551212",
        email: "marcus@example.com",
        status: "COMPLETED",
        startsAt: new Date(Date.UTC(2026, 9, 5, 14, 0, 0)),
        endsAt: new Date(Date.UTC(2026, 9, 5, 14, 30, 0)),
        priceAtBooking: "40",
        paidAmount: "40",
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    await conflict(A, { receiptId: receipt.id });
    const body = JSON.stringify((await list(A)).body);
    for (const leak of ["Marcus", "Delgado", "8455551212", "marcus@example.com"]) {
      expect(body).not.toContain(leak);
    }
    // The chair's name IS included - that is an employee, and the manager needs
    // to know whose chair it was.
    expect(body).toContain("Inbox A Chair");
  });
});

describe("7. resolving", () => {
  it("records who, when and what they wrote", async () => {
    const row = await conflict(A);
    const res = await resolve(A, row.id, { note: "Called the client, moved to 3pm" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);

    const after = await prisma.bookingConflict.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolvedByUserId).toBe(A.ownerId);
    expect(after.resolutionNote).toBe("Called the client, moved to 3pm");

    const item = (await list(A, "?status=resolved")).body.items[0];
    expect(item.resolvedByName).toBe("Inbox A");
    expect(item.resolutionNote).toBe("Called the client, moved to 3pm");
  });

  it("a note is optional", async () => {
    const row = await conflict(A);
    expect((await resolve(A, row.id)).status).toBe(200);
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: row.id } })).resolutionNote,
    ).toBeNull();
  });

  it("refuses an over-long note rather than truncating it", async () => {
    const row = await conflict(A);
    expect((await resolve(A, row.id, { note: "x".repeat(281) })).status).toBe(400);
  });

  it("404s an id that does not exist", async () => {
    expect((await resolve(A, "no-such-conflict")).status).toBe(404);
  });

  it("🔴 REPEATED resolution keeps the FIRST resolver and note", async () => {
    const row = await conflict(A);
    const first = await resolve(A, row.id, { note: "first" });
    expect(first.body.changed).toBe(true);
    const at = (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: row.id } }))
      .resolvedAt!;

    const second = await resolve(A, row.id, { note: "second" });
    expect(second.status).toBe(200);
    // Still 200 - the work IS done - but it says it changed nothing, so the UI
    // can tell the truth instead of claiming this click resolved it.
    expect(second.body.changed).toBe(false);

    const after = await prisma.bookingConflict.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.resolutionNote).toBe("first");
    expect(after.resolvedAt!.toISOString()).toBe(at.toISOString());
  });

  it("🔴 CONCURRENT resolution: one winner, one audit trail", async () => {
    const row = await conflict(A);
    // A real interleaving, not Promise.all: two managers working the list, or
    // one double-tap on a slow connection.
    //
    // 🔴 THE BARRIER IS A ROW LOCK, not an advisory one, because the guard here
    // IS the row: `updateMany ... WHERE resolvedAt IS NULL` is a compare-and-set
    // that only a genuine interleaving exercises. An advisory-key barrier would
    // report settledEarly = 2 and prove nothing, because this route takes no
    // advisory lock - which is exactly what the first version of this test did.
    const { results, settledEarly } = await raceBehindRowLock("BookingConflict", row.id, [
      () => resolve(A, row.id, { note: "racer-one" }),
      () => resolve(A, row.id, { note: "racer-two" }),
    ]);
    expect(settledEarly).toBe(0);
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<request.Response> =>
        r.status === "fulfilled" && r.value.status === 200,
    );
    expect(ok).toHaveLength(2);
    // Exactly one of them actually did it.
    expect(ok.filter((r) => r.value.body.changed === true)).toHaveLength(1);

    const after = await prisma.bookingConflict.findUniqueOrThrow({ where: { id: row.id } });
    expect(["racer-one", "racer-two"]).toContain(after.resolutionNote);
  });
});

describe("8. no destructive side effects", () => {
  it("🔴 resolving changes NO booking and deletes NOTHING", async () => {
    const receipt = await appointment(A, 40);
    const other = await appointment(A, 45, "BOOKED");
    const row = await conflict(A, { receiptId: receipt.id, conflictingId: other.id });

    const before = await prisma.appointment.findMany({
      where: { id: { in: [receipt.id, other.id] } },
      orderBy: { id: "asc" },
    });
    const conflictsBefore = await prisma.bookingConflict.count({ where: { shopId: A.shopId } });

    expect((await resolve(A, row.id, { note: "spoke to both" })).status).toBe(200);

    const after = await prisma.appointment.findMany({
      where: { id: { in: [receipt.id, other.id] } },
      orderBy: { id: "asc" },
    });
    // Byte-for-byte the same bookings: same status, same times, same money.
    expect(after).toEqual(before);
    // And the conflict row is still there - resolved, never deleted.
    expect(await prisma.bookingConflict.count({ where: { shopId: A.shopId } })).toBe(
      conflictsBefore,
    );
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: row.id } })).resolvedAt,
    ).not.toBeNull();
  });

  it("🔴 resolving sends NOTHING and moves NO availability", async () => {
    const receipt = await appointment(A, 50);
    const other = await appointment(A, 55, "BOOKED");
    const row = await conflict(A, { receiptId: receipt.id, conflictingId: other.id });

    // Availability is a per-shop GENERATION counter; every write that could
    // change what the booking page offers bumps it. Resolving is bookkeeping,
    // so the counter must not move - if it did, every replica would throw away
    // a warm availability cache because somebody ticked off a to-do.
    const genBefore = (
      await prisma.shop.findUniqueOrThrow({
        where: { id: A.shopId },
        select: { availabilityGeneration: true },
      })
    ).availabilityGeneration;
    const outboxBefore = await prisma.emailIntent.count({ where: { shopId: A.shopId } });
    const paymentsBefore = await prisma.payment.count({ where: { shopId: A.shopId } });

    expect((await resolve(A, row.id, { note: "rang them" })).status).toBe(200);

    const genAfter = (
      await prisma.shop.findUniqueOrThrow({
        where: { id: A.shopId },
        select: { availabilityGeneration: true },
      })
    ).availabilityGeneration;
    expect(genAfter).toBe(genBefore);
    // 🔴 And no customer hears about it. A conflict is the shop's problem to
    // sort out by ringing whoever is affected - ChairBack must never decide to
    // message a customer about a double-booking on the shop's behalf.
    expect(await prisma.emailIntent.count({ where: { shopId: A.shopId } })).toBe(outboxBefore);
    // No money moved either way.
    expect(await prisma.payment.count({ where: { shopId: A.shopId } })).toBe(paymentsBefore);
  });

  it("a resolved conflict stays readable forever", async () => {
    const row = await conflict(A);
    await resolve(A, row.id, { note: "handled" });
    const item = (await list(A, "?status=all")).body.items.find(
      (i: { id: string }) => i.id === row.id,
    );
    expect(item).toBeTruthy();
    expect(item.resolvedAt).toBeTruthy();
  });
});

/**
 * RESOLVE ALL - asked for after a shop worked sixteen conflicts one tap and
 * one confirmation at a time. It is the single resolve's rules applied to the
 * batch, plus the two that only a batch needs: it never reaches past what the
 * manager was SHOWN, in time or in number.
 */
describe("9. resolve all", () => {
  /** The list as the manager saw it: its count and its asOf. */
  async function shown(s: Shop) {
    const r = await list(s);
    expect(r.status).toBe(200);
    return { asOf: r.body.asOf as string, expected: r.body.unresolvedCount as number };
  }

  it("the list says when it was read", async () => {
    const before = Date.now();
    const r = await list(A);
    const asOf = new Date(r.body.asOf).getTime();
    expect(asOf).toBeGreaterThanOrEqual(before - 1000);
    expect(asOf).toBeLessThanOrEqual(Date.now());
  });

  it("resolves every open one, recording who, when and the note", async () => {
    const rows = [await conflict(A), await conflict(A), await conflict(A)];
    const res = await resolveAll(A, { ...(await shown(A)), note: "Rang everyone" });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(3);

    for (const r of rows) {
      const after = await prisma.bookingConflict.findUniqueOrThrow({ where: { id: r.id } });
      expect(after.resolvedAt).not.toBeNull();
      expect(after.resolvedByUserId).toBe(A.ownerId);
      expect(after.resolutionNote).toBe("Rang everyone");
    }
    expect((await list(A)).body.unresolvedCount).toBe(0);
  });

  it("🔴 a conflict a teammate ALREADY resolved keeps their name and note", async () => {
    const theirs = await conflict(A);
    await resolve(A, theirs.id, { note: "teammate's call" });
    const theirsBefore = await prisma.bookingConflict.findUniqueOrThrow({
      where: { id: theirs.id },
    });
    const open = await conflict(A);

    const res = await resolveAll(A, { ...(await shown(A)), note: "bulk" });
    expect(res.body.resolved).toBe(1);

    expect(await prisma.bookingConflict.findUniqueOrThrow({ where: { id: theirs.id } })).toEqual(
      theirsBefore,
    );
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: open.id } })).resolutionNote,
    ).toBe("bulk");
  });

  it("🔴 a conflict that arrives AFTER the list was read stays open", async () => {
    const seen = await conflict(A);
    const view = await shown(A);
    // Recorded while the confirmation was on screen.
    const late = await conflict(A, { detectedAt: new Date(Date.now() + 5_000) });

    const res = await resolveAll(A, view);
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(1);
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: seen.id } })).resolvedAt,
    ).not.toBeNull();
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: late.id } })).resolvedAt,
    ).toBeNull();
  });

  it("🔴 an asOf in the FUTURE is held to now - it cannot widen the sweep", async () => {
    const now = await conflict(A);
    const future = await conflict(A, { detectedAt: new Date(Date.now() + 60 * 60_000) });
    const res = await resolveAll(A, {
      asOf: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      expected: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(1);
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: now.id } })).resolvedAt,
    ).not.toBeNull();
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: future.id } })).resolvedAt,
    ).toBeNull();
  });

  it("🔴 MORE than was shown is refused, and NOTHING is written", async () => {
    // Three are open at asOf, but the manager confirmed two - the third is the
    // one whose transaction committed after the list was read.
    const rows = [await conflict(A), await conflict(A), await conflict(A)];
    const { asOf } = await shown(A);

    const res = await resolveAll(A, { asOf, expected: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflicts_changed");
    // Rolled back: not two of three, none of them.
    for (const r of rows) {
      expect(
        (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: r.id } })).resolvedAt,
      ).toBeNull();
    }
  });

  it("FEWER than shown is fine - a teammate got to some first", async () => {
    const a = await conflict(A);
    const b = await conflict(A);
    const view = await shown(A);
    await resolve(A, a.id, { note: "teammate" });

    const res = await resolveAll(A, view);
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(1);
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: b.id } })).resolvedAt,
    ).not.toBeNull();
  });

  it("🔴 never touches another shop's conflicts", async () => {
    await conflict(A);
    const theirs = await conflict(B);
    const res = await resolveAll(A, { ...(await shown(A)), expected: 5 });
    expect(res.body.resolved).toBe(1);
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: theirs.id } })).resolvedAt,
    ).toBeNull();
  });

  it("🔴 a BARBER seat is refused, and nothing changes", async () => {
    const barberEmail = `cinbox-barber-all-${randomToken(6)}@test.local`.toLowerCase();
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: barberEmail, password, name: "Barber", smsAttested: true });
    const barberUserId = signup.body.id as string;
    const barberCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    await prisma.shopMember.create({
      data: { shopId: A.shopId, userId: barberUserId, role: "BARBER" },
    });
    const row = await conflict(A);

    const tried = await request(app)
      .post("/api/booking-conflicts/resolve-all")
      .set("Cookie", barberCookie)
      .send({ asOf: new Date().toISOString(), expected: 1 });
    expect(tried.status).toBe(403);
    expect(
      (await prisma.bookingConflict.findUniqueOrThrow({ where: { id: row.id } })).resolvedAt,
    ).toBeNull();

    await prisma.shopMember.deleteMany({ where: { shopId: A.shopId, userId: barberUserId } });
  });

  it("refuses a request without the list's asOf and count", async () => {
    await conflict(A);
    expect((await resolveAll(A, {})).status).toBe(400);
    expect((await resolveAll(A, { asOf: new Date().toISOString() })).status).toBe(400);
    expect((await resolveAll(A, { asOf: "yesterday", expected: 1 })).status).toBe(400);
    expect((await resolveAll(A, { asOf: new Date().toISOString(), expected: 0 })).status).toBe(
      400,
    );
    expect(
      (await resolveAll(A, { ...(await shown(A)), note: "x".repeat(281) })).status,
    ).toBe(400);
    expect((await list(A)).body.unresolvedCount).toBe(1);
  });

  it("🔴 changes NO booking, deletes NOTHING, sends NOTHING, moves NO availability", async () => {
    const receipt = await appointment(A, 0);
    const other = await appointment(A, 5, "BOOKED");
    await conflict(A, { receiptId: receipt.id, conflictingId: other.id });
    await conflict(A, { receiptId: receipt.id, conflictingId: "a-block", conflictingKind: "block" });

    const bookingsBefore = await prisma.appointment.findMany({
      where: { id: { in: [receipt.id, other.id] } },
      orderBy: { id: "asc" },
    });
    const conflictsBefore = await prisma.bookingConflict.count({ where: { shopId: A.shopId } });
    const genBefore = (
      await prisma.shop.findUniqueOrThrow({
        where: { id: A.shopId },
        select: { availabilityGeneration: true },
      })
    ).availabilityGeneration;
    const outboxBefore = await prisma.emailIntent.count({ where: { shopId: A.shopId } });
    const paymentsBefore = await prisma.payment.count({ where: { shopId: A.shopId } });

    expect((await resolveAll(A, await shown(A))).body.resolved).toBe(2);

    expect(
      await prisma.appointment.findMany({
        where: { id: { in: [receipt.id, other.id] } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(bookingsBefore);
    expect(await prisma.bookingConflict.count({ where: { shopId: A.shopId } })).toBe(
      conflictsBefore,
    );
    expect(
      (
        await prisma.shop.findUniqueOrThrow({
          where: { id: A.shopId },
          select: { availabilityGeneration: true },
        })
      ).availabilityGeneration,
    ).toBe(genBefore);
    expect(await prisma.emailIntent.count({ where: { shopId: A.shopId } })).toBe(outboxBefore);
    expect(await prisma.payment.count({ where: { shopId: A.shopId } })).toBe(paymentsBefore);
  });
});
