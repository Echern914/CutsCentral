import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * DELETING A RESOLVED CONFLICT (a barber, 2026-09-29: "all resolved
 * appointments should be able to be deleted").
 *
 * What it must do: take a conflict somebody already dealt with off the list.
 * What it must NOT do -
 *   * delete an OPEN one (two people may still turn up for one chair);
 *   * touch either booking;
 *   * erase the record (it is the audit trail, and its unique key is what
 *     stops the same collision being recorded twice);
 *   * reach another shop's conflicts;
 *   * in bulk, reach more than the manager was shown.
 */
const app = createApp();
const password = "supersecret123";

interface Shop {
  cookie: string;
  shopId: string;
  staffId: string;
  serviceId: string;
}
let A: Shop;
let B: Shop;

async function makeShop(label: string): Promise<Shop> {
  const email = `cdel-${randomToken(6)}@test.local`.toLowerCase();
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
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: `${label} Chair` });
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staff.body.id] });
  return { cookie, shopId: shop.body.id, staffId: staff.body.id, serviceId: svc.body.id };
}

async function appointment(s: Shop, minuteOffset: number) {
  const startsAt = new Date(Date.UTC(2026, 9, 5, 10, minuteOffset, 0));
  return prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      firstName: "Walk-in",
      status: "COMPLETED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true, status: true, startsAt: true, endsAt: true },
  });
}

let seq = 0;
async function conflict(
  s: Shop,
  over: Partial<{ receiptId: string; conflictingId: string; resolvedAt: Date | null }> = {},
) {
  seq += 1;
  return prisma.bookingConflict.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      receiptId: over.receiptId ?? `receipt-del-${seq}`,
      conflictingId: over.conflictingId ?? `other-del-${seq}`,
      conflictingKind: "appointment",
      overlapStart: new Date(Date.UTC(2026, 9, 5, 10, 0, 0)),
      overlapEnd: new Date(Date.UTC(2026, 9, 5, 10, 30, 0)),
      source: "walk_in_quick_log",
      ...(over.resolvedAt !== undefined ? { resolvedAt: over.resolvedAt } : {}),
    },
    select: { id: true },
  });
}

const RESOLVED = new Date(Date.UTC(2026, 8, 20, 12, 0, 0));
const list = (s: Shop, q = "") => request(app).get(`/api/booking-conflicts${q}`).set("Cookie", s.cookie);
const del = (s: Shop, id: string) =>
  request(app).post(`/api/booking-conflicts/${id}/delete`).set("Cookie", s.cookie).send({});
const delAll = (s: Shop, body: Record<string, unknown>) =>
  request(app).post("/api/booking-conflicts/delete-resolved").set("Cookie", s.cookie).send(body);
const ids = (res: request.Response) => (res.body.items as { id: string }[]).map((r) => r.id);

beforeAll(async () => {
  A = await makeShop("Delete A");
  B = await makeShop("Delete B");
});

beforeEach(async () => {
  const shops = [A?.shopId, B?.shopId].filter(Boolean) as string[];
  await prisma.bookingConflict.deleteMany({ where: { shopId: { in: shops } } });
});

afterAll(async () => {
  const shops = [A?.shopId, B?.shopId].filter(Boolean) as string[];
  await prisma.shop.deleteMany({ where: { id: { in: shops } } });
});

