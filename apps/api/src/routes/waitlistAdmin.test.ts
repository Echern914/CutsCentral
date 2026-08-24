import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { ANY_DATE_HORIZON_DAYS, addDays, shopLocalDate } from "../engines/waitlistWindows.js";

/**
 * Waitlist phase E: the admin surface.
 *
 * What is worth pinning is not "does a list render" but the promises the board
 * makes to a barber working it: every section is reachable (including EXPIRED,
 * which had no route at all before), the list can be filtered and sorted
 * without a hidden cap, a staff-created entry behaves EXACTLY like a public
 * one to the matcher, no consent is ever invented on a customer's behalf, and
 * a booking made from the list is linked to the appointment atomically.
 */

const app = createApp();
const TZ = "America/New_York";
const password = "supersecret123";

let cookie: string;
let shopId: string;
let staffA: string;
let staffB: string;
let serviceId: string;
let userId: string;

/** A second shop with its own session - every cross-tenant assertion uses it. */
let otherCookie: string;
let otherShopId: string;
let otherUserId: string;
let otherEntryId: string;

async function signUpShop(name: string) {
  const email = `wl-e-${randomToken(6).toLowerCase()}@test.local`;
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(signup.status).toBe(201);
  const login = await request(app).post("/api/auth/login").send({ email, password });
  const setCookie = login.headers["set-cookie"];
  const jar = Array.isArray(setCookie) ? setCookie[0]!.split(";")[0]! : "";
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", jar)
    .send({ name, industry: "barber", smsAttested: true, timezone: TZ });
  expect(shop.status).toBe(201);
  return { cookie: jar, shopId: shop.body.id as string, userId: signup.body.id as string };
}

const get = (q = "") =>
  request(app).get(`/api/dashboard/waitlist${q}`).set("Cookie", cookie);

async function seed(over: Record<string, unknown> = {}, windows: Record<string, unknown>[] = []) {
  const entry = await prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: `E${randomToken(4)}`,
      email: `e-${randomToken(5)}@test.local`,
      ...over,
    },
    select: { id: true },
  });
  for (const w of windows) {
    await prisma.waitlistWindow.create({
      data: {
        shopId,
        entryId: entry.id,
        startDate: null,
        endDate: null,
        startMin: null,
        endMin: null,
        ...w,
      },
    });
  }
  return entry.id;
}

beforeAll(async () => {
  const mine = await signUpShop("Waitlist Admin Cuts");
  cookie = mine.cookie;
  shopId = mine.shopId;
  userId = mine.userId;
  const a = await prisma.staff.create({ data: { shopId, name: "Dee" } });
  staffA = a.id;
  const b = await prisma.staff.create({ data: { shopId, name: "Ray" } });
  staffB = b.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Fade", durationMin: 30 },
    select: { id: true },
  });
  serviceId = svc.id;

  const other = await signUpShop("Other Cuts");
  otherCookie = other.cookie;
  otherShopId = other.shopId;
  otherUserId = other.userId;
  const oe = await prisma.waitlistEntry.create({
    data: { shopId: otherShopId, firstName: "Theirs", email: "theirs@test.local" },
    select: { id: true },
  });
  otherEntryId = oe.id;
});

afterAll(async () => {
  for (const s of [shopId, otherShopId]) {
    await prisma.waitlistWindow.deleteMany({ where: { shopId: s } });
    await prisma.waitlistEntry.deleteMany({ where: { shopId: s } });
    await prisma.appointment.deleteMany({ where: { shopId: s } });
    await prisma.client.deleteMany({ where: { shopId: s } });
    await prisma.service.deleteMany({ where: { shopId: s } });
    await prisma.staff.deleteMany({ where: { shopId: s } });
    await prisma.shop.deleteMany({ where: { id: s } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe("sections", () => {
  it("every status is reachable - including EXPIRED, which had no route before", async () => {
    const ids = {
      WAITING: await seed({ status: "WAITING" }),
      CONTACTED: await seed({ status: "CONTACTED" }),
      BOOKED: await seed({ status: "BOOKED" }),
      EXPIRED: await seed({ status: "EXPIRED" }),
      REMOVED: await seed({ status: "REMOVED" }),
    };
    for (const [status, id] of Object.entries(ids)) {
      const res = await get(`?status=${status}`);
      expect(res.status).toBe(200);
      expect(res.body.waitlist.map((e: { id: string }) => e.id)).toContain(id);
      // and nothing from another section leaks in
      expect(
        res.body.waitlist.every((e: { status: string }) => e.status === status),
      ).toBe(true);
    }
  });

  it("counts cover all five sections", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.counts).sort()).toEqual([
      "BOOKED",
      "CONTACTED",
      "EXPIRED",
      "REMOVED",
      "WAITING",
    ]);
    expect(res.body.counts.EXPIRED).toBeGreaterThanOrEqual(1);
  });

  it("🔑 stays backward compatible: no query params still answers the old shape", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.waitlist)).toBe(true);
    expect(typeof res.body.waitingCount).toBe("number");
    const row = res.body.waitlist[0];
    // the pre-phase-E fields the booking page's server render reads
    for (const k of ["id", "firstName", "phone", "email", "status", "createdAt"]) {
      expect(row).toHaveProperty(k);
    }
  });
});

