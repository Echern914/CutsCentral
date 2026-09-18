import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * MOVING A SYNCED VISIT USED TO DELETE ITS DURATION.
 *
 * `editVisit` wrote `endAt: input.when ?? undefined` — the NEW START into the
 * END. The result is a zero-length span `[t, t)`, which under half-open overlap
 * contains no instant and therefore collides with nothing: the moved visit
 * stops blocking its own time on the availability grid AND in the write guard,
 * while the barber's calendar carries on drawing it.
 *
 * 🔴 SCOPE, STATED HONESTLY. The route refuses a date more than ten minutes
 * ahead (`future_visit`), so this can only ever corrupt a PAST visit. It cannot
 * free a future slot. What it can do is (a) free a chair inside that ten-minute
 * window, while someone is in it, and (b) corrupt the spans every duration
 * reader depends on — utilization, insights, the agenda's own bands. Production
 * carries 6 zero-length COMPLETED visits consistent with it having fired, all
 * historical (docs/booking-integrity-assessment.md), which is why this PR
 * repairs the code and proposes no backfill.
 *
 * 🔴 THE FIX IS NOT "PICK ANOTHER FALLBACK". The authoritative duration is the
 * visit's OWN existing span, which came from Acuity's endTime/duration at
 * ingest. Preserving that delta preserves the truth; a default is only reached
 * when the prior span is itself unusable, and it is logged when it is.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let shopId: string;
let clientId: string;

/** Days back from now, at a fixed minute - editVisit refuses future dates. */
function daysAgo(days: number, minutesIntoDay = 0): Date {
  const d = new Date(Date.now() - days * 24 * 60 * 60_000);
  d.setUTCHours(10, minutesIntoDay, 0, 0);
  return d;
}

/** A visit at `start` lasting `minutes`, or with a deliberately broken end. */
async function makeVisit(start: Date, end: Date | null) {
  return prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acu-${randomToken(8)}`,
      status: "SCHEDULED",
      scheduledAt: start,
      endAt: end,
    },
    select: { id: true },
  });
}

const moveTo = (visitId: string, when: Date) =>
  request(app)
    .patch(`/api/dashboard/clients/${clientId}/visits/${visitId}`)
    .set("Cookie", cookie)
    .send({ when: when.toISOString() });

beforeAll(async () => {
  const email = `visitspan-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Span", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Span Cuts", bookingUrl: "https://s.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1555${randomToken(7)}`,
      magicToken: randomToken(),
      firstName: "Mover",
    },
    select: { id: true },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

describe("1. editing a visit's date keeps its duration", () => {
  it("🔴 a 45-minute visit moved stays 45 minutes — it does NOT collapse to zero", async () => {
    const start = daysAgo(20);
    const visit = await makeVisit(start, new Date(daysAgo(20).getTime() + 45 * 60_000));
    const when = daysAgo(10);

    const res = await moveTo(visit.id, when);
    expect(res.status).toBe(200);

    const after = await prisma.visit.findUniqueOrThrow({
      where: { id: visit.id },
      select: { scheduledAt: true, endAt: true },
    });
    expect(after.scheduledAt.toISOString()).toBe(daysAgo(10).toISOString());
    // The defect wrote 14:00 here. The duration is authoritative and survives.
    expect(after.endAt?.toISOString()).toBe(new Date(daysAgo(10).getTime() + 45 * 60_000).toISOString());
    expect(after.endAt!.getTime()).toBeGreaterThan(after.scheduledAt.getTime());
  });

  it("7. an ordinary 30-minute visit keeps its own 30 minutes, not a default", async () => {
    const visit = await makeVisit(
      daysAgo(20),
      new Date(daysAgo(20).getTime() + 30 * 60_000),
    );
    expect((await moveTo(visit.id, daysAgo(9))).status).toBe(200);
    const after = await prisma.visit.findUniqueOrThrow({
      where: { id: visit.id },
      select: { scheduledAt: true, endAt: true },
    });
    expect(after.endAt!.getTime() - after.scheduledAt.getTime()).toBe(30 * 60_000);
  });

  it("8. a visit with NO usable end still gets a real, blocking span", async () => {
    // 21,115 historical rows look like this. Moving one must not produce a
    // second malformed row - it fails safe to the default and logs.
    const visit = await makeVisit(daysAgo(20), null);
    expect((await moveTo(visit.id, daysAgo(8))).status).toBe(200);
    const after = await prisma.visit.findUniqueOrThrow({
      where: { id: visit.id },
      select: { scheduledAt: true, endAt: true },
    });
    expect(after.endAt).not.toBeNull();
    expect(after.endAt!.getTime()).toBeGreaterThan(after.scheduledAt.getTime());
    expect(after.endAt!.getTime() - after.scheduledAt.getTime()).toBe(30 * 60_000);
  });

  it("9. a visit whose stored end is ZERO-LENGTH is repaired, not propagated", async () => {
    const t = daysAgo(20);
    const visit = await makeVisit(t, t);
    expect((await moveTo(visit.id, daysAgo(7))).status).toBe(200);
    const after = await prisma.visit.findUniqueOrThrow({
      where: { id: visit.id },
      select: { scheduledAt: true, endAt: true },
    });
    // The old code would have written another zero-length span here.
    expect(after.endAt!.getTime()).toBeGreaterThan(after.scheduledAt.getTime());
  });

  it("9b. a NEGATIVE stored span is repaired too", async () => {
    const visit = await makeVisit(
      daysAgo(20),
      new Date(daysAgo(20).getTime() - 60 * 60_000),
    );
    expect((await moveTo(visit.id, daysAgo(6))).status).toBe(200);
    const after = await prisma.visit.findUniqueOrThrow({
      where: { id: visit.id },
      select: { scheduledAt: true, endAt: true },
    });
    expect(after.endAt!.getTime()).toBeGreaterThan(after.scheduledAt.getTime());
  });

  it("an edit that does NOT move the date leaves the span alone", async () => {
    const visit = await makeVisit(
      daysAgo(20),
      new Date(daysAgo(20).getTime() + 45 * 60_000),
    );
    const res = await request(app)
      .patch(`/api/dashboard/clients/${clientId}/visits/${visit.id}`)
      .set("Cookie", cookie)
      .send({ serviceName: "Beard trim" });
    expect(res.status).toBe(200);
    const after = await prisma.visit.findUniqueOrThrow({
      where: { id: visit.id },
      select: { scheduledAt: true, endAt: true, serviceName: true },
    });
    expect(after.serviceName).toBe("Beard trim");
    expect(after.endAt!.getTime() - after.scheduledAt.getTime()).toBe(45 * 60_000);
  });
});
