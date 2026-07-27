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
 * Barber-side booking alerts: every customer-initiated booking event (instant
 * booking, approval-mode request, manage-page reschedule/cancel) pushes the
 * appointment's barber (staff-linked user, else the owner) AND texts the
 * shop's notifyPhone. The customer-facing confirmation flow is covered by
 * booking.public.test.ts - here we assert the BUSINESS leg.
 */
const app = createApp();
const emailOwner = `bnotify-o-${randomToken(6)}@test.local`.toLowerCase();
const emailMate = `bnotify-m-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const NOTIFY_PHONE = "+13025557788";
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let ownerId: string;

let sent: SendMessageInput[] = [];
let pushes: Array<{ endpoint: string; payload: PushPayload }> = [];

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

/** A future instant (UTC) at the given hour, `daysAhead` days from now. */
function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** The SMS legs sent to the barber's alert number (not to customers). */
function barberSms(): SendMessageInput[] {
  return sent.filter((s) => s.to === NOTIFY_PHONE);
}

async function book(startsAt: Date, firstName: string) {
  const res = await request(app).post(`/api/book/${slug}`).send({
    staffId,
    serviceId,
    startsAt: startsAt.toISOString(),
    firstName,
    lastName: "Reyes",
    phone: "(302) 555-0355",
    smsConsent: true,
  });
  expect(res.status).toBe(201);
  return res.body as { manageToken: string; pending: boolean };
}

/** Poll until the fire-and-forget notify legs land (they run post-response). */
async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pred()).toBe(true);
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
    send: async (sub, payload) => {
      pushes.push({
        endpoint: (sub as { endpoint: string }).endpoint,
        payload: JSON.parse(payload) as PushPayload,
      });
    },
  });

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: emailOwner, password, name: "Notify", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Notify Cuts", bookingUrl: "https://n.test", smsAttested: true });
  expect(shop.status).toBe(201);

  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({
      bookingMode: "native",
      timezone: "UTC",
      bookingLeadHours: 1,
      notifyPhone: NOTIFY_PHONE,
    });
  expect(patch.status).toBe(200);
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;

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

  // The owner's registered device - where the alert push lands.
  const owner = await prisma.user.findUnique({
    where: { email: emailOwner },
    select: { id: true },
  });
  ownerId = owner!.id;
  await prisma.pushSubscription.create({
    data: {
      shopId,
      userId: ownerId,
      kind: "web",
      endpoint: "https://push.test/owner-device",
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
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  for (const email of [emailOwner, emailMate]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("barber booking alerts", () => {
  it("instant booking pushes 'New booking' to the owner and texts notifyPhone", async () => {
    await book(futureAtHour(2, 10), "Malik");
    await waitFor(() => pushes.length > 0 && barberSms().length > 0);

    const push = pushes.find((p) => p.payload.title === "New booking");
    expect(push).toBeTruthy();
    expect(push!.endpoint).toBe("https://push.test/owner-device");
    expect(push!.payload.body).toContain("Malik Reyes just booked Haircut with Sam");
    expect(push!.payload.url).toContain("/dashboard/booking");

    const sms = barberSms()[0]!;
    expect(sms.body).toContain("Notify Cuts:");
    expect(sms.body).toContain("Malik Reyes just booked Haircut with Sam");
    // The formatted shop-tz time is present. Deliberately loose: ICU versions
    // differ on the joiner ("Jul 29 at 10:00 AM" vs "Jul 29, 10:00 AM") and on
    // the space before AM/PM (U+202F on newer Node), so pin only the pieces.
    expect(sms.body).toMatch(/ - \w{3}, \w{3} \d{1,2}.* \d{1,2}:\d{2}\s[AP]M$/);
  });

  it("approval-mode request pushes 'New booking request' with request wording", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ requireBookingApproval: true });
    try {
      const res = await book(futureAtHour(3, 10), "Priya");
      expect(res.pending).toBe(true);
      await waitFor(() => pushes.length > 0 && barberSms().length > 0);

      const push = pushes.find((p) => p.payload.title === "New booking request");
      expect(push).toBeTruthy();
      expect(push!.payload.body).toContain("Priya Reyes requested Haircut with Sam");
      expect(barberSms()[0]!.body).toContain("requested Haircut");
    } finally {
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", cookie)
        .send({ requireBookingApproval: false });
    }
  });

  it("manage-page reschedule pushes 'Booking moved' with the NEW time", async () => {
    const { manageToken } = await book(futureAtHour(4, 10), "Dana");
    await waitFor(() => pushes.length > 0);
    pushes = [];
    sent = [];

    const to = futureAtHour(4, 13);
    const res = await request(app)
      .post(`/api/book/manage/${manageToken}/reschedule`)
      .send({ startsAt: to.toISOString() });
    expect(res.status).toBe(200);
    await waitFor(() => pushes.some((p) => p.payload.title === "Booking moved"));

    const push = pushes.find((p) => p.payload.title === "Booking moved")!;
    expect(push.payload.body).toContain("Dana Reyes moved their Haircut with Sam to");
    expect(push.payload.body).toContain("1:00 PM");
    await waitFor(() => barberSms().length > 0);
  });

  it("manage-page cancel pushes 'Booking canceled'", async () => {
    const { manageToken } = await book(futureAtHour(5, 10), "Omar");
    await waitFor(() => pushes.length > 0);
    pushes = [];
    sent = [];

    const res = await request(app).post(`/api/book/manage/${manageToken}/cancel`);
    expect(res.status).toBe(200);
    await waitFor(() =>
      pushes.some((p) => p.payload.title === "Booking canceled"),
    );
    const push = pushes.find((p) => p.payload.title === "Booking canceled")!;
    expect(push.payload.body).toContain("Omar Reyes canceled their Haircut with Sam");
    await waitFor(() => barberSms().some((s) => s.body.includes("canceled")));
  });

  it("targets the staff-linked user's devices when the staffer is linked", async () => {
    // A teammate user linked to the staff row, with their own device.
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: emailMate, password, name: "Mate", smsAttested: true });
    expect(signup.status).toBe(201);
    const mate = await prisma.user.findUnique({
      where: { email: emailMate },
      select: { id: true },
    });
    await prisma.pushSubscription.create({
      data: {
        shopId,
        userId: mate!.id,
        kind: "web",
        endpoint: "https://push.test/mate-device",
        p256dh: "fake-p256dh",
        auth: "fake-auth",
      },
    });
    await prisma.staff.update({
      where: { id: staffId },
      data: { userId: mate!.id },
    });
    try {
      await book(futureAtHour(6, 10), "Lena");
      await waitFor(() => pushes.some((p) => p.payload.title === "New booking"));
      const push = pushes.find((p) => p.payload.title === "New booking")!;
      expect(push.endpoint).toBe("https://push.test/mate-device");
      // The owner did NOT get this one - it's the staffer's booking.
      expect(
        pushes.filter((p) => p.endpoint === "https://push.test/owner-device"),
      ).toHaveLength(0);
    } finally {
      await prisma.staff.update({
        where: { id: staffId },
        data: { userId: null },
      });
    }
  });
});
