import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { CLIENT_NOTE_MAX } from "@chairback/config/clientNote";
import { createApp } from "../app.js";

/**
 * THE SHOP'S NOTE FOR CLIENTS, END TO END (a barber: "add notes to the
 * confirmations - please arrive 10 minutes early"). Saved from settings,
 * cleaned and capped by the API, and handed to the booked screen and the
 * appointment page. (The emails are messaging/clientNoteEmail.test.ts.)
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

beforeAll(async () => {
  const email = `note-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "N", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Note Test Shop", bookingUrl: "https://n.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 365 });
  expect(patch.status).toBe(200);
  slug = patch.body.slug as string;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Standard visit", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

beforeEach(async () => {
  if (shopId) await prisma.shop.update({ where: { id: shopId }, data: { clientNote: null } });
});

const save = (clientNote: unknown) =>
  request(app).patch("/api/shops/me").set("Cookie", cookie).send({ clientNote });
const stored = async () =>
  (await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { clientNote: true } })).clientNote;

describe("saving it", () => {
  it("🔴 saves the note, trimmed, with a run of blank lines collapsed", async () => {
    const res = await save("  Please arrive 10 minutes early.\n\n\n\nParking out back.  ");
    expect(res.status).toBe(200);
    expect(await stored()).toBe("Please arrive 10 minutes early.\n\nParking out back.");
    expect(res.body.clientNote).toBe("Please arrive 10 minutes early.\n\nParking out back.");
  });

  it("blank or null clears it", async () => {
    await save("Arrive early.");
    expect((await save("   ")).status).toBe(200);
    expect(await stored()).toBeNull();
    await save("Arrive early.");
    expect((await save(null)).status).toBe(200);
    expect(await stored()).toBeNull();
  });

  it("🔴 over the limit is refused, never cut", async () => {
    await save("Keep me.");
    const res = await save("a".repeat(CLIENT_NOTE_MAX + 1));
    expect(res.status).toBe(400);
    expect(await stored()).toBe("Keep me.");
  });
});

describe("where clients see it", () => {
  it("🔴 the booking page hands it to the booked screen", async () => {
    await save("Please arrive 10 minutes early.");
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.clientNote).toBe("Please arrive 10 minutes early.");
  });

  it("no note: null", async () => {
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.body.shop.clientNote).toBeNull();
  });

  it("🔴 the appointment page carries it", async () => {
    await save("Please arrive 10 minutes early.");
    const manageToken = randomToken();
    const startsAt = new Date(Date.now() + 3 * 24 * 3600_000);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Casey",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        manageToken,
      },
    });
    const res = await request(app).get(`/api/book/manage/${manageToken}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.clientNote).toBe("Please arrive 10 minutes early.");
  });
});
