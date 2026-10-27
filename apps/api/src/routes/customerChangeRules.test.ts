import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * WHAT A CLIENT MAY CHANGE THEMSELVES, AND UNTIL WHEN
 * (Shop.customerCanReschedule / customerCanCancel / cancelCutoffHours, one
 * rule in config/customerChangeRules.ts).
 *
 * A client could always cancel online right up to the start. Each shop now
 * decides whether clients may move or cancel online at all, and how close to
 * the start they may still cancel. Pinned here, per entry point a CLIENT has:
 *   - the manage link: GET says so before they start (no button, the shop's
 *     sentence), and cancel / "this and the rest" / reschedule / the slot list
 *     refuse the same - including from a page left open across the line;
 *   - the group link: cancel-everyone and move-everyone, from the party's
 *     first start;
 *   - the barber's dashboard is never limited;
 *   - a refused cancel touches nothing: no cancel, no Payment row;
 *   - one shop's settings never reach another shop;
 *   - the cutoff is absolute hours, across the 2026-11-01 DST change.
 * The receptionist's tools have their own file
 * (receptionist/customerChangeRules.test.ts).
 */
const app = createApp();
const password = "supersecret123";
const HOUR = 3_600_000;
const emails: string[] = [];

/** `days` from now at 10:00 UTC - inside the 06:00-22:00 hours below. */
function dayAt10(days: number): Date {
  const d = new Date(Date.now() + days * 24 * HOUR);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0));
}

async function makeShop(label: string, timezone = "UTC") {
  const email = `chg-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Rules", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://rules.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      bookingMode: "native",
      timezone,
      bookingLeadMinutes: 0,
      publicPageEnabled: true,
      compAccess: true,
      // Each test sets the rule it is about; the #637 move cutoff is its own file.
      rescheduleCutoffHours: 0,
    },
  });
  const slug = (await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { slug: true } }))
    .slug!;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({ data: { shopId, serviceId: service.id, staffId: staff.id } });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId: staff.id,
      weekday,
      startMin: 0,
      endMin: 24 * 60 - 1,
    })),
  });
  return { cookie, shopId, slug, staffId: staff.id, serviceId: service.id, name: label };
}

type Shop = Awaited<ReturnType<typeof makeShop>>;

async function book(
  s: Shop,
  startsAt: Date,
  extra: { seriesId?: string; groupId?: string; groupPosition?: number } = {},
): Promise<{ id: string; token: string }> {
  const token = randomToken();
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      firstName: "Pat",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 40,
      manageToken: token,
      ...extra,
    },
    select: { id: true },
  });
  return { id: appt.id, token };
}

const statusOf = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const startsAtOf = async (id: string) =>
  (
    await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startsAt: true } })
  ).startsAt.toISOString();
const setRules = (s: Shop, data: Record<string, unknown>) =>
  prisma.shop.update({ where: { id: s.shopId }, data });
const view = (token: string) => request(app).get(`/api/book/manage/${token}`);
const cancel = (token: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/book/manage/${token}/cancel`).send(body);

let A: Shop;
let B: Shop;

beforeAll(async () => {
  A = await makeShop("Rule Cuts");
  B = await makeShop("Other Cuts");
});

