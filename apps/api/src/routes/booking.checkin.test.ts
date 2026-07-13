import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import {
  __setPushSenderForTests,
  type PushPayload,
} from "../messaging/push.js";
import { createApp } from "../app.js";

/**
 * Client check-in ("On my way"): the manageToken is the ONLY authorization, the
 * route can only ever write 'en_route', the tap window is enforced server-side,
 * the barber push fires with ZERO SMS, and 'arrived' is dashboard-only +
 * tenant-scoped.
 */
const app = createApp();
const emailA = `checkin-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `checkin-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let shopIdA: string;
let staffId: string;
let serviceId: string;

let sent: SendMessageInput[] = []; // SMS - must stay EMPTY throughout
let pushes: PushPayload[] = [];

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

async function signupAndShop(email: string, name: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Checkin", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return cookie;
}

/** Create an Appointment row directly (the route only needs manageToken). */
async function seedAppt(opts: {
  startsInMin: number;
  status?: "BOOKED" | "PENDING" | "CANCELED" | "COMPLETED";
  checkInStatus?: string | null;
}): Promise<{ id: string; token: string }> {
  const startsAt = new Date(Date.now() + opts.startsInMin * 60_000);
  const token = randomToken();
  const appt = await prisma.appointment.create({
    data: {
      shopId: shopIdA,
      staffId,
      serviceId,
      firstName: "Marcus",
      status: opts.status ?? "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: token,
      checkInStatus: opts.checkInStatus ?? null,
    },
    select: { id: true },
  });
  return { id: appt.id, token };
}

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `SM-fake-${sent.length}`, status: "queued" };
    },
  });
  __setPushSenderForTests({
    send: async (_sub, payload) => {
      pushes.push(JSON.parse(payload) as PushPayload);
    },
  });

  cookieA = await signupAndShop(emailA, "Checkin Cuts A");
  cookieB = await signupAndShop(emailB, "Checkin Cuts B");

  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookieA)
    .send({ bookingMode: "native", timezone: "UTC" });
  expect(patch.status).toBe(200);
  const me = await request(app).get("/api/shops/me").set("Cookie", cookieA);
  shopIdA = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookieA)
    .send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookieA)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;

  // Availability every day 09:00-17:00 (shop tz = UTC) - the reschedule test
  // needs a genuinely bookable target slot.
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookieA)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });

  // A registered barber device, so the check-in push has somewhere to land.
  const owner = await prisma.user.findUnique({
    where: { email: emailA },
    select: { id: true },
  });
  await prisma.pushSubscription.create({
    data: {
      shopId: shopIdA,
      userId: owner!.id,
      kind: "web",
      endpoint: `https://push.test/${randomToken(8)}`,
      p256dh: "fake-p256dh",
      auth: "fake-auth",
    },
  });
});

beforeEach(() => {
  sent = [];
  pushes = [];
});

afterAll(async () => {
  process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  await prisma.$disconnect();
});

describe("GET /api/book/manage/:token checkin window", () => {
  it("is closed more than 60 min out, open inside, open in the 15-min grace", async () => {
    const far = await seedAppt({ startsInMin: 90 });
    const near = await seedAppt({ startsInMin: 45 });
    const grace = await seedAppt({ startsInMin: -10 });
    const past = await seedAppt({ startsInMin: -20 });

    for (const [appt, open] of [
      [far, false],
      [near, true],
      [grace, true],
      [past, false],
    ] as const) {
      const res = await request(app).get(`/api/book/manage/${appt.token}`);
      expect(res.status).toBe(200);
      expect(res.body.checkin.open).toBe(open);
    }
  });
});

