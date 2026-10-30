import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * GET /api/book/:slug/day - service groups never vanish.
 *
 * A barber made two groups, "First Time Clients" (2 services) and "Clients
 * Only" (6), and the booking page showed ONE dropdown: "Clients Only · 5
 * services". The day view used to return only groups with an opening that
 * day, so a group whose services keep narrow hours (a new-client offer) was
 * simply gone on every day it was shut - and read as the second group having
 * replaced the first.
 *
 * Now: every active group with an offered, public member comes back. Groups
 * with times are `bundles` exactly as before; a group with none rides in
 * `closedGroups`, each member with `slots: []`. Hidden services stay off the
 * page (which is why the dashboard's count can be higher - it now says so),
 * and a day with nothing bookable still has empty `bundles` + `ungrouped`, so
 * the page's booked-out screen still shows.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let slug: string;
const ids: Record<string, string> = {};
const groupIds: Record<string, string> = {};

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** An open day for everyone (bar the "First Time" services). */
const tomorrow = isoDay(Date.now() + DAY);
/** A day the only barber does not work: nothing is bookable. */
const shutDay = isoDay(Date.now() + 2 * DAY);
const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

async function signup(name: string): Promise<string> {
  const email = `dayclosed-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function addService(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name, durationMin: 30, price: 40, offeredByAll: true, ...extra });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

async function addGroup(name: string, serviceIds: string[], sortOrder: number): Promise<string> {
  const r = await request(app)
    .post("/api/booking/groups")
    .set("Cookie", cookie)
    .send({ name, serviceIds, sortOrder });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

interface DaySvc {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  durationMin: number;
  slots: unknown[];
}
interface DayGroup {
  id: string;
  name: string;
  position: number;
  services: DaySvc[];
}
interface DayBody {
  bundles: DayGroup[];
  closedGroups: DayGroup[];
  ungrouped: DaySvc[];
}

async function day(date: string): Promise<DayBody> {
  const r = await request(app).get(`/api/book/${slug}/day?date=${date}`);
  expect(r.status).toBe(200);
  return r.body as DayBody;
}

beforeAll(async () => {
  cookie = await signup("Barber");
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Closed Groups ${randomToken(4)}`, smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  slug = shop.body.slug;
  await prisma.shop.update({
    where: { id: shopId },
    data: { timezone: "UTC", bookingMode: "native", publicPageEnabled: true },
  });
  const staffId = (
    await prisma.staff.create({ data: { shopId, name: "Barber" }, select: { id: true } })
  ).id;
  // Works every day except shutDay's weekday.
  for (let weekday = 0; weekday < 7; weekday++) {
    if (weekday === weekdayOf(shutDay)) continue;
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 0, endMin: 24 * 60 },
    });
  }

  // "First Time Clients": both services are shut on tomorrow's weekday (a
  // narrow new-client offer) - so the whole group has no times tomorrow.
  ids.firstCut = await addService("First Cut", {
    description: "New clients only.\nINCLUDES: consult",
  });
  ids.firstBeard = await addService("First Beard");
  for (const id of [ids.firstCut, ids.firstBeard]) {
    await prisma.service.update({
      where: { id },
      data: { hoursWindows: { [String(weekdayOf(tomorrow))]: [] } },
    });
  }

  // "Clients Only": two open services and one the barber has hidden.
  ids.regularCut = await addService("Regular Cut");
  ids.regularBeard = await addService("Regular Beard");
  ids.privateCut = await addService("Private Cut");
  await prisma.service.update({ where: { id: ids.privateCut }, data: { visibility: "hidden" } });

  // "Retired": its only service is offered by a barber who has left. Not
  // bookable on ANY day, so it stays off the page even as a closed group.
  const gone = await prisma.staff.create({
    data: { shopId, name: "Former", active: false },
    select: { id: true },
  });
  ids.retired = (
    await prisma.service.create({
      data: { shopId, name: "Retired Cut", durationMin: 30, price: 40, offeredByAll: false },
      select: { id: true },
    })
  ).id;
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: ids.retired, staffId: gone.id },
  });

  groupIds.first = await addGroup("First Time Clients", [ids.firstBeard!, ids.firstCut!], 0);
  groupIds.clients = await addGroup(
    "Clients Only",
    [ids.regularCut!, ids.privateCut!, ids.regularBeard!],
    1,
  );
  groupIds.retired = await addGroup("Retired", [ids.retired!], 2);
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