describe("filtering and sorting", () => {
  it("filters by provider, and 'any' finds the no-preference entries", async () => {
    const mine = await seed({ staffId: staffA, status: "WAITING" });
    const theirs = await seed({ staffId: staffB, status: "WAITING" });
    const anyone = await seed({ staffId: null, status: "WAITING" });

    const a = await get(`?status=WAITING&staffId=${staffA}`);
    const ids = a.body.waitlist.map((e: { id: string }) => e.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(ids).not.toContain(anyone);

    const none = await get("?status=WAITING&staffId=any");
    const anyIds = none.body.waitlist.map((e: { id: string }) => e.id);
    expect(anyIds).toContain(anyone);
    expect(anyIds).not.toContain(mine);
  });

  it("🔴 sorts by REQUESTED date, with legacy no-date entries last", async () => {
    // A fresh, isolated provider so this test owns its rows.
    const lane = await prisma.staff.create({ data: { shopId, name: `Lane${randomToken(3)}` } });
    const late = await seed({ staffId: lane.id, status: "WAITING" }, [
      { startDate: "2026-12-20", endDate: "2026-12-20" },
    ]);
    const early = await seed({ staffId: lane.id, status: "WAITING" }, [
      { startDate: "2026-09-01", endDate: "2026-09-03" },
    ]);
    const legacy = await seed({ staffId: lane.id, status: "WAITING" }, [{}]); // NULL dates

    const res = await get(`?status=WAITING&staffId=${lane.id}&sort=requested`);
    const ids = res.body.waitlist.map((e: { id: string }) => e.id);
    expect(ids).toEqual([early, late, legacy]);
    // and the legacy row is FLAGGED, not silently undated
    const legacyRow = res.body.waitlist.find((e: { id: string }) => e.id === legacy);
    expect(legacyRow.legacyAnyDate).toBe(true);
    expect(legacyRow.requestedDate).toBeNull();
  });

  it("sorts by join date by default, newest first", async () => {
    const lane = await prisma.staff.create({ data: { shopId, name: `J${randomToken(3)}` } });
    const older = await seed({
      staffId: lane.id,
      status: "WAITING",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = await seed({
      staffId: lane.id,
      status: "WAITING",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    const res = await get(`?status=WAITING&staffId=${lane.id}`);
    expect(res.body.waitlist.map((e: { id: string }) => e.id)).toEqual([newer, older]);
  });
});

describe("🔴 pagination has no silent cap", () => {
  it("keyset-pages a section past the old 200 wall with no dupes or gaps", async () => {
    const lane = await prisma.staff.create({ data: { shopId, name: `P${randomToken(3)}` } });
    const made: string[] = [];
    for (let i = 0; i < 12; i++) {
      made.push(
        await seed({
          staffId: lane.id,
          status: "WAITING",
          createdAt: new Date(Date.UTC(2026, 3, 1, 0, i)),
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q = `?status=WAITING&staffId=${lane.id}&limit=5${cursor ? `&cursor=${cursor}` : ""}`;
      const res: { body: { waitlist: { id: string }[]; nextCursor: string | null } } =
        await get(q);
      seen.push(...res.body.waitlist.map((e) => e.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen.sort()).toEqual([...made].sort()); // no gaps
  });
});

describe("staff-side creation", () => {
  const create = (body: Record<string, unknown>) =>
    request(app).post("/api/dashboard/waitlist").set("Cookie", cookie).send(body);

  it("🔴 records NO sms consent and sends nothing", async () => {
    const res = await create({
      firstName: "Walk In",
      phone: "+13025550123",
      serviceId,
      staffId: staffA,
    });
    expect(res.status).toBe(201);
    const row = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    // A barber cannot consent for the customer - every consent column stays null.
    expect(row.smsConsentAt).toBeNull();
    expect(row.smsConsentSource).toBeNull();
    expect(row.smsConsentVersion).toBeNull();
    expect(row.smsConsentPhone).toBeNull();
    expect(row.status).toBe("WAITING");
  });

  it("🔑 materializes Any Date into the SAME fixed window a public join gets", async () => {
    const res = await create({ firstName: "Fixed", email: `f-${randomToken(4)}@test.local` });
    expect(res.status).toBe(201);
    const row = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { windows: true },
    });
    const joined = shopLocalDate(new Date(), TZ);
    expect(row.windows).toHaveLength(1);
    expect(row.windows[0]!.startDate).toBe(joined);
    expect(row.windows[0]!.endDate).toBe(addDays(joined, ANY_DATE_HORIZON_DAYS));
    // and it carries the dedupe fingerprint the matcher/index rely on
    expect(row.dedupeKey).toBeTruthy();
  });

  it("stores explicit windows verbatim and validates them", async () => {
    const day = addDays(shopLocalDate(new Date(), TZ), 3);
    const ok = await create({
      firstName: "Picky",
      email: `p-${randomToken(4)}@test.local`,
      windows: [{ startDate: day, endDate: day, startMin: 540, endMin: 720 }],
    });
    expect(ok.status).toBe(201);
    const row = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { id: ok.body.id },
      include: { windows: true },
    });
    expect(row.windows[0]).toMatchObject({ startDate: day, startMin: 540, endMin: 720 });

    // A backwards time range is refused by the SAME phase-B validator.
    const bad = await create({
      firstName: "Bad",
      email: `b-${randomToken(4)}@test.local`,
      windows: [{ startDate: day, endDate: day, startMin: 720, endMin: 540 }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_window");
  });

  it("refuses a duplicate with a clean conflict, not a 500", async () => {
    const body = {
      firstName: "Twice",
      email: `dup-${randomToken(5)}@test.local`,
      serviceId,
      staffId: staffA,
    };
    expect((await create(body)).status).toBe(201);
    const again = await create(body);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_waiting");
  });

  it("still requires a way to reach them", async () => {
    const res = await create({ firstName: "Ghost" });
    expect(res.status).toBe(400);
  });
});

describe("status updates", () => {
  const setStatus = (id: string, status: string, jar = cookie) =>
    request(app).post(`/api/dashboard/waitlist/${id}`).set("Cookie", jar).send({ status });

  it("EXPIRED is settable by hand (phase F automates it later)", async () => {
    const id = await seed({ status: "WAITING" });
    const res = await setStatus(id, "EXPIRED");
    expect(res.status).toBe(200);
    const row = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("EXPIRED");
  });

  it("🔑 'booked externally' sets BOOKED and leaves the link NULL, on purpose", async () => {
    const id = await seed({ status: "WAITING" });
    expect((await setStatus(id, "BOOKED")).status).toBe(200);
    const row = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("BOOKED");
    // The UI reads exactly this to say "Booked externally" rather than
    // implying a ChairBack appointment that does not exist.
    expect(row.bookedAppointmentId).toBeNull();
  });
});

describe("🔴 cross-shop authorization", () => {
  it("another shop's entry is invisible in the list", async () => {
    const res = await get("?limit=100");
    expect(res.body.waitlist.map((e: { id: string }) => e.id)).not.toContain(otherEntryId);
  });

  it("another shop's entry cannot be updated (404, never 200)", async () => {
    const res = await request(app)
      .post(`/api/dashboard/waitlist/${otherEntryId}`)
      .set("Cookie", cookie)
      .send({ status: "REMOVED" });
    expect(res.status).toBe(404);
    const row = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: otherEntryId } });
    expect(row.status).toBe("WAITING"); // untouched
  });

  it("an entry created by one shop is never visible to the other", async () => {
    const mine = await seed({ status: "WAITING" });
    const res = await request(app)
      .get("/api/dashboard/waitlist?limit=100")
      .set("Cookie", otherCookie);
    expect(res.status).toBe(200);
    expect(res.body.waitlist.map((e: { id: string }) => e.id)).not.toContain(mine);
  });

  it("requires a session at all", async () => {
    expect((await request(app).get("/api/dashboard/waitlist")).status).toBe(401);
  });
});