describe("POST /api/book/manage/:token/checkin", () => {
  it("404s an unknown token (a client can never touch someone else's row)", async () => {
    const res = await request(app)
      .post(`/api/book/manage/${randomToken()}/checkin`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("rejects outside the window and for non-BOOKED statuses", async () => {
    const tooFar = await seedAppt({ startsInMin: 90 });
    const tooLate = await seedAppt({ startsInMin: -20 });
    const pending = await seedAppt({ startsInMin: 30, status: "PENDING" });
    const canceled = await seedAppt({ startsInMin: 30, status: "CANCELED" });

    for (const appt of [tooFar, tooLate, pending, canceled]) {
      const res = await request(app)
        .post(`/api/book/manage/${appt.token}/checkin`)
        .send({});
      expect(res.status).toBe(409);
    }
    expect(pushes).toHaveLength(0);
  });

  it("marks en_route once, pushes the barber, and never sends SMS", async () => {
    const appt = await seedAppt({ startsInMin: 30 });

    const res = await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({});
    expect(res.status).toBe(200);

    const row1 = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { checkInStatus: true, checkedInAt: true, etaMinutes: true },
    });
    expect(row1!.checkInStatus).toBe("en_route");
    expect(row1!.checkedInAt).not.toBeNull();
    expect(row1!.etaMinutes).toBeNull();

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.title).toContain("Marcus is on the way");

    // ETA chip re-tap: eta updates, checkedInAt does NOT move, the follow-up
    // push carries the eta (same collapse tag replaces the first).
    const res2 = await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({ etaMinutes: 10 });
    expect(res2.status).toBe(200);
    const row2 = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { checkedInAt: true, etaMinutes: true },
    });
    expect(row2!.etaMinutes).toBe(10);
    expect(row2!.checkedInAt!.getTime()).toBe(row1!.checkedInAt!.getTime());
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.body).toContain("10 min");
    expect(pushes[1]!.tag).toBe(pushes[0]!.tag);

    // A repeat identical tap adds no third buzz.
    const res3 = await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({ etaMinutes: 10 });
    expect(res3.status).toBe(200);
    expect(pushes).toHaveLength(2);

    // The whole feature is push-only.
    expect(sent).toHaveLength(0);
  });

  it("cannot write any status but en_route (no status field exists)", async () => {
    const appt = await seedAppt({ startsInMin: 30 });
    const res = await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({ status: "arrived" });
    expect(res.status).toBe(400); // strict schema rejects unknown keys

    const row = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { checkInStatus: true },
    });
    expect(row!.checkInStatus).toBeNull();
  });

  it("cannot regress a barber-set arrived", async () => {
    const appt = await seedAppt({ startsInMin: 30, checkInStatus: "arrived" });
    const res = await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_arrived");
  });
});

describe("reschedule resets check-in + push-reminder state", () => {
  it("clears push stamps and check-in fields so the new time re-arms everything", async () => {
    // A checked-in, already-push-reminded appointment tomorrow at 10:00 UTC.
    const startsAt = new Date();
    startsAt.setUTCDate(startsAt.getUTCDate() + 1);
    startsAt.setUTCHours(10, 0, 0, 0);
    const token = randomToken();
    const appt = await prisma.appointment.create({
      data: {
        shopId: shopIdA,
        staffId,
        serviceId,
        firstName: "Marcus",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        manageToken: token,
        checkInStatus: "en_route",
        checkedInAt: new Date(),
        etaMinutes: 10,
        runningLate: true,
        reminder24hPushSentAt: new Date(),
        reminder2hPushSentAt: new Date(),
      },
      select: { id: true },
    });

    const newStart = new Date(startsAt.getTime() + 2 * 60 * 60_000); // 12:00
    const res = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: newStart.toISOString() });
    expect(res.status).toBe(200);

    const row = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: {
        checkInStatus: true,
        checkedInAt: true,
        etaMinutes: true,
        runningLate: true,
        reminder24hPushSentAt: true,
        reminder2hPushSentAt: true,
      },
    });
    expect(row).toEqual({
      checkInStatus: null,
      checkedInAt: null,
      etaMinutes: null,
      runningLate: false,
      reminder24hPushSentAt: null,
      reminder2hPushSentAt: null,
    });
  });
});

describe("ETA revisions re-notify the barber", () => {
  it("pushes again when the eta CHANGES, not just when first set", async () => {
    const appt = await seedAppt({ startsInMin: 30 });
    await request(app).post(`/api/book/manage/${appt.token}/checkin`).send({});
    expect(pushes).toHaveLength(1);
    await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({ etaMinutes: 5 });
    expect(pushes).toHaveLength(2);
    // Revision 5 -> 15 must re-notify (the barber would otherwise keep "5 min").
    await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({ etaMinutes: 15 });
    expect(pushes).toHaveLength(3);
    expect(pushes[2]!.body).toContain("15 min");
    // Identical re-tap still doesn't buzz.
    await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({ etaMinutes: 15 });
    expect(pushes).toHaveLength(3);
    expect(sent).toHaveLength(0);
  });
});