afterEach(async () => {
  vi.useRealTimers();
  await setRules(A, {
    customerCanReschedule: true,
    customerCanCancel: true,
    cancelCutoffHours: 0,
    rescheduleCutoffHours: 0,
  });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const shops = await prisma.shop.findMany({ where: { ownerId: user.id }, select: { id: true } });
      for (const { id } of shops) {
        await prisma.appointment.deleteMany({ where: { shopId: id } });
        await prisma.appointmentGroup.deleteMany({ where: { shopId: id } });
        await prisma.recurringSeries.deleteMany({ where: { shopId: id } });
      }
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("the defaults keep today's behavior", () => {
  it("a new shop lets clients move and cancel, and cancel until the start", async () => {
    const S = await makeShop("Default Cuts");
    const row = await prisma.shop.findUniqueOrThrow({
      where: { id: S.shopId },
      select: { customerCanReschedule: true, customerCanCancel: true, cancelCutoffHours: true },
    });
    expect(row).toEqual({ customerCanReschedule: true, customerCanCancel: true, cancelCutoffHours: 0 });
    const { id, token } = await book(S, new Date(Date.now() + HOUR));
    const page = await view(token);
    expect(page.body.canCancel).toBe(true);
    expect(page.body.cancel).toBeNull();
    // The setting is answered as `cancel`, never leaked on `shop`.
    expect(page.body.shop.customerCanCancel).toBeUndefined();
    expect(page.body.shop.cancelCutoffHours).toBeUndefined();
    expect((await cancel(token)).status).toBe(200);
    expect(await statusOf(id)).toBe("CANCELED");
  });
});

describe("manage link: a shop that takes no cancels online", () => {
  it("🔴 the page says who to contact instead of offering Cancel, and the cancel is refused untouched", async () => {
    await setRules(A, { customerCanCancel: false });
    const { id, token } = await book(A, dayAt10(10));
    const page = await view(token);
    expect(page.body.canCancel).toBe(false);
    // Moving it is a separate switch - still on.
    expect(page.body.canReschedule).toBe(true);
    expect(page.body.cancel).toEqual({
      cutoffHours: 0,
      closesAt: null,
      closed: true,
      reason: "disabled",
      message:
        "Rule Cuts doesn't take cancellations online. To cancel your appointment, contact Rule Cuts directly.",
    });

    const res = await cancel(token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "cancel_closed", reason: "disabled" });
    expect(res.body.message).toContain("contact Rule Cuts directly");
    expect(res.body.message).not.toMatch(/fee|charge|\$/i);
    expect(await statusOf(id)).toBe("BOOKED");
    // Nothing was charged, refunded or recorded for it.
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(0);
  });

  it("🔴 the barber still cancels it from the dashboard", async () => {
    await setRules(A, { customerCanCancel: false, cancelCutoffHours: 48 });
    const { id } = await book(A, new Date(Date.now() + 2 * HOUR));
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/cancel`)
      .set("Cookie", A.cookie)
      .send({});
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("CANCELED");
  });

  it("🔴 shop isolation: shop A's switch never reaches shop B", async () => {
    await setRules(A, { customerCanCancel: false, customerCanReschedule: false, cancelCutoffHours: 168 });
    const { id, token } = await book(B, new Date(Date.now() + 3 * HOUR));
    const page = await view(token);
    expect(page.body.canCancel).toBe(true);
    expect(page.body.canReschedule).toBe(true);
    expect((await cancel(token)).status).toBe(200);
    expect(await statusOf(id)).toBe("CANCELED");
  });
});

describe("manage link: a cancel cutoff (12 hours)", () => {
  it("outside it: Cancel is offered, says until when, and works", async () => {
    await setRules(A, { cancelCutoffHours: 12 });
    const starts = new Date(Date.now() + 13 * HOUR);
    const { id, token } = await book(A, starts);
    const page = await view(token);
    expect(page.body.canCancel).toBe(true);
    expect(page.body.cancel).toEqual({
      cutoffHours: 12,
      closesAt: new Date(starts.getTime() - 12 * HOUR).toISOString(),
      closed: false,
      reason: null,
      message: null,
    });
    expect((await cancel(token)).status).toBe(200);
    expect(await statusOf(id)).toBe("CANCELED");
  });

  it("🔴 inside it: no Cancel, the shop's sentence, and the cancel is refused", async () => {
    await setRules(A, { cancelCutoffHours: 12 });
    const { id, token } = await book(A, new Date(Date.now() + 11 * HOUR));
    const page = await view(token);
    expect(page.body.canCancel).toBe(false);
    expect(page.body.cancel).toMatchObject({ closed: true, reason: "cutoff" });
    expect(page.body.cancel.message).toBe(
      "Rule Cuts takes cancellations online up to 12 hours before your appointment. To cancel now, contact Rule Cuts directly.",
    );
    // No late-cancel fee is quoted for a cancel the page doesn't offer.
    expect(page.body.lateCancelFee).toBeNull();
    const res = await cancel(token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "cancel_closed", reason: "cutoff" });
    expect(await statusOf(id)).toBe("BOOKED");
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(0);
  });

  it("🔴 exactly 12 hours before is allowed; one second inside is refused", async () => {
    await setRules(A, { cancelCutoffHours: 12 });
    const at = dayAt10(12);
    const first = await book(A, at);
    const second = await book(A, new Date(at.getTime() + HOUR));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at.getTime() - 12 * HOUR));
    expect((await cancel(first.token)).status).toBe(200);
    vi.setSystemTime(new Date(at.getTime() + HOUR - 12 * HOUR + 1000));
    const res = await cancel(second.token);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cancel_closed");
    expect(await statusOf(second.id)).toBe("BOOKED");
  });

  it("🔴 a page loaded before the cutoff and submitted after it is refused with the sentence", async () => {
    await setRules(A, { cancelCutoffHours: 12 });
    const at = dayAt10(13);
    const { id, token } = await book(A, at);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at.getTime() - 12 * HOUR - 60_000));
    expect((await view(token)).body.canCancel).toBe(true);
    vi.setSystemTime(new Date(at.getTime() - 12 * HOUR + 1000));
    const res = await cancel(token);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("up to 12 hours before your appointment");
    expect(await statusOf(id)).toBe("BOOKED");
  });

  it("🔴 'this and the rest' is judged by THIS visit's start, and refuses every visit together", async () => {
    await setRules(A, { cancelCutoffHours: 12 });
    const series = await prisma.recurringSeries.create({
      data: {
        shopId: A.shopId,
        staffId: A.staffId,
        serviceId: A.serviceId,
        firstName: "Pat",
        weekday: 1,
        startMin: 600,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const soon = await book(A, new Date(Date.now() + 5 * HOUR), { seriesId: series.id });
    const later = await book(A, dayAt10(8), { seriesId: series.id });
    const latest = await book(A, dayAt10(15), { seriesId: series.id });
    const res = await cancel(soon.token, { scope: "future" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cancel_closed");
    for (const v of [soon, later, latest]) expect(await statusOf(v.id)).toBe("BOOKED");

    // From a visit outside the cutoff, the rest goes with it.
    const ok = await cancel(later.token, { scope: "future" });
    expect(ok.status).toBe(200);
    expect(await statusOf(later.id)).toBe("CANCELED");
    expect(await statusOf(latest.id)).toBe("CANCELED");
    expect(await statusOf(soon.id)).toBe("BOOKED");
  });
});

describe("manage link: a shop that takes no reschedules online", () => {
  it("🔴 no Reschedule, no times, and the move is refused - Cancel stays", async () => {
    await setRules(A, { customerCanReschedule: false });
    const starts = dayAt10(9);
    const { id, token } = await book(A, starts);
    const page = await view(token);
    expect(page.body.canReschedule).toBe(false);
    expect(page.body.canCancel).toBe(true);
    expect(page.body.reschedule).toEqual({
      cutoffHours: 0,
      closesAt: null,
      closed: true,
      reason: "disabled",
      message:
        "Rule Cuts doesn't take reschedules online. To move your appointment, contact Rule Cuts directly.",
    });
    const slots = await request(app).get(`/api/book/manage/${token}/slots`);
    expect(slots.body.slots).toEqual([]);
    const res = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: dayAt10(11).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "reschedule_closed", reason: "disabled" });
    expect(await startsAtOf(id)).toBe(starts.toISOString());
  });

  it("🔴 the barber still moves it from the dashboard", async () => {
    await setRules(A, { customerCanReschedule: false, rescheduleCutoffHours: 168 });
    const { id } = await book(A, new Date(Date.now() + 2 * HOUR));
    const target = dayAt10(6);
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/reschedule`)
      .set("Cookie", A.cookie)
      .send({ startsAt: target.toISOString() });
    expect(res.status).toBe(200);
    expect(await startsAtOf(id)).toBe(target.toISOString());
  });

  it("switched back on, the client moves it as before", async () => {
    const { id, token } = await book(A, dayAt10(17));
    const target = dayAt10(18);
    const res = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: target.toISOString() });
    expect(res.status).toBe(200);
    expect(await startsAtOf(id)).toBe(target.toISOString());
  });
});

