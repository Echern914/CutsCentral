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

describe("service order within a group", () => {
  it("GET returns serviceIds in the saved order; re-saving reversed flips it", async () => {
    const create = await createGroup({
      name: "Ordered set",
      serviceIds: [serviceBId, serviceAId], // B first, deliberately
    });
    expect(create.status).toBe(201);
    const groupId = create.body.id as string;

    let found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.serviceIds).toEqual([serviceBId, serviceAId]);

    // Reorder: A first now.
    const patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ serviceIds: [serviceAId, serviceBId] });
    expect(patch.status).toBe(200);
    found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.serviceIds).toEqual([serviceAId, serviceBId]);

    await request(app).delete(`/api/booking/groups/${groupId}`).set("Cookie", cookie);
  });
});

// REGRESSION - Drick's "hours keep resetting": the dashboard used to send the
// FULL group form on every save, so a Save from a stale editor overwrote
// hoursWindows (an untouched all-Open grid serialized to {} and CLEARED the
// configured windows). The web client now PATCHes only the fields the barber
// changed; these lock the API contract that makes that safe: a field ABSENT
// from the PATCH body is never touched.
describe("group hours survive unrelated PATCHes", () => {
  const hoursWindows = { "1": [{ s: 600, e: 840 }], "2": [{ s: 600, e: 840 }] }; // Mon+Tue 10:00-14:00

  it("membership-only, name-only, caps-only, and hours-only PATCHes each touch only their field", async () => {
    const create = await createGroup({
      name: "After hours",
      hoursWindows,
      serviceIds: [serviceAId],
    });
    expect(create.status).toBe(201);
    const groupId = create.body.id as string;

    // Membership-only PATCH (add B) - the exact save the barber makes when
    // editing which services are in the group.
    let patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ serviceIds: [serviceAId, serviceBId] });
    expect(patch.status).toBe(200);
    let found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.hoursWindows).toEqual(hoursWindows);
    expect(found.serviceIds).toEqual([serviceAId, serviceBId]);

    // Name-only PATCH.
    patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ name: "After hours (renamed)" });
    expect(patch.status).toBe(200);
    found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.name).toBe("After hours (renamed)");
    expect(found.hoursWindows).toEqual(hoursWindows);
    expect(found.serviceIds).toEqual([serviceAId, serviceBId]); // members untouched too

    // Caps-only PATCH.
    patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ maxPerDay: 4 });
    expect(patch.status).toBe(200);
    found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.maxPerDay).toBe(4);
    expect(found.hoursWindows).toEqual(hoursWindows);

    // Hours-only PATCH updates hours and leaves membership alone.
    const newWindows = { "5": [{ s: 540, e: 720 }] }; // Fri 9:00-12:00
    patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ hoursWindows: newWindows });
    expect(patch.status).toBe(200);
    found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.hoursWindows).toEqual(newWindows);
    expect(found.serviceIds).toEqual([serviceAId, serviceBId]);

    // Explicit {} clears - the documented "every day back to Open" intent.
    patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ hoursWindows: {} });
    expect(patch.status).toBe(200);
    found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.hoursWindows).toEqual({});

    await request(app).delete(`/api/booking/groups/${groupId}`).set("Cookie", cookie);
  });

  it("an empty PATCH body changes nothing (and 200s)", async () => {
    const create = await createGroup({
      name: "No-op",
      hoursWindows,
      serviceIds: [serviceAId],
    });
    expect(create.status).toBe(201);
    const groupId = create.body.id as string;

    const patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({});
    expect(patch.status).toBe(200);
    const found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.name).toBe("No-op");
    expect(found.hoursWindows).toEqual(hoursWindows);
    expect(found.serviceIds).toEqual([serviceAId]);

    await request(app).delete(`/api/booking/groups/${groupId}`).set("Cookie", cookie);
  });
});

describe("group membership claims skip soft-deleted services", () => {
  it("a deleted service id in serviceIds is dropped on create AND on PATCH", async () => {
    // A service that's been removed from the shop (soft delete: active=false).
    const deletedId = await createService("Old fade", 30, 25);
    const del = await request(app)
      .delete(`/api/booking/services/${deletedId}`)
      .set("Cookie", cookie);
    expect(del.status).toBe(200);

    // Create: the deleted id is silently dropped, like a foreign id.
    const create = await createGroup({
      name: "Live members only",
      serviceIds: [serviceAId, deletedId],
    });
    expect(create.status).toBe(201);
    const groupId = create.body.id as string;
    let found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.serviceIds).toEqual([serviceAId]);
    expect(await serviceGroupIdOf(deletedId)).toBeNull();

    // PATCH (the stale-client shape): still dropped, live ids still claimed.
    const patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ serviceIds: [serviceAId, serviceBId, deletedId] });
    expect(patch.status).toBe(200);
    found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.serviceIds).toEqual([serviceAId, serviceBId]);
    expect(await serviceGroupIdOf(deletedId)).toBeNull();

    await request(app).delete(`/api/booking/groups/${groupId}`).set("Cookie", cookie);
  });

  it("a member deactivated AFTER joining keeps its membership through a serviceIds PATCH", async () => {
    // slots.ts (group-cap accounting) deliberately does NOT filter members by
    // active: a deactivated member's live BOOKED/PENDING appointments must
    // still consume the group's maxPerDay/maxConcurrent. The claim filter
    // skips inactive ids, so if the RELEASE step didn't skip them too, every
    // membership PATCH would silently evict the member and void those caps.
    const retiredId = await createService("Retired perm", 45, 60);
    const create = await createGroup({
      name: "Cap keepers",
      maxConcurrent: 1,
      serviceIds: [serviceAId, retiredId],
    });
    expect(create.status).toBe(201);
    const groupId = create.body.id as string;
    expect(await serviceGroupIdOf(retiredId)).toBe(groupId);

    // The barber retires the service while it's a member...
    const del = await request(app)
      .delete(`/api/booking/services/${retiredId}`)
      .set("Cookie", cookie);
    expect(del.status).toBe(200);
    // (GET /groups hides inactive members, but the DB row keeps the link.)
    expect(await serviceGroupIdOf(retiredId)).toBe(groupId);

    // ...then reorders/edits membership from the dashboard. The inactive
    // member must survive: not claimable, but not evicted either.
    const patch = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ serviceIds: [serviceBId, serviceAId] });
    expect(patch.status).toBe(200);
    const found = (await listGroups()).find((g) => g.id === groupId)!;
    expect(found.serviceIds).toEqual([serviceBId, serviceAId]);
    expect(await serviceGroupIdOf(retiredId)).toBe(groupId);

    // An explicit clear keeps it too — [] means "no ACTIVE members".
    const clear = await request(app)
      .patch(`/api/booking/groups/${groupId}`)
      .set("Cookie", cookie)
      .send({ serviceIds: [] });
    expect(clear.status).toBe(200);
    expect(await serviceGroupIdOf(serviceAId)).toBeNull();
    expect(await serviceGroupIdOf(serviceBId)).toBeNull();
    expect(await serviceGroupIdOf(retiredId)).toBe(groupId);

    // DELETING the group is the one detach-all: a dead group applies no caps,
    // so keeping the link would be pointless (slots.ts requires active:true
    // on the group itself).
    await request(app).delete(`/api/booking/groups/${groupId}`).set("Cookie", cookie);
    expect(await serviceGroupIdOf(retiredId)).toBeNull();
  });
});