describe("GET /:slug/day - a group with no times that day", () => {
  it("🔴 is still returned, as a CLOSED group with every offered member and no slots", async () => {
    const body = await day(tomorrow);
    expect(body.closedGroups.map((g) => g.name)).toEqual(["First Time Clients"]);
    const first = body.closedGroups[0]!;
    // The barber's in-group order, and each card with its day price/length.
    expect(first.services.map((s) => s.name)).toEqual(["First Beard", "First Cut"]);
    for (const s of first.services) {
      expect(s.slots).toEqual([]);
      expect(s.price).toBe(40);
      expect(s.durationMin).toBe(30);
    }
    expect(first.services[1]!.description).toBe("New clients only.\nINCLUDES: consult");
    // Not in the open list, and its members are not loose under "More services".
    expect(body.bundles.map((b) => b.name)).toEqual(["Clients Only"]);
    expect(body.ungrouped).toEqual([]);
  });

  it("carries the barber's group order, so open and closed groups interleave as arranged", async () => {
    const body = await day(tomorrow);
    expect(body.closedGroups[0]!.position).toBe(0);
    expect(body.bundles[0]!.position).toBe(1);
  });

  it("a group nobody active offers stays off the page", async () => {
    const body = await day(tomorrow);
    const names = [...body.bundles, ...body.closedGroups].map((g) => g.name);
    expect(names).not.toContain("Retired");
  });

  it("an open group lists only its members with times, as before", async () => {
    const body = await day(tomorrow);
    const clients = body.bundles.find((b) => b.name === "Clients Only")!;
    expect(clients.services.map((s) => s.name)).toEqual(["Regular Cut", "Regular Beard"]);
    for (const s of clients.services) expect(s.slots.length).toBeGreaterThan(0);
  });
});

describe("hidden members", () => {
  it("🔴 the dashboard counts a hidden member; the booking page never shows it", async () => {
    const dash = await request(app).get("/api/booking/groups").set("Cookie", cookie);
    expect(dash.status).toBe(200);
    const clients = (dash.body.groups as { id: string; serviceIds: string[] }[]).find(
      (g) => g.id === groupIds.clients,
    )!;
    // 3 on the dashboard (the web row now says "3 services (1 hidden)")...
    expect(clients.serviceIds).toHaveLength(3);
    expect(clients.serviceIds).toContain(ids.privateCut);

    // ...2 on the booking page, open day or shut.
    for (const date of [tomorrow, shutDay]) {
      const body = await day(date);
      const all = [
        ...body.bundles.flatMap((b) => b.services),
        ...body.closedGroups.flatMap((g) => g.services),
        ...body.ungrouped,
      ];
      expect(all.map((s) => s.id)).not.toContain(ids.privateCut);
    }
  });

  it("a group whose ONLY public member is hidden is not shown at all", async () => {
    const solo = await addGroup("Private Only", [ids.privateCut!], 3);
    const body = await day(tomorrow);
    expect([...body.bundles, ...body.closedGroups].map((g) => g.id)).not.toContain(solo);
    // Put the hidden service back where the other tests expect it.
    await request(app)
      .patch(`/api/booking/groups/${groupIds.clients}`)
      .set("Cookie", cookie)
      .send({ serviceIds: [ids.regularCut!, ids.privateCut!, ids.regularBeard!] });
    await request(app).delete(`/api/booking/groups/${solo}`).set("Cookie", cookie);
  });
});

describe("a day with nothing bookable", () => {
  it("🔴 still reads as empty (no bundles, no loose services) - closed groups carry no times", async () => {
    const body = await day(shutDay);
    expect(body.bundles).toEqual([]);
    expect(body.ungrouped).toEqual([]);
    // The groups are still there to read, all closed, in the barber's order.
    expect(body.closedGroups.map((g) => g.name)).toEqual(["First Time Clients", "Clients Only"]);
    const slots = body.closedGroups.flatMap((g) => g.services.flatMap((s) => s.slots));
    expect(slots).toEqual([]);
  });
});