describe("🔴 across the 2026-11-01 DST change (America/New_York), the cutoff is absolute hours", () => {
  it("24 hours before 10:00 EST Sunday is 11:00 EDT Saturday - exactly then is allowed, a second later is not", async () => {
    const N = await makeShop("Eastern Cuts", "America/New_York");
    await setRules(N, { cancelCutoffHours: 24, rescheduleCutoffHours: 24 });
    // Sun 2026-11-01 10:00 EST = 15:00Z (clocks went back at 06:00Z).
    const tenAm = new Date("2026-11-01T15:00:00.000Z");
    const tenThirty = new Date("2026-11-01T15:30:00.000Z");
    const first = await book(N, tenAm);
    const second = await book(N, tenThirty);

    const page = await view(first.token);
    // NOT 2026-10-31T14:00Z (10:00 EDT, the same wall-clock time a day before).
    expect(page.body.cancel.closesAt).toBe("2026-10-31T15:00:00.000Z");
    expect(page.body.reschedule.closesAt).toBe("2026-10-31T15:00:00.000Z");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T15:00:00.000Z"));
    expect((await cancel(first.token)).status).toBe(200);
    vi.setSystemTime(new Date("2026-10-31T15:30:01.000Z"));
    const res = await cancel(second.token);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("cutoff");
    expect(await statusOf(second.id)).toBe("BOOKED");
  });
});

