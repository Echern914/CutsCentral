import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Service groups (Acuity-style): several services share ONE config - a common
 * available-hours window (same {weekday:[{s,e}]} shape as a service's own, and it
 * OVERRIDES each member's own hours) plus two booking caps (maxPerDay across the
 * shop-local day, maxConcurrent across overlapping bookings). Managed in the
 * dashboard Booking -> Services tab. Deleting a group SETS NULL on its members
 * (services survive). A shop with serviceGroupId null everywhere behaves exactly
 * as before - the whole point of the model.
 *
 * These cover the dashboard API only (POST/GET/PATCH/DELETE /api/booking/groups),
 * modeled on serviceAddons.test.ts: supertest + createApp(), a signup helper, a
 * native shop, staff + services, and afterAll cleanup by owner email.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let staffId: string;
let serviceAId: string;
let serviceBId: string;
const emails: string[] = [];

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Group Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function createService(name: string, durationMin: number, price: number): Promise<string> {
  const res = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name, durationMin, price, staffIds: [staffId] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createGroup(body: Record<string, unknown>) {
  return request(app).post("/api/booking/groups").set("Cookie", cookie).send(body);
}

async function listGroups() {
  const res = await request(app).get("/api/booking/groups").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.groups as {
    id: string;
    name: string;
    maxPerDay: number | null;
    maxConcurrent: number | null;
    hoursWindows: Record<string, { s: number; e: number }[]>;
    serviceIds: string[];
  }[];
}

// serviceGroupId as the dashboard /services endpoint reports it - the source of
// truth for "which group is this service in" (null = ungrouped).
async function serviceGroupIdOf(serviceId: string): Promise<string | null> {
  const res = await request(app).get("/api/booking/services").set("Cookie", cookie);
  expect(res.status).toBe(200);
  const svc = (res.body.services as { id: string; serviceGroupId: string | null }[]).find(
    (s) => s.id === serviceId,
  );
  return svc ? svc.serviceGroupId : null;
}

beforeAll(async () => {
  const email = `group-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Group Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  serviceAId = await createService("Haircut", 30, 35);
  serviceBId = await createService("Color", 60, 80);
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

describe("service groups CRUD round-trip", () => {
  it("creates with caps + hours + members, lists them back, patches, and deletes", async () => {
    const hoursWindows = { "1": [{ s: 600, e: 840 }] }; // Mondays 10:00-14:00
    const create = await createGroup({
      name: "Chemical services",
      maxPerDay: 5,
      maxConcurrent: 2,
      hoursWindows,
      serviceIds: [serviceAId, serviceBId],
    });
    expect(create.status).toBe(201);
    expect(typeof create.body.id).toBe("string");
    const groupId = create.body.id as string;

    // GET: the group appears with its caps, hoursWindows, and member serviceIds.
    let groups = await listGroups();
    let found = groups.find((g) => g.id === groupId)!;
    expect(found).toBeTruthy();
    expect(found.name).toBe("Chemical services");
    expect(found.maxPerDay).toBe(5);
    expect(found.maxConcurrent).toBe(2);
    expect(found.hoursWindows).toEqual(hoursWindows);
    expect([...found.serviceIds].sort()).toEqual([serviceAId, serviceBId].sort());

    // Members carry the group id on the services endpoint too.
    expect(await serviceGroupIdOf(serviceAId)).toBe(groupId);
    expect(await serviceGroupIdOf(serviceBId)).toBe(groupId);

    // PATCH: change a cap and reassign the member set to just service A.
    const patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ maxPerDay: 10, serviceIds: [serviceAId] });
    expect(patch.status).toBe(200);
    groups = await listGroups();
    found = groups.find((g) => g.id === groupId)!;
    expect(found.maxPerDay).toBe(10);
    expect(found.maxConcurrent).toBe(2); // untouched
    expect(found.serviceIds).toEqual([serviceAId]);
    // Service B was released by the reassignment.
    expect(await serviceGroupIdOf(serviceAId)).toBe(groupId);
    expect(await serviceGroupIdOf(serviceBId)).toBeNull();

    // DELETE: 200, and afterwards the group is gone from GET (soft-deleted) AND
    // its former member(s) have serviceGroupId null.
    const del = await request(app).delete(`/api/booking/groups/${groupId}`).set("Cookie", cookie);
    expect(del.status).toBe(200);
    groups = await listGroups();
    expect(groups.find((g) => g.id === groupId)).toBeUndefined();
    expect(await serviceGroupIdOf(serviceAId)).toBeNull();
    // Belt and suspenders: verify the detach at the DB layer too.
    const svcA = await prisma.service.findUnique({ where: { id: serviceAId } });
    expect(svcA!.serviceGroupId).toBeNull();
  });
});

describe("service groups membership reassignment", () => {
  it("PATCH serviceIds moves membership from A to B (A released, B claimed)", async () => {
    const create = await createGroup({ name: "Move set", serviceIds: [serviceAId] });
    expect(create.status).toBe(201);
    const groupId = create.body.id as string;
    expect(await serviceGroupIdOf(serviceAId)).toBe(groupId);
    expect(await serviceGroupIdOf(serviceBId)).toBeNull();

    const patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ serviceIds: [serviceBId] });
    expect(patch.status).toBe(200);

    // A is now ungrouped; B belongs to the group.
    expect(await serviceGroupIdOf(serviceAId)).toBeNull();
    expect(await serviceGroupIdOf(serviceBId)).toBe(groupId);

    // Confirm via GET that the group reports exactly [B].
    const groups = await listGroups();
    const found = groups.find((g) => g.id === groupId)!;
    expect(found.serviceIds).toEqual([serviceBId]);

    // Clean up so this group doesn't leak into other cases.
    await request(app).delete(`/api/booking/groups/${groupId}`).set("Cookie", cookie);
  });
});

describe("service groups validation", () => {
  it("rejects maxPerDay 0 (min is 1) with 400 invalid_input", async () => {
    const res = await createGroup({ name: "Bad cap", maxPerDay: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("rejects an inverted hours window (e <= s) with 400 invalid_input", async () => {
    const res = await createGroup({
      name: "Bad hours",
      hoursWindows: { "1": [{ s: 840, e: 600 }] }, // end before start
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });
});

describe("service groups tenant safety", () => {
  it("silently drops a foreign/bogus serviceId (no foreign row assigned)", async () => {
    // One real member (A) + one id that isn't a service in this shop. The bogus
    // id must be ignored: the group ends up with exactly the one real member, and
    // no other service is pulled in.
    const create = await createGroup({
      name: "Foreign guard",
      serviceIds: [serviceAId, "not-a-real-service-id"],
    });
    expect(create.status).toBe(201);
    const groupId = create.body.id as string;

    const groups = await listGroups();
    const found = groups.find((g) => g.id === groupId)!;
    // Exactly the real member - the bogus id assigned nothing.
    expect(found.serviceIds).toEqual([serviceAId]);
    expect(await serviceGroupIdOf(serviceAId)).toBe(groupId);
    // Service B (untouched, still ungrouped) confirms no stray assignment.
    expect(await serviceGroupIdOf(serviceBId)).toBeNull();

    await request(app).delete(`/api/booking/groups/${groupId}`).set("Cookie", cookie);
  });
});
