import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * A NATIVE shop's calendar must show its synced Acuity/Square appointments.
 *
 * A shop mid-transition still takes bookings in Acuity, and since the
 * visit-busy fix those Visits BLOCK native slots shop-wide — but the agenda's
 * native branch only ever returned Appointment rows, so the barber saw a
 * half-empty ChairBack calendar plus unexplained dead slots and reported it as
 * "it's not syncing my Acuity". Locks:
 *   1. an external Visit appears on a native shop's agenda, badged + read-only;
 *   2. a Visit PROMOTED from a native appointment does NOT double-render (its
 *      Appointment row is already there);
 *   3. the external row still shows when the calendar is filtered to one
 *      barber — a Visit has no staff and blocks everyone's slots, so hiding it
 *      would recreate the same mystery one level down.
 */
const app = createApp();

const password = "correct horse battery staple";
const DAY_MS = 24 * 60 * 60 * 1000;
const utcMidnightPlus = (days: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
};
const at = (base: Date, h: number, m = 0) =>
  new Date(base.getTime() + (h * 60 + m) * 60 * 1000);

let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;
let email: string;
const tomorrow = utcMidnightPlus(1);

type AgendaItem = {
  id: string;
  source: string;
  syncedExternal?: boolean;
  start: string;
  clientName: string;
  serviceName: string | null;
};

async function agenda(staffFilter?: string): Promise<AgendaItem[]> {
  const res = await request(app)
    .get("/api/booking/agenda")
    .query({
      from: tomorrow.toISOString(),
      to: new Date(tomorrow.getTime() + DAY_MS).toISOString(),
      ...(staffFilter ? { staffId: staffFilter } : {}),
    })
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.agenda as AgendaItem[];
}

beforeAll(async () => {
  email = `agendasync-${randomToken(6)}@test.chairback`;
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Agenda Sync", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Agenda Sync Cuts", smsAttested: true });
  // Native booking mode: the branch under test.
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC" });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  shopId = me.body.id as string;

  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 60, price: 30 },
    select: { id: true },
  });
  serviceId = service.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });

  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `agendasync-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Legacy",
      lastName: "Client",
    },
    select: { id: true },
  });
  clientId = client.id;

  // (1) The external Acuity booking: no native Appointment behind it.
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acu-${randomToken(6)}`,
      status: "SCHEDULED",
      scheduledAt: at(tomorrow, 10),
      endAt: at(tomorrow, 11),
      serviceName: "Acuity Fade",
    },
  });

  // (2) A native appointment AND the Visit promoted from it — the pair that
  // must render exactly once (as the Appointment).
  const nativeAppt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Native",
      lastName: "Booking",
      status: "BOOKED",
      startsAt: at(tomorrow, 13),
      endsAt: at(tomorrow, 14),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      // Exactly how appointmentPromotion.ts keys a promoted visit.
      acuityAppointmentId: `booking:${nativeAppt.id}`,
      status: "SCHEDULED",
      scheduledAt: at(tomorrow, 13),
      endAt: at(tomorrow, 14),
      appointment: { connect: { id: nativeAppt.id } },
    },
  });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("native shop agenda: synced Acuity/Square appointments", () => {
  it("shows the external visit, badged and read-only", async () => {
    const rows = await agenda();
    const external = rows.find((r) => r.serviceName === "Acuity Fade");
    expect(external, "the Acuity booking must appear on the native calendar").toBeDefined();
    expect(external!.source).toBe("visit"); // row actions are gated off "appointment"
    expect(external!.syncedExternal).toBe(true); // drives the "Synced" badge
    expect(external!.clientName).toBe("Legacy Client");
    expect(external!.start).toBe(at(tomorrow, 10).toISOString());
  });

  it("does not double-render a visit promoted from a native appointment", async () => {
    const rows = await agenda();
    const atOnePm = rows.filter((r) => r.start === at(tomorrow, 13).toISOString());
    expect(atOnePm).toHaveLength(1);
    expect(atOnePm[0]!.source).toBe("appointment"); // the actionable row wins
    expect(atOnePm[0]!.syncedExternal).toBeUndefined();
  });

  it("keeps the external visit visible when filtering to one barber", async () => {
    // A Visit carries no staffId and blocks EVERY barber's slots, so it stays
    // on a filtered calendar rather than becoming an invisible blocker.
    const rows = await agenda(staffId);
    expect(rows.some((r) => r.serviceName === "Acuity Fade")).toBe(true);
  });

  // A client who cancels in Acuity must come OFF the schedule. The webhook
  // (appointment.canceled) flips the Visit to CANCELED and the slot-busy guard
  // already ignored it — but the agenda had NO status filter, so the row kept
  // rendering (dimmed) and the barber still saw someone who wasn't coming.
  it("drops a CANCELED synced visit from the calendar", async () => {
    const canceled = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `acu-${randomToken(6)}`,
        status: "CANCELED",
        scheduledAt: at(tomorrow, 15),
        endAt: at(tomorrow, 16),
        serviceName: "Cancelled Fade",
      },
    });
    const rows = await agenda();
    expect(rows.some((r) => r.serviceName === "Cancelled Fade")).toBe(false);
    await prisma.visit.delete({ where: { id: canceled.id } });
  });

  // RESCHEDULED is the same problem wearing a different hat: Acuity sends the
  // moved appointment as its OWN row, so keeping the old one shows the client
  // twice — once at a time they are not coming.
  it("drops a RESCHEDULED synced visit (the new time arrives as its own row)", async () => {
    const moved = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `acu-${randomToken(6)}`,
        status: "RESCHEDULED",
        scheduledAt: at(tomorrow, 17),
        endAt: at(tomorrow, 18),
        serviceName: "Moved Fade",
      },
    });
    const rows = await agenda();
    expect(rows.some((r) => r.serviceName === "Moved Fade")).toBe(false);
    await prisma.visit.delete({ where: { id: moved.id } });
  });
});