describe("the group link", () => {
  async function party(s: Shop, at: Date) {
    const group = await prisma.appointmentGroup.create({
      data: { shopId: s.shopId, staffId: s.staffId, firstName: "Pat", manageToken: randomToken() },
      select: { id: true, manageToken: true },
    });
    const one = await book(s, at, { groupId: group.id, groupPosition: 0 });
    const two = await book(s, new Date(at.getTime() + 30 * 60_000), { groupId: group.id, groupPosition: 1 });
    return { token: group.manageToken, groupId: group.id, members: [one, two] };
  }

  it("🔴 inside the cancel cutoff: the page says so, and cancel-everyone is refused untouched", async () => {
    await setRules(A, { cancelCutoffHours: 12 });
    const p = await party(A, new Date(Date.now() + 3 * HOUR));
    const page = await request(app).get(`/api/book/group/${p.token}`);
    expect(page.body.rules.cancel).toEqual({
      allowed: false,
      message:
        "Rule Cuts takes cancellations online up to 12 hours before your appointment. To cancel now, contact Rule Cuts directly.",
    });
    expect(page.body.members.map((m: { canCancel: boolean }) => m.canCancel)).toEqual([false, false]);
    const res = await request(app).post(`/api/book/group/${p.token}/cancel`).send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "cancel_closed", reason: "cutoff" });
    for (const m of p.members) expect(await statusOf(m.id)).toBe("BOOKED");
    const g = await prisma.appointmentGroup.findUniqueOrThrow({ where: { id: p.groupId } });
    expect(g.status).toBe("ACTIVE");
  });

  it("🔴 a shop that takes no cancels online refuses one member's cancel too", async () => {
    await setRules(A, { customerCanCancel: false });
    const p = await party(A, dayAt10(20));
    const res = await cancel(p.members[1]!.token);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("disabled");
    expect(await statusOf(p.members[1]!.id)).toBe("BOOKED");
  });

  it("🔴 a shop that takes no reschedules online refuses move-everyone; nobody moves", async () => {
    await setRules(A, { customerCanReschedule: false });
    const at = dayAt10(21);
    const p = await party(A, at);
    const page = await request(app).get(`/api/book/group/${p.token}`);
    expect(page.body.rules.reschedule.allowed).toBe(false);
    expect(page.body.rules.cancel.allowed).toBe(true);
    const res = await request(app)
      .post(`/api/book/group/${p.token}/reschedule`)
      .send({ startsAt: dayAt10(22).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "reschedule_closed", reason: "disabled" });
    expect(await startsAtOf(p.members[0]!.id)).toBe(at.toISOString());
  });

  it("🔴 inside the reschedule cutoff, measured from the party's first start", async () => {
    await setRules(A, { rescheduleCutoffHours: 24 });
    const at = new Date(Date.now() + 4 * HOUR);
    const p = await party(A, at);
    const res = await request(app)
      .post(`/api/book/group/${p.token}/reschedule`)
      .send({ startsAt: dayAt10(23).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "reschedule_closed", reason: "cutoff" });
    expect(await startsAtOf(p.members[0]!.id)).toBe(at.toISOString());
  });

  it("outside every rule, the party moves and cancels as before", async () => {
    await setRules(A, { cancelCutoffHours: 12, rescheduleCutoffHours: 24 });
    const p = await party(A, dayAt10(24));
    const page = await request(app).get(`/api/book/group/${p.token}`);
    expect(page.body.rules).toEqual({
      reschedule: { allowed: true, message: null },
      cancel: { allowed: true, message: null },
    });
    const target = dayAt10(25);
    const moved = await request(app)
      .post(`/api/book/group/${p.token}/reschedule`)
      .send({ startsAt: target.toISOString() });
    expect(moved.status).toBe(200);
    expect(await startsAtOf(p.members[0]!.id)).toBe(target.toISOString());
    const canceled = await request(app).post(`/api/book/group/${p.token}/cancel`).send({});
    expect(canceled.status).toBe(200);
    for (const m of p.members) expect(await statusOf(m.id)).toBe("CANCELED");
  });
});

