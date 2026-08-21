import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { slotServiceIds } from "../engines/targetedSlotServices.js";

/**
 * Duplicating a targeted slot or series.
 *
 * 🔑 THE ONE THING THAT MUST NOT HAPPEN: a copy quietly going live. Duplicating
 * a nightly series is how a barber ends up working every evening twice over, so
 * the copy is created with NO materialized slots and NO public availability
 * until they review it and publish. Every test below is ultimately about that.
 */

const app = createApp();
const email = `tdup-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceA: string;
let serviceB: string;

function tomorrowAt(hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

const publish = (body: Record<string, unknown>) =>
  request(app).post("/api/booking/targeted-slots").set("Cookie", cookie).send(body);

const listDash = () =>
  request(app).get("/api/booking/targeted-slots").set("Cookie", cookie);

/** Every targeted chip the PUBLIC page would show, across the next month. */
async function publicSlotLabels(): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}`);
  return (res.body.targetedSlots as { label: string | null }[]).map(
    (t) => t.label ?? "",
  );
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Dup Cuts", bookingUrl: "https://book.test", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  staffId = staff.body.id;
  for (const [name, set] of [
    ["Retwist", (v: string) => (serviceA = v)],
    ["Line-up", (v: string) => (serviceB = v)],
  ] as const) {
    const r = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name, durationMin: 30, price: 40, staffIds: [staffId] });
    set(r.body.id);
  }
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.targetedSlot.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* Duplicating a SERIES                                                */
/* ------------------------------------------------------------------ */

describe("duplicating a weekly series", () => {
  it("copies the configuration but publishes NOTHING", async () => {
    const created = await publish({
      staffId,
      serviceId: serviceA,
      serviceIds: [serviceA, serviceB],
      startsAt: tomorrowAt(20).toISOString(),
      durationMin: 45,
      price: 85,
      label: "Nightly",
      repeatForever: true,
    });
    expect(created.status).toBe(201);
    const originalId = created.body.ruleId as string;
    const originalSlots = await prisma.targetedSlot.count({
      where: { shopId, ruleId: originalId },
    });
    expect(originalSlots).toBeGreaterThan(0);

    const dup = await request(app)
      .post(`/api/booking/targeted-slots/rules/${originalId}/duplicate`)
      .set("Cookie", cookie)
      .send({});
    expect(dup.status).toBe(201);
    const copyId = dup.body.ruleId as string;

    // A NEW id.
    expect(copyId).not.toBe(originalId);

    const copy = await prisma.targetedSlotRule.findUniqueOrThrow({
      where: { id: copyId },
      select: {
        label: true, staffId: true, serviceId: true, durationMin: true,
        price: true, schedule: true, indefinite: true, active: true,
        draft: true, weeksMaterialized: true,
        services: { select: { serviceId: true } },
      },
    });
    const original = await prisma.targetedSlotRule.findUniqueOrThrow({
      where: { id: originalId },
      select: { label: true, schedule: true, active: true, draft: true },
    });

    // Configuration carried over.
    expect(copy.label).toBe("Nightly Copy");
    expect(copy.staffId).toBe(staffId);
    expect(copy.durationMin).toBe(45);
    expect(Number(copy.price)).toBe(85);
    expect(copy.indefinite).toBe(true);
    expect(copy.schedule).toEqual(original.schedule);
    expect(slotServiceIds(copy).sort()).toEqual([serviceA, serviceB].sort());

    // 🔑 Published nothing.
    expect(copy.active).toBe(false);
    expect(copy.draft).toBe(true);
    expect(copy.weeksMaterialized).toBe(0);
    expect(await prisma.targetedSlot.count({ where: { shopId, ruleId: copyId } })).toBe(0);

    // The ORIGINAL is untouched.
    expect(original.active).toBe(true);
    expect(original.draft).toBe(false);
    expect(original.label).toBe("Nightly");
    expect(
      await prisma.targetedSlot.count({ where: { shopId, ruleId: originalId } }),
    ).toBe(originalSlots);
  });

  it("adds NO public availability - the whole point", async () => {
    const before = await publicSlotLabels();
    const created = await publish({
      staffId,
      serviceId: serviceA,
      startsAt: tomorrowAt(21).toISOString(),
      durationMin: 30,
      price: 60,
      label: "Silent",
      repeatForever: true,
    });
    const afterOriginal = await publicSlotLabels();
    expect(afterOriginal.length).toBeGreaterThan(before.length);

    await request(app)
      .post(`/api/booking/targeted-slots/rules/${created.body.ruleId}/duplicate`)
      .set("Cookie", cookie)
      .send({});

    // Not one extra chip on the public page.
    const afterCopy = await publicSlotLabels();
    expect(afterCopy.length).toBe(afterOriginal.length);
    expect(afterCopy.filter((l) => l === "Silent Copy")).toHaveLength(0);
  });

  it("shows the draft in the dashboard so it is not lost", async () => {
    // active=false alone would hide it from the rules list - the barber would
    // click Duplicate and watch nothing appear. That is what `draft` is for.
    const list = await listDash();
    const drafts = (list.body.rules as { label: string; draft: boolean }[]).filter(
      (r) => r.draft,
    );
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.some((r) => r.label.endsWith("Copy"))).toBe(true);
  });

  it("goes live only when the barber saves it, and independently", async () => {
    const created = await publish({
      staffId,
      serviceId: serviceA,
      startsAt: tomorrowAt(22).toISOString(),
      durationMin: 30,
      price: 55,
      label: "Publishable",
      repeatForever: true,
    });
    const originalId = created.body.ruleId as string;
    const dup = await request(app)
      .post(`/api/booking/targeted-slots/rules/${originalId}/duplicate`)
      .set("Cookie", cookie)
      .send({});
    const copyId = dup.body.ruleId as string;

    // Review + publish: saving a draft is what publishes it.
    const saved = await request(app)
      .patch(`/api/booking/targeted-slots/rules/${copyId}`)
      .set("Cookie", cookie)
      .send({ label: "Publishable Copy", price: 99 });
    expect(saved.status).toBe(200);

    const copy = await prisma.targetedSlotRule.findUniqueOrThrow({
      where: { id: copyId },
      select: { active: true, draft: true, price: true },
    });
    expect(copy.active).toBe(true);
    expect(copy.draft).toBe(false);
    expect(Number(copy.price)).toBe(99);
    expect(
      await prisma.targetedSlot.count({ where: { shopId, ruleId: copyId } }),
    ).toBeGreaterThan(0);

    // INDEPENDENT: editing the copy did not touch the original's price.
    const original = await prisma.targetedSlotRule.findUniqueOrThrow({
      where: { id: originalId },
      select: { price: true, label: true },
    });
    expect(Number(original.price)).toBe(55);
    expect(original.label).toBe("Publishable");
  });
});

