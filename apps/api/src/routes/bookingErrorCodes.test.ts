import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { isLikelyEmail, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import {
  isAppointmentSlotConflict,
  uniqueTargetOf,
} from "../services/bookingErrorMapping.js";

/**
 * Why a booking failed, said in a way a machine can act on.
 *
 * The complaint that started this: a customer typed a malformed email address
 * and the page answered *"That time was just taken. Pick another slot."* They
 * picked another slot. Same answer. There was no bug in the calendar at all.
 *
 * Two separate defects made that possible, and both are falsified here:
 *
 *  1. The server had ONE code for every malformed field, so the page could not
 *     tell an unusable email from an unusable time.
 *  2. The create route mapped EVERY Prisma P2002 to `slot_taken`, though the
 *     booking transaction violates several different unique constraints and
 *     only one of them is about the calendar.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;

/** A real open slot on the shop's grid, `days` out. */
async function anOpenSlot(days = 3): Promise<string> {
  const res = await request(app).get(`/api/book/${slug}/slots?serviceId=${serviceId}&staffId=${staffId}`);
  expect(res.status).toBe(200);
  const slots = res.body.slots as { startsAt: string }[];
  expect(slots.length).toBeGreaterThan(days);
  return slots[days]!.startsAt;
}

function validBody(startsAt: string, over: Record<string, unknown> = {}) {
  return {
    staffId,
    serviceId,
    startsAt,
    firstName: "Dana",
    lastName: "Okafor",
    phone: "(302) 555-0111",
    email: "dana.okafor@example.com",
    ...over,
  };
}

beforeAll(async () => {
  const email = `errcode-${randomToken(6)}@test.local`;
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Err Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: "Error Code Cuts",
      bookingUrl: "https://errcode.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  slug = shopRes.body.slug;
  await prisma.shop.update({
    where: { id: shopId },
    data: { timezone: "UTC", bookingMode: "native", publicPageEnabled: true },
  });

  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  // Open every weekday so the grid always has slots to offer.
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 9 * 60, endMin: 18 * 60 },
    });
  }
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("an invalid email is an EMAIL problem", () => {
  it("never answers SLOT_UNAVAILABLE, whatever the address looks like", async () => {
    const startsAt = await anOpenSlot();
    for (const bad of [
      "not-an-email",
      "dana@",
      "@example.com",
      "dana@localhost",
      "dana example@test.com",
      "dana@@example.com",
      "dana@example",
      "dana@example.c",
      ".dana@example.com",
      "dana..okafor@example.com",
      "dana@-example.com",
      "dana@example..com",
    ]) {
      const res = await request(app)
        .post(`/api/book/${slug}`)
        .send(validBody(startsAt, { email: bad }));
      expect(res.status, `for ${bad}`).toBe(422);
      expect(res.body.code, `for ${bad}`).toBe("INVALID_EMAIL");
      expect(res.body.field).toBe("email");
      // The three things it must never be.
      expect(res.body.code).not.toBe("SLOT_UNAVAILABLE");
      expect(res.status).not.toBe(409);
      expect(JSON.stringify(res.body)).not.toContain("slot_taken");
    }
  });

  it("writes NOTHING - no appointment, no hold, no client, no notification", async () => {
    const startsAt = await anOpenSlot(4);
    const before = {
      appts: await prisma.appointment.count({ where: { shopId } }),
      clients: await prisma.client.count({ where: { shopId } }),
      payments: await prisma.payment.count({ where: { shopId } }),
      outbox: await prisma.emailIntent.count({ where: { shopId } }),
    };
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send(validBody(startsAt, { email: "nope@@bad", firstName: "Ghost" }));
    expect(res.status).toBe(422);

    expect(await prisma.appointment.count({ where: { shopId } })).toBe(before.appts);
    expect(await prisma.client.count({ where: { shopId } })).toBe(before.clients);
    expect(await prisma.payment.count({ where: { shopId } })).toBe(before.payments);
    expect(await prisma.emailIntent.count({ where: { shopId } })).toBe(before.outbox);
    // Not even a lapsed hold under another status.
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Ghost" } })).toBe(0);
    // And the slot is still on offer, because nothing ever claimed it.
    const after = await request(app).get(
      `/api/book/${slug}/slots?serviceId=${serviceId}&staffId=${staffId}`,
    );
    expect((after.body.slots as { startsAt: string }[]).some((s) => s.startsAt === startsAt)).toBe(
      true,
    );
  });

  it("accepts the legitimate addresses a naive regex rejects", async () => {
    let day = 6;
    for (const good of [
      "dana+haircut@gmail.com",
      "first.last@mail.co.uk",
      "x@deep.sub.domain.example.com",
      "o'brien@example.com",
      "dana@example.travel",
      "DANA.OKAFOR@Example.COM",
      "d@ex.io",
    ]) {
      expect(isLikelyEmail(good), `${good} should be accepted`).toBe(true);
      const startsAt = await anOpenSlot(day++);
      const res = await request(app)
        .post(`/api/book/${slug}`)
        .send(validBody(startsAt, { email: good, phone: "" }));
      expect(res.status, `for ${good}`).toBe(201);
    }
  });

  it("classifies a bad phone as a PHONE problem, not a slot problem", async () => {
    const startsAt = await anOpenSlot(20);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send(validBody(startsAt, { phone: "12" }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_PHONE");
    expect(res.body.field).toBe("phone");
  });

  it("classifies a missing name as a plain validation error, and says which field", async () => {
    const startsAt = await anOpenSlot(21);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send(validBody(startsAt, { lastName: "   " }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.field).toBe("lastName");
    // The legacy string is untouched, so nothing that already reads it breaks.
    expect(res.body.error).toBe("invalid_input");
  });
});

describe("only the calendar may say the slot is gone", () => {
  it("answers SLOT_UNAVAILABLE for a genuinely taken time", async () => {
    const startsAt = await anOpenSlot(25);
    const first = await request(app).post(`/api/book/${slug}`).send(validBody(startsAt));
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/api/book/${slug}`)
      .send(validBody(startsAt, { firstName: "Other", email: "other@example.com" }));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("SLOT_UNAVAILABLE");
    expect(second.body.error).toBe("slot_taken");
  });

  it("🔴 reads the CONSTRAINT, so only the appointment index means slot_taken", () => {
    const p2002 = (target: unknown) =>
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5",
        meta: { target },
      });

    // The real one, in both shapes Prisma reports.
    expect(isAppointmentSlotConflict(p2002(["staffId", "startsAt"]))).toBe(true);
    expect(isAppointmentSlotConflict(p2002("Appointment_staffId_startsAt_key"))).toBe(true);

    // 🔴 The ones that used to be reported as "that time was just taken".
    expect(isAppointmentSlotConflict(p2002(["shopId", "acuityClientKey"]))).toBe(false);
    expect(isAppointmentSlotConflict(p2002("Client_shopId_acuityClientKey_key"))).toBe(false);
    expect(isAppointmentSlotConflict(p2002(["magicToken"]))).toBe(false);
    expect(isAppointmentSlotConflict(p2002(["manageToken"]))).toBe(false);
    expect(isAppointmentSlotConflict(p2002(["stripePaymentIntentId"]))).toBe(false);

    // Fails CLOSED: an unknown or missing target is never a slot conflict.
    expect(isAppointmentSlotConflict(p2002(undefined))).toBe(false);
    expect(isAppointmentSlotConflict(p2002([]))).toBe(false);
    expect(isAppointmentSlotConflict(p2002({ weird: true }))).toBe(false);
    // Half a match is not a match.
    expect(isAppointmentSlotConflict(p2002(["staffId"]))).toBe(false);
    expect(isAppointmentSlotConflict(p2002(["startsAt"]))).toBe(false);

    expect(uniqueTargetOf(p2002(["staffId", "startsAt"]))).toBe("staffid,startsat");
    expect(uniqueTargetOf(p2002(undefined))).toBe("");
  });

  it("two customers sharing one client key at DIFFERENT times both get booked", async () => {
    // The exact shape that used to produce a false slot_taken: one household,
    // one email, two appointments. Whichever way the client upsert resolves,
    // neither customer may be told the CALENDAR refused them.
    const shared = "household@example.com";
    const a = await anOpenSlot(30);
    const b = await anOpenSlot(31);
    const first = await request(app)
      .post(`/api/book/${slug}`)
      .send(validBody(a, { firstName: "Ada", email: shared, phone: "" }));
    const second = await request(app)
      .post(`/api/book/${slug}`)
      .send(validBody(b, { firstName: "Ben", email: shared, phone: "" }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(a).not.toBe(b);
  });
});

describe("a refusal never leaks what it was handed", () => {
  it("echoes no token, header, card number or address back to the caller", async () => {
    const startsAt = await anOpenSlot(35);
    const hostile = {
      email: "sk_live_51ABCdefGHIjklMNOpqrs@example.com evil",
      firstName: "4242424242424242",
      lastName: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      phone: "+15551239999",
    };
    const res = await request(app).post(`/api/book/${slug}`).send(validBody(startsAt, hostile));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_EMAIL");
    const body = JSON.stringify(res.body);
    // Zod echoes the PATH of a failing field, never its value.
    expect(body).not.toContain("sk_live");
    expect(body).not.toContain("4242424242424242");
    expect(body).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(body).not.toContain("15551239999");
  });

  it("carries a stable code on a rate limit too", async () => {
    // Asserted on the handler's contract rather than by exhausting the real
    // limiter, which is shared and would poison every other test in the file.
    const { rateLimitedHandler } = await import("../middleware/rateLimit.js");
    let status = 0;
    let payload: Record<string, unknown> = {};
    const res = {
      status(s: number) {
        status = s;
        return this;
      },
      json(b: Record<string, unknown>) {
        payload = b;
        return this;
      },
    };
    rateLimitedHandler("bookingWrite")(
      { ip: "127.0.0.1", originalUrl: "/api/book/x", method: "POST" } as never,
      res as never,
    );
    expect(status).toBe(429);
    expect(payload.code).toBe("RATE_LIMITED");
  });
});