describe("nudge routes", () => {
  /** An appointment attached to a client (nudging needs a push target). */
  async function seedClientAppt(): Promise<{ id: string; token: string }> {
    const client = await prisma.client.create({
      data: {
        shopId: shopIdA,
        acuityClientKey: `checkin-${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "Marcus",
      },
      select: { id: true },
    });
    await prisma.pushSubscription.create({
      data: {
        shopId: shopIdA,
        clientId: client.id,
        kind: "web",
        endpoint: `https://push.test/${randomToken(8)}`,
        p256dh: "k",
        auth: "a",
      },
    });
    const startsAt = new Date(Date.now() + 3 * 60 * 60_000); // 3h out
    const token = randomToken();
    const appt = await prisma.appointment.create({
      data: {
        shopId: shopIdA,
        staffId,
        serviceId,
        clientId: client.id,
        firstName: "Marcus",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        manageToken: token,
      },
      select: { id: true },
    });
    return { id: appt.id, token };
  }

  it("nudges push-only, enforces the cap at 429, and rejects cross-tenant", async () => {
    const appt = await seedClientAppt();

    // Foreign shop can't nudge it.
    const foreign = await request(app)
      .post(`/api/booking/appointments/${appt.id}/nudge`)
      .set("Cookie", cookieB)
      .send({ body: "hey" });
    expect(foreign.status).toBe(404);

    // Over-long body rejected.
    const long = await request(app)
      .post(`/api/booking/appointments/${appt.id}/nudge`)
      .set("Cookie", cookieA)
      .send({ body: "x".repeat(141) });
    expect(long.status).toBe(400);

    for (let i = 0; i < 2; i++) {
      const ok = await request(app)
        .post(`/api/booking/appointments/${appt.id}/nudge`)
        .set("Cookie", cookieA)
        .send({ body: "Chair's open, pull up whenever" });
      expect(ok.status).toBe(200);
      expect(ok.body.delivered).toBe(true);
    }
    const third = await request(app)
      .post(`/api/booking/appointments/${appt.id}/nudge`)
      .set("Cookie", cookieA)
      .send({ body: "again" });
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("nudge_limit");

    expect(pushes).toHaveLength(2);
    expect(sent).toHaveLength(0); // never SMS
  });

  it("nudge opens the check-in window early and the decline reply pushes back once", async () => {
    const appt = await seedClientAppt(); // 3h out - normally outside the window

    // Before any nudge: check-in is window-closed.
    const early = await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({});
    expect(early.status).toBe(409);
    // ...and a reply without a nudge is rejected.
    const noNudge = await request(app)
      .post(`/api/book/manage/${appt.token}/nudge-reply`)
      .send({ reply: "cant_make_it_early" });
    expect(noNudge.status).toBe(409);

    await request(app)
      .post(`/api/booking/appointments/${appt.id}/nudge`)
      .set("Cookie", cookieA)
      .send({ body: "I'm running 15 min ahead — come early if you can" });

    // The manage payload now surfaces the nudge and opens check-in.
    const manage = await request(app).get(`/api/book/manage/${appt.token}`);
    expect(manage.body.nudges).toHaveLength(1);
    expect(manage.body.checkin.open).toBe(true);

    // Decline reply: pushes the barber, then a second reply is throttled.
    pushes = [];
    const reply = await request(app)
      .post(`/api/book/manage/${appt.token}/nudge-reply`)
      .send({ reply: "cant_make_it_early" });
    expect(reply.status).toBe(200);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.title).toContain("can't make it early");
    const replyAgain = await request(app)
      .post(`/api/book/manage/${appt.token}/nudge-reply`)
      .send({ reply: "cant_make_it_early" });
    expect(replyAgain.status).toBe(429);

    // "On my way" now works despite being 3h out (the nudge invited it).
    const checkin = await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({});
    expect(checkin.status).toBe(200);
    expect(sent).toHaveLength(0); // zero SMS across the whole flow
  });
});

describe("POST /api/booking/appointments/:id/arrived (barber)", () => {
  it("marks arrived for its own shop, 404s cross-tenant and non-BOOKED", async () => {
    const appt = await seedAppt({ startsInMin: 30 });

    // Another shop's session cannot touch it.
    const foreign = await request(app)
      .post(`/api/booking/appointments/${appt.id}/arrived`)
      .set("Cookie", cookieB);
    expect(foreign.status).toBe(404);

    const ok = await request(app)
      .post(`/api/booking/appointments/${appt.id}/arrived`)
      .set("Cookie", cookieA);
    expect(ok.status).toBe(200);
    const row = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { checkInStatus: true, checkedInAt: true },
    });
    expect(row!.checkInStatus).toBe("arrived");
    // checkedInAt records the CLIENT's tap - a walk-in arrival leaves it null.
    expect(row!.checkedInAt).toBeNull();

    const canceled = await seedAppt({ startsInMin: 30, status: "CANCELED" });
    const bad = await request(app)
      .post(`/api/booking/appointments/${canceled.id}/arrived`)
      .set("Cookie", cookieA);
    expect(bad.status).toBe(404);
  });

  it("surfaces checkInStatus on the agenda rows", async () => {
    const appt = await seedAppt({ startsInMin: 30 });
    await request(app)
      .post(`/api/book/manage/${appt.token}/checkin`)
      .send({ etaMinutes: 5 });

    const from = new Date(Date.now() - 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const res = await request(app)
      .get(`/api/booking/agenda?from=${from}&to=${to}`)
      .set("Cookie", cookieA);
    expect(res.status).toBe(200);
    const row = (res.body.agenda as { id: string; checkInStatus: string | null; etaMinutes: number | null }[]).find(
      (r) => r.id === appt.id,
    );
    expect(row).toBeDefined();
    expect(row!.checkInStatus).toBe("en_route");
    expect(row!.etaMinutes).toBe(5);
  });
});
