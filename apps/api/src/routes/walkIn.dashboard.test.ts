import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The manager Walk-In surface from the OUTSIDE: the two dark-launch gates
 * (env flag -> 404, shop toggle -> 409), the role wall (BARBER -> 403), the
 * settings round-trip with its field-level role gate, and the HTTP shapes of
 * create / transition / reorder.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

let ownerCookie: string;
let barberCookie: string;
let shopId: string;
let chairA: string;
let serviceId: string;

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: user!.id,
  };
}

let phoneSeq = 0;
function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(2000 + phoneSeq).padStart(4, "0")}`;
}

function createBody(over: Record<string, unknown> = {}) {
  return {
    firstName: `Walk${++phoneSeq}`,
    phone: freshPhone(),
    serviceIds: [serviceId],
    ...over,
  };
}

beforeAll(async () => {
  // The whole surface is dark by default - light it for this suite.
  process.env.WALK_IN_MODE_ENABLED = "true";
  __resetEnvCacheForTests();

  const owner = await signup("wd-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "WalkIn Dash Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({ bookingMode: "native", timezone: "UTC" });

  const a = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name: "Dev" });
  chairA = a.body.id;
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", ownerCookie)
    .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairA] });
  serviceId = svc.body.id;

  const barber = await signup("wd-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: barber.userId, role: "BARBER", staffId: chairA },
  });
});

afterAll(async () => {
  delete process.env.WALK_IN_MODE_ENABLED;
  __resetEnvCacheForTests();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const shops = await prisma.shop.findMany({
        where: { ownerId: user.id },
        select: { id: true },
      });
      await prisma.walkInEvent.deleteMany({
        where: { shopId: { in: shops.map((s) => s.id) } },
      });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("the two dark-launch gates", () => {
  it("with the env flag off, the surface answers 404 as if never mounted", async () => {
    process.env.WALK_IN_MODE_ENABLED = "false";
    __resetEnvCacheForTests();
    const res = await request(app)
      .get("/api/walk-ins/queue")
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(404);
    process.env.WALK_IN_MODE_ENABLED = "true";
    __resetEnvCacheForTests();
  });

  it("with the shop toggle off, an authed manager gets an honest 409", async () => {
    const res = await request(app)
      .get("/api/walk-ins/queue")
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("walk_in_disabled");
  });
});

describe("the settings round-trip + its role gate", () => {
  it("owner flips walkInEnabled on and the DTO echoes both toggles", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ walkInEnabled: true, walkInAcceptingNow: true });
    expect(res.status).toBe(200);
    expect(res.body.walkInEnabled).toBe(true);
    expect(res.body.walkInAcceptingNow).toBe(true);
  });

  it("a BARBER seat cannot touch the walk-in toggles (field-level 403)", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", barberCookie)
      .send({ walkInEnabled: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_role");
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.walkInEnabled).toBe(true); // unchanged
  });

  it("regression pin: the same barber seat can still PATCH other settings", async () => {
    // The gate is deliberately FIELD-level; widening it to the whole route
    // would silently change unrelated settings' behavior. Pin that.
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", barberCookie)
      .send({ takesRequests: false });
    expect(res.status).toBe(200);
  });
});

describe("the manager wall", () => {
  it("a BARBER seat never reaches /api/walk-ins", async () => {
    const res = await request(app)
      .get("/api/walk-ins/queue")
      .set("Cookie", barberCookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_role");
  });

  it("no session at all is refused", async () => {
    const res = await request(app).get("/api/walk-ins/queue");
    expect(res.status).toBe(401);
  });
});

describe("create + queue + transitions over HTTP", () => {
  it("creates 201, and the queue lists it with a LABELED estimate", async () => {
    const created = await request(app)
      .post("/api/walk-ins")
      .set("Cookie", ownerCookie)
      .send(createBody());
    expect(created.status).toBe(201);
    expect(created.body.entry.status).toBe("WAITING");
    expect(created.body.entry.services[0]!.name).toBe("Fade");

    const res = await request(app)
      .get("/api/walk-ins/queue")
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.acceptingNow).toBe(true);
    const row = res.body.entries.find(
      (e: { id: string }) => e.id === created.body.entry.id,
    );
    expect(row).toBeDefined();
    // The estimate rides in its own named object - it is an estimate, and
    // the shape keeps clients from presenting it as a promise.
    expect(row.estimate).toHaveProperty("waitMin");
    expect(row.estimate).toHaveProperty("startsAt");
    expect(row.estimate).toHaveProperty("projectedStaffId");
  });

  it("zod refuses an empty and an oversized service selection", async () => {
    for (const serviceIds of [[], [serviceId, serviceId, serviceId, serviceId]]) {
      const res = await request(app)
        .post("/api/walk-ins")
        .set("Cookie", ownerCookie)
        .send(createBody({ serviceIds }));
      expect(res.status).toBe(400);
    }
  });

  it("a duplicate active phone is a 409 on the STAFF surface (kiosk constancy is PR 2)", async () => {
    const phone = freshPhone();
    await request(app)
      .post("/api/walk-ins")
      .set("Cookie", ownerCookie)
      .send(createBody({ phone }));
    const dup = await request(app)
      .post("/api/walk-ins")
      .set("Cookie", ownerCookie)
      .send(createBody({ phone }));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("duplicate_active_entry");
  });

  it("assign -> ready -> return -> cancel walks the matrix; a stale repeat is 409", async () => {
    const created = await request(app)
      .post("/api/walk-ins")
      .set("Cookie", ownerCookie)
      .send(createBody());
    const id = created.body.entry.id;

    const assign = await request(app)
      .post(`/api/walk-ins/${id}/assign`)
      .set("Cookie", ownerCookie)
      .send({ staffId: chairA });
    expect(assign.status).toBe(200);
    expect(assign.body.entry.assignedStaffId).toBe(chairA);

    const ready = await request(app)
      .post(`/api/walk-ins/${id}/ready`)
      .set("Cookie", ownerCookie);
    expect(ready.status).toBe(200);

    const again = await request(app)
      .post(`/api/walk-ins/${id}/ready`)
      .set("Cookie", ownerCookie);
    expect(again.status).toBe(409);

    const back = await request(app)
      .post(`/api/walk-ins/${id}/return`)
      .set("Cookie", ownerCookie);
    expect(back.status).toBe(200);
    expect(back.body.entry.status).toBe("WAITING");
    expect(back.body.entry.position).toBe(created.body.entry.position);

    const cancel = await request(app)
      .post(`/api/walk-ins/${id}/cancel`)
      .set("Cookie", ownerCookie);
    expect(cancel.status).toBe(200);
    expect(cancel.body.entry.status).toBe("CANCELED");
  });

  it("reorder honors expectedPosition and refuses a stale one", async () => {
    const e1 = await request(app)
      .post("/api/walk-ins")
      .set("Cookie", ownerCookie)
      .send(createBody());
    const e2 = await request(app)
      .post("/api/walk-ins")
      .set("Cookie", ownerCookie)
      .send(createBody());

    const moved = await request(app)
      .post(`/api/walk-ins/${e2.body.entry.id}/reorder`)
      .set("Cookie", ownerCookie)
      .send({ afterEntryId: null, expectedPosition: e2.body.entry.position });
    expect(moved.status).toBe(200);
    expect(moved.body.entry.position).toBeLessThan(e1.body.entry.position);

    const stale = await request(app)
      .post(`/api/walk-ins/${e2.body.entry.id}/reorder`)
      .set("Cookie", ownerCookie)
      .send({ afterEntryId: null, expectedPosition: e2.body.entry.position });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale_transition");
  });

  it("acting on another shop's entry is a plain 404 (no oracle)", async () => {
    const created = await request(app)
      .post("/api/walk-ins")
      .set("Cookie", ownerCookie)
      .send(createBody());
    const other = await signup("wd-other");
    await request(app)
      .post("/api/shops")
      .set("Cookie", other.cookie)
      .send({ name: "Other Cuts", smsAttested: true });
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", other.cookie)
      .send({ walkInEnabled: true });
    const res = await request(app)
      .post(`/api/walk-ins/${created.body.entry.id}/cancel`)
      .set("Cookie", other.cookie);
    expect(res.status).toBe(404);
  });
});
