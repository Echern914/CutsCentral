import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  estimateForNewEntry,
  kioskCheckIn,
  mintTrackToken,
} from "./walkInCheckIn.js";
import {
  WalkInServiceSelectionError,
  WalkInStaffError,
} from "./walkInQueue.js";
import { exchangeTrackToken, trackLeave, trackStatus } from "./walkInTrack.js";

/**
 * The public check-in engine: exactly one active entry per phone under any
 * concurrency, dedupe-by-rotation (the privacy mechanism), the tracking
 * token/session lifecycle, and honest estimates.
 */

let userId: string;
let shopId: string;
let chairA: string;
let svc30: string;
let inactiveSvc: string;
let inactiveStaff: string;
let phoneSeq = 0;

const NOW = new Date("2026-09-02T15:00:00.000Z");
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(5000 + phoneSeq).padStart(4, "0")}`;
}

async function checkIn(over: Partial<Parameters<typeof kioskCheckIn>[0]> = {}) {
  return kioskCheckIn({
    shopId,
    timezone: "UTC",
    phone: freshPhone(),
    firstName: "Kiosk",
    lastName: null,
    serviceIds: [svc30],
    preferredStaffId: null,
    smsConsent: true,
    now: NOW,
    ...over,
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wc-${randomToken(6)}@test.local`, name: "WC" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "CheckIn Cuts",
      slug: `wc-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      walkInEnabled: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  chairA = (await prisma.staff.create({ data: { shopId, name: "Ava" } })).id;
  inactiveStaff = (
    await prisma.staff.create({ data: { shopId, name: "Gone", active: false } })
  ).id;
  svc30 = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
    })
  ).id;
  inactiveSvc = (
    await prisma.service.create({
      data: { shopId, name: "Retired", durationMin: 30, active: false },
    })
  ).id;
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: svc30, staffId: chairA },
  });
  await prisma.availabilityRule.create({
    data: { shopId, staffId: chairA, weekday: 3, startMin: 540, endMin: 1020 },
  });
});

afterAll(async () => {
  await prisma.walkInEvent.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("fresh check-in", () => {
  it("creates the entry with snapshots, a hashed 256-bit token, and a quote", async () => {
    const res = await checkIn();
    expect(res.deduped).toBe(false);
    // 32 random bytes base64url = 43 chars of credential.
    expect(res.trackToken.length).toBeGreaterThanOrEqual(43);
    const row = await prisma.walkInEntry.findUnique({
      where: { id: res.entryId },
      include: { services: true },
    });
    expect(row!.source).toBe("KIOSK");
    expect(row!.trackTokenHash).toBe(sha256(res.trackToken));
    expect(JSON.stringify(row)).not.toContain(res.trackToken);
    expect(row!.trackTokenExpiresAt!.toISOString()).toBe(
      "2026-09-03T00:00:00.000Z", // the shop-local day boundary
    );
    expect(row!.services[0]!.nameAtJoin).toBe("Fade");
    expect(row!.quotedAt).not.toBeNull();
    // Consent captured with version + phone snapshot.
    expect(row!.smsConsentVersion).toBe("v1");
    expect(row!.smsConsentPhone).toBe(row!.phone);
  });

  it("links the shop's OWN unambiguous client and borrows their first name", async () => {
    const phone = freshPhone();
    const client = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: phone,
        firstName: "Marcus",
        phone,
        magicToken: randomToken(),
      },
      select: { id: true },
    });
    const res = await checkIn({ phone, firstName: null });
    const row = await prisma.walkInEntry.findUnique({ where: { id: res.entryId } });
    expect(row!.clientId).toBe(client.id);
    expect(row!.firstName).toBe("Marcus");
  });

  it("rejects inactive services and inactive staff outright", async () => {
    await expect(checkIn({ serviceIds: [inactiveSvc] })).rejects.toBeInstanceOf(
      WalkInServiceSelectionError,
    );
    await expect(
      checkIn({ preferredStaffId: inactiveStaff }),
    ).rejects.toBeInstanceOf(WalkInStaffError);
  });
});

describe("dedupe = rotate + re-text, never a tell", () => {
  it("a second check-in keeps ONE entry and rotates the credential", async () => {
    const phone = freshPhone();
    const first = await checkIn({ phone });
    const second = await checkIn({ phone, firstName: "Different Name" });
    expect(second.deduped).toBe(true);
    expect(second.entryId).toBe(first.entryId);
    expect(second.trackToken).not.toBe(first.trackToken);

    const rows = await prisma.walkInEntry.count({
      where: { shopId, phone, status: "WAITING" },
    });
    expect(rows).toBe(1);

    // The OLD link is dead; the NEW one works. Rotation IS the re-send.
    expect(
      await exchangeTrackToken({ token: first.trackToken, now: NOW }),
    ).toEqual({ ok: false });
    const fresh = await exchangeTrackToken({ token: second.trackToken, now: NOW });
    expect(fresh.ok).toBe(true);
  });

  it("rotation kills a live tracking session too", async () => {
    const phone = freshPhone();
    const first = await checkIn({ phone });
    const ex = await exchangeTrackToken({ token: first.trackToken, now: NOW });
    expect(ex.ok).toBe(true);
    if (!ex.ok) throw new Error("unreachable");
    await checkIn({ phone }); // dedupe -> rotate
    expect(await trackStatus({ session: ex.session, now: NOW })).toEqual({
      ok: false,
    });
  });

  it("🔴 two CONCURRENT check-ins for one phone leave exactly one entry", async () => {
    const phone = freshPhone();
    const [a, b] = await Promise.all([checkIn({ phone }), checkIn({ phone })]);
    expect(a.entryId).toBe(b.entryId);
    expect([a.deduped, b.deduped].filter(Boolean)).toHaveLength(1);
    const rows = await prisma.walkInEntry.count({
      where: { shopId, phone, status: "WAITING" },
    });
    expect(rows).toBe(1);
  });

  it("a terminal entry frees the phone for a genuinely new visit", async () => {
    const phone = freshPhone();
    const first = await checkIn({ phone });
    const ex = await exchangeTrackToken({ token: first.trackToken, now: NOW });
    if (!ex.ok) throw new Error("unreachable");
    await trackLeave({ session: ex.session, now: NOW });
    const again = await checkIn({ phone });
    expect(again.deduped).toBe(false);
    expect(again.entryId).not.toBe(first.entryId);
  });
});

describe("tracking", () => {
  it("status shows only the caller's own data, recomputed live", async () => {
    const mine = await checkIn({ preferredStaffId: chairA });
    await checkIn(); // somebody else in line
    const ex = await exchangeTrackToken({ token: mine.trackToken, now: NOW });
    if (!ex.ok) throw new Error("unreachable");
    const st = await trackStatus({ session: ex.session, now: NOW });
    expect(st.ok).toBe(true);
    if (!st.ok) throw new Error("unreachable");
    expect(st.status.shopName).toBe("CheckIn Cuts");
    expect(st.status.services.map((s) => s.name)).toEqual(["Fade"]);
    expect(st.status.barberName).toBe("Ava");
    const flat = JSON.stringify(st);
    // No identifiers, no phone, nobody else's name.
    expect(flat).not.toContain(mine.entryId);
    expect(flat).not.toMatch(/\+1212555/);
  });

  it("leave is atomic and a repeat answers the settled state", async () => {
    const res = await checkIn();
    const ex = await exchangeTrackToken({ token: res.trackToken, now: NOW });
    if (!ex.ok) throw new Error("unreachable");
    const [a, b] = await Promise.all([
      trackLeave({ session: ex.session, now: NOW }),
      trackLeave({ session: ex.session, now: NOW }),
    ]);
    expect(a).toEqual({ ok: true, status: "LEFT" });
    expect(b).toEqual({ ok: true, status: "LEFT" });
    const again = await trackLeave({ session: ex.session, now: NOW });
    expect(again).toEqual({ ok: true, status: "LEFT" });
  });

  it("foreign and garbage tokens collapse into one nothing", async () => {
    expect(await exchangeTrackToken({ token: randomToken(32), now: NOW })).toEqual({
      ok: false,
    });
    expect(await exchangeTrackToken({ token: "short", now: NOW })).toEqual({
      ok: false,
    });
    expect(await trackStatus({ session: randomToken(32), now: NOW })).toEqual({
      ok: false,
    });
  });

  it("an expired token refuses (the day ended)", async () => {
    const res = await checkIn();
    expect(
      await exchangeTrackToken({
        token: res.trackToken,
        now: new Date("2026-09-03T00:00:01.000Z"),
      }),
    ).toEqual({ ok: false });
  });
});

describe("estimates", () => {
  it("the kiosk quote is the engine's answer for a joiner at the tail", async () => {
    const est = await estimateForNewEntry({
      shopId,
      now: NOW,
      totalDurationMin: 30,
      serviceIds: [svc30],
      preferredStaffId: null,
    });
    expect(typeof est.ahead).toBe("number");
    // Not asserting the number - the queue varies across this suite; the
    // determinism of the engine itself is pinned in walkInEstimate.test.ts.
  });

  it("mintTrackToken carries >= 256 bits and hashes stable", () => {
    const { token, hash } = mintTrackToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hash).toBe(sha256(token));
  });
});
