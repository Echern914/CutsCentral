import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * "Offered by all barbers" as a LIVE intent, not a creation-time snapshot. The
 * bug this guards: a service created as "offered by all" used to be stored as a
 * frozen list of the staff who existed then, so a barber added later never
 * offered it. With Service.offeredByAll, the ServiceStaff join is kept in sync -
 * new/reactivated active staff auto-join every offeredByAll service, and editing
 * to a hand-picked set opts back out.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
const emails: string[] = [];

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "OBA Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

/** The staffIds the GET reports for a given service (its ServiceStaff join). */
async function staffIdsFor(serviceId: string): Promise<string[]> {
  const res = await request(app).get("/api/booking/services").set("Cookie", cookie);
  expect(res.status).toBe(200);
  const svc = res.body.services.find((s: { id: string }) => s.id === serviceId);
  return (svc?.staffIds ?? []).slice().sort();
}
const sortedIds = (...ids: string[]) => ids.slice().sort();

let firstStaffId: string;

beforeAll(async () => {
  const email = `oba-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "OBA Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  firstStaffId = staff.body.id;
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

describe("service offeredByAll (live 'all barbers' intent)", () => {
  it("a new active barber auto-joins an offeredByAll service (the B3 fix)", async () => {
    // Create the service as offered-by-all with only Sam present.
    const created = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Fade", durationMin: 30, price: 40, offeredByAll: true });
    expect(created.status).toBe(201);
    const serviceId = created.body.id;
    expect(await staffIdsFor(serviceId)).toEqual([firstStaffId]);

    // Add a SECOND barber AFTER the service was created.
    const second = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", cookie)
      .send({ name: "Alex" });
    expect(second.status).toBe(201);

    // The new barber must now offer the service - the old snapshot behavior
    // would have left the join as just [Sam].
    expect(await staffIdsFor(serviceId)).toEqual(sortedIds(firstStaffId, second.body.id));
  });

  it("a hand-picked service does NOT pick up later-added barbers", async () => {
    const created = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Kids cut", durationMin: 20, price: 20, offeredByAll: false, staffIds: [firstStaffId] });
    expect(created.status).toBe(201);
    const serviceId = created.body.id;
    expect(await staffIdsFor(serviceId)).toEqual([firstStaffId]);

    const later = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", cookie)
      .send({ name: "Jordan" });
    expect(later.status).toBe(201);

    // Hand-picked stays hand-picked.
    expect(await staffIdsFor(serviceId)).toEqual([firstStaffId]);
  });

  it("editing a service to offeredByAll syncs it to all active staff", async () => {
    // Start hand-picked to just Sam.
    const created = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Lineup", durationMin: 15, price: 15, offeredByAll: false, staffIds: [firstStaffId] });
    const serviceId = created.body.id;
    expect((await staffIdsFor(serviceId)).length).toBe(1);

    // Flip to offeredByAll -> it should now include every active barber.
    const patch = await request(app)
      .patch(`/api/booking/services/${serviceId}`)
      .set("Cookie", cookie)
      .send({ offeredByAll: true });
    expect(patch.status).toBe(200);

    const allActive = await prisma.staff.findMany({
      where: { active: true, shop: { slug: (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.slug } },
      select: { id: true },
    });
    expect(await staffIdsFor(serviceId)).toEqual(allActive.map((s) => s.id).sort());
    expect(allActive.length).toBeGreaterThan(1); // proves it grabbed more than Sam
  });

  it("reactivating a barber re-joins them to offeredByAll services", async () => {
    const svc = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Hot towel", durationMin: 10, price: 10, offeredByAll: true });
    const serviceId = svc.body.id;

    // Add then deactivate a barber.
    const temp = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Temp" });
    const tempId = temp.body.id;
    expect(await staffIdsFor(serviceId)).toContain(tempId);
    await request(app).delete(`/api/booking/staff/${tempId}`).set("Cookie", cookie); // soft-delete

    // Reactivate -> the PATCH active:true path must re-link them.
    const reactivate = await request(app)
      .patch(`/api/booking/staff/${tempId}`)
      .set("Cookie", cookie)
      .send({ active: true });
    expect(reactivate.status).toBe(200);
    expect(await staffIdsFor(serviceId)).toContain(tempId);
  });
});
