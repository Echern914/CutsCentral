import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { recordConflicts } from "./bookingConflict.js";

const app = createApp();

/**
 * THE DEDUPLICATION ITSELF, EXERCISED DIRECTLY.
 *
 * The route's retry path never reaches `recordConflicts` a second time — the
 * replay short-circuit and the unique index on `operationId` stop it earlier —
 * so a route-level test can pass whether or not this function deduplicates.
 * Falsification proved that: flipping `skipDuplicates` to false left every
 * idempotency test green.
 *
 * 🔴 IT STILL HAS TO DEDUPLICATE, because the route is not its only caller for
 * long. Re-detection is the normal case for anything that sweeps — a resync, a
 * reconciler, a future conflict scan — and each of those will find the same
 * collision again. One row per (receipt, conflicting record) pair is the
 * contract, and the count it returns is what the manager alert is gated on, so
 * getting this wrong means either a duplicate alert or a crash on a re-sweep.
 */
let shopId: string;
let staffId: string;
let serviceId: string;
let receiptId: string;

const span = { start: new Date("2026-10-01T10:00:00.000Z"), end: new Date("2026-10-01T10:30:00.000Z") };

const conflict = (id: string) => ({
  id,
  kind: "appointment" as const,
  start: span.start,
  end: span.end,
});

beforeAll(async () => {
  // Through the real signup, like every other suite here: Shop and User carry
  // required columns that a hand-built create has to keep chasing.
  const email = `dedupe-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Dedupe", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Dedupe Cuts", bookingUrl: "https://d.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Chair" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] });
  expect(svc.status).toBe(201);
  serviceId = svc.body.id;
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Walk-in",
      status: "COMPLETED",
      startsAt: span.start,
      endsAt: span.end,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  receiptId = appt.id;
});

beforeEach(async () => {
  await prisma.bookingConflict.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

const record = (ids: string[]) =>
  recordConflicts(prisma, {
    shopId,
    staffId,
    receiptId,
    source: "walk_in_quick_log",
    receiptStart: span.start,
    receiptEnd: span.end,
    conflicts: ids.map(conflict),
  });

describe("recordConflicts", () => {
  it("writes one row per collision and says how many are NEW", async () => {
    expect(await record(["a", "b"])).toBe(2);
    expect(await prisma.bookingConflict.count({ where: { shopId } })).toBe(2);
  });

  it("🔴 RE-DETECTION writes nothing and returns 0 — the alert is gated on this", async () => {
    expect(await record(["a"])).toBe(1);
    // A sweep finds the same collision again. It must not throw, must not
    // duplicate, and must report 0 so nobody is alerted a second time.
    expect(await record(["a"])).toBe(0);
    expect(await prisma.bookingConflict.count({ where: { shopId } })).toBe(1);
  });

  it("counts only the genuinely new one in a mixed re-detection", async () => {
    expect(await record(["a"])).toBe(1);
    expect(await record(["a", "b"])).toBe(1);
    expect(await prisma.bookingConflict.count({ where: { shopId } })).toBe(2);
  });

  it("stores the OVERLAP, clipped to both spans", async () => {
    await recordConflicts(prisma, {
      shopId,
      staffId,
      receiptId,
      source: "walk_in_quick_log",
      receiptStart: span.start,
      receiptEnd: span.end,
      conflicts: [
        {
          id: "wide",
          kind: "appointment",
          // Starts earlier and ends later than the receipt.
          start: new Date("2026-10-01T09:00:00.000Z"),
          end: new Date("2026-10-01T12:00:00.000Z"),
        },
      ],
    });
    const row = await prisma.bookingConflict.findFirstOrThrow({ where: { shopId } });
    expect(row.overlapStart.toISOString()).toBe(span.start.toISOString());
    expect(row.overlapEnd.toISOString()).toBe(span.end.toISOString());
  });

  it("records the kind, so a manager knows what to open", async () => {
    await recordConflicts(prisma, {
      shopId,
      staffId,
      receiptId,
      source: "walk_in_quick_log",
      receiptStart: span.start,
      receiptEnd: span.end,
      conflicts: [{ id: "v1", kind: "visit", start: span.start, end: span.end }],
    });
    const row = await prisma.bookingConflict.findFirstOrThrow({ where: { shopId } });
    expect(row.conflictingKind).toBe("visit");
    expect(row.resolvedAt).toBeNull();
  });

  it("does nothing at all when there is no collision", async () => {
    expect(await record([])).toBe(0);
    expect(await prisma.bookingConflict.count({ where: { shopId } })).toBe(0);
  });
});