describe("the settings", () => {
  it("are shown and saved: two switches, and whole hours from 0 to a week", async () => {
    const saved = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", B.cookie)
      .send({ customerCanReschedule: false, customerCanCancel: false, cancelCutoffHours: 6 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      customerCanReschedule: false,
      customerCanCancel: false,
      cancelCutoffHours: 6,
    });
    const me = await request(app).get("/api/shops/me").set("Cookie", B.cookie);
    expect(me.body).toMatchObject({ customerCanReschedule: false, customerCanCancel: false, cancelCutoffHours: 6 });

    for (const bad of [
      { cancelCutoffHours: 169 },
      { cancelCutoffHours: -1 },
      { cancelCutoffHours: 1.5 },
      { cancelCutoffHours: "6" },
      { customerCanCancel: "yes" },
      { customerCanReschedule: null },
    ]) {
      const res = await request(app).patch("/api/shops/me").set("Cookie", B.cookie).send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const after = await prisma.shop.findUniqueOrThrow({
      where: { id: B.shopId },
      select: { customerCanReschedule: true, customerCanCancel: true, cancelCutoffHours: true },
    });
    expect(after).toEqual({ customerCanReschedule: false, customerCanCancel: false, cancelCutoffHours: 6 });
    await setRules(B, { customerCanReschedule: true, customerCanCancel: true, cancelCutoffHours: 0 });
  });

  it("the database refuses a cancel cutoff outside the range too", async () => {
    await expect(setRules(B, { cancelCutoffHours: 500 })).rejects.toThrow();
  });
});
