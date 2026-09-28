import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { apiEnv, encrypt, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { acuityAppointmentTypeSchema } from "../acuity/types.js";
import { applyServiceImport } from "../engines/acuityServiceImport.js";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";

/**
 * "Import services from Acuity", end to end: the real Acuity client and the
 * real stored connection, with only Acuity's HTTP answer made up. The owner's
 * promises: a preview first, then only what they saw is added, nothing that
 * is already there is touched, and doing it twice adds nothing.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let otherCookie: string;
let shopId: string;
let otherShopId: string;
let activeStaff: string[] = [];
let trimsGroupId: string;
let existingId: string;

// A made-up Acuity menu covering every rule.
const TYPES = [
  {
    id: 101,
    name: "Classic Trim",
    active: true,
    duration: 30,
    price: "35.00",
    category: "Trims",
    color: "#F7A5A5",
    private: false,
    type: "service",
    description: "<p>Clippers &amp; scissors.</p><p>Ends with a <b>hot towel</b>.</p>",
  },
  { id: 102, name: "Beard Trim", active: true, duration: 20, price: "15.00", category: "Beard", private: false, type: "service" },
  { id: 103, name: "Wash and Style", active: true, duration: 45, price: "50.00", category: "Styling", color: "#AAAAAA", private: false, type: "service" },
  { id: 104, name: "Scalp Treatment", active: true, duration: 30, price: "40.00", category: "", private: false, type: "service" },
  { id: 105, name: "Old Special", active: false, duration: 30, price: "20.00", category: "Trims", private: false, type: "service" },
  { id: 106, name: "Friends Rate", active: true, duration: 30, price: "10.00", category: "Trims", private: true, type: "service" },
  { id: 107, name: "Styling Class", active: true, duration: 90, price: "80.00", category: "Styling", private: false, type: "class", classSize: 6 },
  { id: 108, name: "All-day Locs", active: true, duration: 720, price: "300.00", category: "Styling", private: false, type: "service" },
];
const NEW_IDS = ["101", "103", "104"];

let acuityStatus = 200;
const fetchMock = vi.fn(async (url: string) => {
  if (!String(url).endsWith("/appointment-types")) return new Response("{}", { status: 404 });
  if (acuityStatus !== 200) return new Response("{}", { status: acuityStatus });
  return new Response(JSON.stringify(TYPES), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Import Owner", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function makeShop(): Promise<{ cookie: string; shopId: string }> {
  const email = `svcimport-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const c = await signup(email);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: "Import Test Shop", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie: c, shopId: shop.body.id as string };
}

beforeAll(async () => {
  ({ cookie, shopId } = await makeShop());
  ({ cookie: otherCookie, shopId: otherShopId } = await makeShop());

  const a = await prisma.staff.create({ data: { shopId, name: "Dee" } });
  const b = await prisma.staff.create({ data: { shopId, name: "Kai" } });
  await prisma.staff.create({ data: { shopId, name: "Former", active: false } });
  activeStaff = [a.id, b.id].sort();

  const trims = await prisma.serviceGroup.create({ data: { shopId, name: "Trims" } });
  trimsGroupId = trims.id;
  await prisma.service.create({
    data: { shopId, name: "House Special", durationMin: 40, price: 45, serviceGroupId: trimsGroupId },
  });
  // Already in ChairBack under different spacing and case, with the owner's
  // own length and price - which the import must never touch.
  const existing = await prisma.service.create({
    data: { shopId, name: "  beard   TRIM ", durationMin: 25, price: 18 },
  });
  existingId = existing.id;

  await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: "acct_import_test",
      accessToken: encrypt("test-token", apiEnv().TOKEN_ENCRYPTION_KEY),
    },
  });
});

beforeEach(() => {
  acuityStatus = 200;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  // Put the shop back to its seeded state between tests.
  if (shopId) {
    await prisma.service.deleteMany({
      where: { shopId, name: { notIn: ["House Special", "  beard   TRIM "] } },
    });
    await prisma.serviceGroup.deleteMany({ where: { shopId, id: { not: trimsGroupId } } });
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

const serviceCount = (id: string) => prisma.service.count({ where: { shopId: id } });

describe("GET /api/booking/acuity/service-import (the preview)", () => {
  it("requires a signed-in manager", async () => {
    const res = await request(app).get("/api/booking/acuity/service-import");
    expect(res.status).toBe(401);
  });

  it("lists every Acuity service with its length, price and category, marked against the shop, and writes nothing", async () => {
    const before = await serviceCount(shopId);
    const res = await request(app).get("/api/booking/acuity/service-import").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      (res.body.rows as { acuityId: string; status: string }[]).map((r) => [r.acuityId, r]),
    );
    expect(byId["101"]).toEqual({
      acuityId: "101",
      name: "Classic Trim",
      durationMin: 30,
      price: 35,
      category: "Trims",
      status: "new",
    });
    expect(Object.fromEntries(Object.entries(byId).map(([id, r]) => [id, r.status]))).toEqual({
      "101": "new",
      "102": "exists",
      "103": "new",
      "104": "new",
      "105": "inactive",
      "106": "private",
      "107": "class",
      "108": "bad_length",
    });
    // "Trims" already has a group; only "Styling" would be made.
    expect(res.body.newGroups).toEqual(["Styling"]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/appointment-types$/),
      expect.anything(),
    );
    expect(await serviceCount(shopId)).toBe(before);
  });

  it("a shop with no Acuity connection gets a plain not-connected answer", async () => {
    const res = await request(app).get("/api/booking/acuity/service-import").set("Cookie", otherCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("acuity_not_connected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an Acuity login that no longer works is a 502, not a crash", async () => {
    acuityStatus = 401;
    const res = await request(app).get("/api/booking/acuity/service-import").set("Cookie", cookie);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("acuity_unavailable");
  });
});

describe("POST /api/booking/acuity/service-import (the import)", () => {
  const importIds = (ids: string[], c = cookie) =>
    request(app).post("/api/booking/acuity/service-import").set("Cookie", c).send({ acuityIds: ids });

  it("creates the new services, offered by every active staff member, filed under their groups", async () => {
    const res = await importIds(NEW_IDS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 3, groupsCreated: 1 });

    const rows = await prisma.service.findMany({
      where: { shopId, name: { in: ["Classic Trim", "Wash and Style", "Scalp Treatment"] } },
      include: { staff: { select: { staffId: true } } },
    });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    const styling = await prisma.serviceGroup.findFirstOrThrow({ where: { shopId, name: "Styling" } });

    expect(by["Classic Trim"]).toMatchObject({
      durationMin: 30,
      description: "Clippers & scissors.\nEnds with a hot towel.",
      color: "red",
      active: true,
      offeredByAll: true,
      serviceGroupId: trimsGroupId,
      // After the one member "Trims" already had.
      groupSortOrder: 1,
    });
    expect(Number(by["Classic Trim"]!.price)).toBe(35);
    expect(by["Wash and Style"]).toMatchObject({ serviceGroupId: styling.id, color: null });
    expect(by["Scalp Treatment"]).toMatchObject({ serviceGroupId: null, description: null });
    for (const r of rows) {
      expect(r.staff.map((s) => s.staffId).sort()).toEqual(activeStaff);
    }
  });

  it("never edits a service that is already there", async () => {
    const before = await prisma.service.findUniqueOrThrow({ where: { id: existingId } });
    await importIds(["102", ...NEW_IDS]);
    const after = await prisma.service.findUniqueOrThrow({ where: { id: existingId } });
    expect(after).toEqual(before);
    expect(await prisma.service.count({ where: { shopId, name: "Beard Trim" } })).toBe(0);
  });

  it("running it again imports nothing new", async () => {
    await importIds(NEW_IDS);
    const count = await serviceCount(shopId);
    const groups = await prisma.serviceGroup.count({ where: { shopId } });

    const again = await importIds(NEW_IDS);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ created: 0, groupsCreated: 0 });
    expect(await serviceCount(shopId)).toBe(count);
    expect(await prisma.serviceGroup.count({ where: { shopId } })).toBe(groups);

    // And the preview now says so.
    const preview = await request(app).get("/api/booking/acuity/service-import").set("Cookie", cookie);
    const statuses = (preview.body.rows as { acuityId: string; status: string }[])
      .filter((r) => NEW_IDS.includes(r.acuityId))
      .map((r) => r.status);
    expect(statuses).toEqual(["exists", "exists", "exists"]);
    expect(preview.body.newGroups).toEqual([]);
  });

  it("inactive, private, class and unbookable-length types are never created, even when asked for by id", async () => {
    const before = await serviceCount(shopId);
    const res = await importIds(["105", "106", "107", "108"]);
    expect(res.body).toEqual({ created: 0, groupsCreated: 0 });
    expect(await serviceCount(shopId)).toBe(before);
  });

  it("only what the owner confirmed is created", async () => {
    const res = await importIds(["104"]);
    expect(res.body).toEqual({ created: 1, groupsCreated: 0 });
    expect(await prisma.service.count({ where: { shopId, name: "Classic Trim" } })).toBe(0);
    expect(await prisma.service.count({ where: { shopId, name: "Scalp Treatment" } })).toBe(1);
  });

  it("a shop with no Acuity connection imports nothing", async () => {
    const res = await importIds(NEW_IDS, otherCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("acuity_not_connected");
    expect(await serviceCount(otherShopId)).toBe(0);
  });

  it("an Acuity login that no longer works imports nothing", async () => {
    acuityStatus = 401;
    const before = await serviceCount(shopId);
    const res = await importIds(NEW_IDS);
    expect(res.status).toBe(502);
    expect(await serviceCount(shopId)).toBe(before);
  });

  it("all or nothing: a failure part-way through leaves no services and no groups behind", async () => {
    // Refuse the LAST new service (Acuity order: Classic Trim, Wash and Style
    // - which creates the "Styling" group - then Scalp Treatment), so two
    // services and a group are already written when it fails. Scoped to this
    // shop and name, and dropped in `finally`.
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS svcimport_test_fail ON "Service"`);
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION svcimport_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW."shopId" = '${shopId}' AND NEW.name = 'Scalp Treatment' THEN
           RAISE EXCEPTION 'injected failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER svcimport_test_fail BEFORE INSERT ON "Service" FOR EACH ROW EXECUTE FUNCTION svcimport_test_fail()`,
    );
    try {
      const services = await serviceCount(shopId);
      const groups = await prisma.serviceGroup.count({ where: { shopId } });
      const res = await importIds(NEW_IDS);
      expect(res.status).toBe(500);
      expect(await serviceCount(shopId)).toBe(services);
      expect(await prisma.serviceGroup.count({ where: { shopId } })).toBe(groups);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS svcimport_test_fail ON "Service"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS svcimport_test_fail()`);
    }
  });

  it("two imports at once create each service once", async () => {
    const types = acuityAppointmentTypeSchema.array().parse(TYPES);
    const { results, settledEarly } = await raceBehindAdvisoryLock(`svcimport:${shopId}`, [
      () => applyServiceImport(shopId, types, NEW_IDS),
      () => applyServiceImport(shopId, types, NEW_IDS),
    ]);
    // Both really queued on the lock - the assertion a missing lock fails.
    expect(settledEarly).toBe(0);
    const created = results.map((r) => (r.status === "fulfilled" ? r.value.created : -1));
    expect(created.sort()).toEqual([0, 3]);
    expect(await prisma.service.count({ where: { shopId, name: "Classic Trim" } })).toBe(1);
    expect(await prisma.serviceGroup.count({ where: { shopId, name: "Styling" } })).toBe(1);
  });
});