describe("deleting one resolved conflict", () => {
  it("🔴 takes it off every list, keeps the record, and changes neither booking", async () => {
    const receipt = await appointment(A, 0);
    const other = await appointment(A, 10);
    const c = await conflict(A, { receiptId: receipt.id, conflictingId: other.id, resolvedAt: RESOLVED });

    const res = await del(A, c.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, changed: true });

    for (const q of ["?status=resolved", "?status=all", ""]) {
      expect(ids(await list(A, q))).not.toContain(c.id);
    }
    const row = await prisma.bookingConflict.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.resolvedAt).toEqual(RESOLVED);

    for (const before of [receipt, other]) {
      const after = await prisma.appointment.findUniqueOrThrow({
        where: { id: before.id },
        select: { id: true, status: true, startsAt: true, endsAt: true },
      });
      expect(after).toEqual(before);
    }
  });

  it("🔴 an OPEN conflict is refused and stays listed", async () => {
    const c = await conflict(A);
    const res = await del(A, c.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("still_open");
    expect((await prisma.bookingConflict.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).toBeNull();
    expect(ids(await list(A))).toContain(c.id);
  });

  it("🔴 the table refuses it too, for any writer that isn't the route", async () => {
    const c = await conflict(A);
    await expect(
      prisma.bookingConflict.update({ where: { id: c.id }, data: { deletedAt: new Date() } }),
    ).rejects.toThrow();
  });

  it("🔴 another shop's conflict is a 404 and is not touched", async () => {
    const c = await conflict(B, { resolvedAt: RESOLVED });
    const res = await del(A, c.id);
    expect(res.status).toBe(404);
    expect((await prisma.bookingConflict.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).toBeNull();
  });

  it("deleting it twice is fine, and says the second did nothing", async () => {
    const c = await conflict(A, { resolvedAt: RESOLVED });
    expect((await del(A, c.id)).body.changed).toBe(true);
    const again = await del(A, c.id);
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
  });

  it("🔴 the same collision can't come back as new: the kept row still holds its key", async () => {
    const c = await conflict(A, { receiptId: "r-same", conflictingId: "o-same", resolvedAt: RESOLVED });
    await del(A, c.id);
    // The writer records conflicts with skipDuplicates (engines/bookingConflict.ts).
    const { count } = await prisma.bookingConflict.createMany({
      data: [
        {
          shopId: A.shopId,
          staffId: A.staffId,
          receiptId: "r-same",
          conflictingId: "o-same",
          conflictingKind: "appointment",
          overlapStart: new Date(Date.UTC(2026, 9, 5, 10, 0, 0)),
          overlapEnd: new Date(Date.UTC(2026, 9, 5, 10, 30, 0)),
          source: "walk_in_quick_log",
        },
      ],
      skipDuplicates: true,
    });
    expect(count).toBe(0);
    expect(ids(await list(A, "?status=all"))).not.toContain(c.id);
  });
});

describe("deleting every resolved conflict", () => {
  it("🔴 takes the resolved ones and never an open one", async () => {
    const r1 = await conflict(A, { resolvedAt: RESOLVED });
    const r2 = await conflict(A, { resolvedAt: RESOLVED });
    const open = await conflict(A);
    const page = await list(A, "?status=resolved");
    expect(page.body.resolvedCount).toBe(2);

    const res = await delAll(A, { asOf: page.body.asOf, expected: 2 });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const after = await list(A, "?status=all");
    expect(ids(after)).toEqual([open.id]);
    expect(after.body.resolvedCount).toBe(0);
    expect(after.body.unresolvedCount).toBe(1);
    for (const id of [r1.id, r2.id]) {
      expect((await prisma.bookingConflict.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
    }
  });

  it("🔴 more resolved than the manager was shown: nothing is deleted", async () => {
    await conflict(A, { resolvedAt: RESOLVED });
    await conflict(A, { resolvedAt: RESOLVED });
    const res = await delAll(A, { asOf: new Date().toISOString(), expected: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflicts_changed");
    expect((await list(A, "?status=resolved")).body.resolvedCount).toBe(2);
  });

  it("one resolved AFTER the list was read stays", async () => {
    await conflict(A, { resolvedAt: RESOLVED });
    const page = await list(A, "?status=resolved");
    const late = await conflict(A, { resolvedAt: new Date(Date.now() + 60_000) });
    const res = await delAll(A, { asOf: page.body.asOf, expected: 1 });
    expect(res.body.deleted).toBe(1);
    expect(ids(await list(A, "?status=resolved"))).toEqual([late.id]);
  });

  it("never reaches another shop", async () => {
    const theirs = await conflict(B, { resolvedAt: RESOLVED });
    await conflict(A, { resolvedAt: RESOLVED });
    await delAll(A, { asOf: new Date().toISOString(), expected: 1 });
    expect((await prisma.bookingConflict.findUniqueOrThrow({ where: { id: theirs.id } })).deletedAt).toBeNull();
  });
});
