import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { noteLines } from "../engines/bookingIntake.js";

/**
 * GET /api/barber/notes-ahead - the dashboard bell's "what they asked for,
 * before they walk in" (X and Drick, 2026-10-16).
 *
 *  - only the next 12 hours, and only appointments that carry a note;
 *  - the client's own words, and the note on the booking;
 *  - WHOSE: the seat's own chair; the owner also gets chairs no login holds.
 *    Never a colleague's chair - their clients' words are theirs.
 */
const app = createApp();
const emails: string[] = [];
let ownerCookie: string;
let barberCookie: string;
let shopId: string;
let ownerChair: string; // no login holds it: the owner's
let barberChair: string; // the invited barber's
let serviceId: string;

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

const inHours = (h: number) => new Date(Date.now() + h * 3600_000);
async function book(staffId: string, at: Date, firstName: string, extra: { intake?: unknown; notes?: string } = {}) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName,
      status: "BOOKED",
      startsAt: at,
      endsAt: new Date(at.getTime() + 30 * 60_000),
      manageToken: randomToken(16),
      ...(extra.intake ? { intake: extra.intake as never } : {}),
      ...(extra.notes ? { notes: extra.notes } : {}),
    },
  });
}
const said = (value: string, kind = "textarea") => [{ questionId: "q", label: "Anything I should know?", kind, value }];
const notesFor = async (cookie: string) => {
  const res = await request(app).get("/api/barber/notes-ahead").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.items as { clientName: string; clientWrote: string | null; bookingNote: string | null; href: string }[];
};

beforeAll(async () => {
  const owner = await signup("na-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: "Notes Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ bookingMode: "native", timezone: "UTC" });
  ownerChair = (await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Owner" })).body.id;
  barberChair = (await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Jay" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", ownerCookie)
      .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [ownerChair, barberChair] })
  ).body.id;
  const barber = await signup("na-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER", staffId: barberChair } });
  // The mirror the real linking paths keep (services/staffUserLink.ts).
  await prisma.staff.update({ where: { id: barberChair }, data: { userId: barber.userId } });

  await book(ownerChair, inHours(1), "Marcus", { intake: said("Low fade, keep the top long") });
  await book(ownerChair, inHours(2), "Plain");
  await book(ownerChair, inHours(3), "Address", { intake: said("1 Main St", "address") });
  await book(ownerChair, inHours(30), "Tomorrow", { intake: said("Too far ahead") });
  await book(barberChair, inHours(2), "Tasha", { notes: "Bring the #2 guard" });
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

describe("notes before the client walks in", () => {
  it("🔴 the owner sees the notes on their own chair - the words, and a link to the appointment", async () => {
    const items = await notesFor(ownerCookie);
    expect(items.map((i) => i.clientName)).toEqual(["Marcus"]);
    expect(items[0]!.clientWrote).toBe("Low fade, keep the top long");
    expect(items[0]!.href).toMatch(/^\/dashboard\/booking\?tab=Appointments&appointment=.+&day=\d{4}-\d{2}-\d{2}$/);
  });

  it("🔴 a barber sees only their own chair's - never a colleague's clients' words", async () => {
    const items = await notesFor(barberCookie);
    expect(items.map((i) => i.clientName)).toEqual(["Tasha"]);
    expect(items[0]!.bookingNote).toBe("Bring the #2 guard");
    expect(JSON.stringify(items)).not.toContain("Low fade");
  });

  it("the owner doesn't get a chair someone else's login holds", async () => {
    expect((await notesFor(ownerCookie)).map((i) => i.clientName)).not.toContain("Tasha");
  });
});

describe("the Next up alert's note lines", () => {
  it("puts the client's words first, then the booking note, each clipped", () => {
    expect(noteLines({ intake: said("Low fade"), notes: "Bring the #2 guard" })).toBe(
      "They wrote: Low fade\nNote: Bring the #2 guard",
    );
    expect(noteLines({ intake: said("1 Main St", "address"), notes: null })).toBeNull();
    expect(noteLines({ intake: said("x".repeat(400)), notes: null })!.length).toBeLessThan(180);
  });
});