/* ------------------------------------------------------------------ */
/* Duplicating a ONE-OFF                                               */
/* ------------------------------------------------------------------ */

describe("duplicating a one-off slot", () => {
  it("copies the config, stays inactive, and carries no booking", async () => {
    const at = tomorrowAt(16);
    await publish({
      staffId,
      serviceId: serviceA,
      serviceIds: [serviceA, serviceB],
      startsAt: at.toISOString(),
      durationMin: 40,
      price: 75,
      label: "Solo",
    });
    const src = await prisma.targetedSlot.findFirstOrThrow({
      where: { shopId, startsAt: at },
      select: { id: true },
    });

    // Book the ORIGINAL, so the copy has something it could wrongly inherit.
    const booked = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: serviceB,
        startsAt: at.toISOString(),
        targetedSlotId: src.id,
        firstName: "Book", lastName: "Ed",
        email: `b-${randomToken(6)}@test.local`,
      });
    expect([200, 201]).toContain(booked.status);

    const dup = await request(app)
      .post(`/api/booking/targeted-slots/${src.id}/duplicate`)
      .set("Cookie", cookie)
      .send({});
    expect(dup.status).toBe(201);

    const copy = await prisma.targetedSlot.findUniqueOrThrow({
      where: { id: dup.body.slotId as string },
      select: {
        id: true, label: true, staffId: true, serviceId: true, startsAt: true,
        durationMin: true, price: true, active: true, ruleId: true,
        bookedAppointmentId: true,
        services: { select: { serviceId: true } },
      },
    });

    expect(copy.id).not.toBe(src.id);
    expect(copy.label).toBe("Solo Copy");
    expect(copy.durationMin).toBe(40);
    expect(Number(copy.price)).toBe(75);
    expect(copy.startsAt.getTime()).toBe(at.getTime());
    expect(slotServiceIds(copy).sort()).toEqual([serviceA, serviceB].sort());

    // 🔑 No booking, no series, not live.
    expect(copy.bookedAppointmentId).toBeNull();
    expect(copy.ruleId).toBeNull();
    expect(copy.active).toBe(false);

    // And it adds no public chip even though it sits at the same instant.
    expect(await publicSlotLabels()).not.toContain("Solo Copy");
  });
});

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

describe("the copy's label", () => {
  it("is just 'Copy' when the original had none", async () => {
    const at = tomorrowAt(13);
    await publish({
      staffId,
      serviceId: serviceA,
      startsAt: at.toISOString(),
      durationMin: 30,
      price: 40,
    });
    const src = await prisma.targetedSlot.findFirstOrThrow({
      where: { shopId, startsAt: at },
      select: { id: true },
    });
    const dup = await request(app)
      .post(`/api/booking/targeted-slots/${src.id}/duplicate`)
      .set("Cookie", cookie)
      .send({});
    const copy = await prisma.targetedSlot.findUniqueOrThrow({
      where: { id: dup.body.slotId as string },
      select: { label: true },
    });
    // Not "null Copy", not "(no label) Copy".
    expect(copy.label).toBe("Copy");
  });

  it("stays within the 60-char column on a long label", async () => {
    const at = tomorrowAt(12);
    const long = "A".repeat(58);
    await publish({
      staffId,
      serviceId: serviceA,
      startsAt: at.toISOString(),
      durationMin: 30,
      price: 40,
      label: long,
    });
    const src = await prisma.targetedSlot.findFirstOrThrow({
      where: { shopId, startsAt: at },
      select: { id: true },
    });
    const dup = await request(app)
      .post(`/api/booking/targeted-slots/${src.id}/duplicate`)
      .set("Cookie", cookie)
      .send({});
    const copy = await prisma.targetedSlot.findUniqueOrThrow({
      where: { id: dup.body.slotId as string },
      select: { label: true },
    });
    expect(copy.label!.length).toBeLessThanOrEqual(60);
    expect(copy.label!.endsWith("Copy")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("ownership", () => {
  it("cannot duplicate another shop's series", async () => {
    const other = await request(app)
      .post("/api/auth/signup")
      .send({
        email: `tdup2-${randomToken(6)}@test.local`.toLowerCase(),
        password,
        name: "O",
        smsAttested: true,
      });
    const otherCookie = (other.headers["set-cookie"] as unknown as string[])[0]!;
    const mine = await listDash();
    const anyRuleId = (mine.body.rules as { id: string }[])[0]!.id;

    const res = await request(app)
      .post(`/api/booking/targeted-slots/rules/${anyRuleId}/duplicate`)
      .set("Cookie", otherCookie)
      .send({});
    // No shop yet for that user, or a shop that doesn't own the rule - either
    // way it must not succeed.
    expect(res.status).not.toBe(201);
  });
});
