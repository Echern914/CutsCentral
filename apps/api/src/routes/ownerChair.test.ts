import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE OWNER'S OWN CHAIR.
 *
 * An owner who takes clients was the one person in the shop the product could
 * not place: every barber's seat names a chair, and the owner's session always
 * said "no chair". This pins the route that fixes it, and the three things it
 * must never do - change the owner's role, take a chair somebody else works,
 * or narrow what the owner can see.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];

let ownerCookie = "";
let ownerId = "";
let barberCookie = "";
let barberId = "";
let shopId = "";
let chairA = ""; // free
let chairB = ""; // the barber's

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { userId: user.id, cookie: (res.headers["set-cookie"] as unknown as string[])[0]! };
}

const setChair = (cookie: string, body: unknown) =>
  request(app).put("/api/team/owner/staff").set("Cookie", cookie).send(body as object);

const ownerSeat = () =>
  prisma.shopMember.findUnique({
    where: { shopId_userId: { shopId, userId: ownerId } },
    select: { role: true, staffId: true },
  });

const chairUser = async (id: string) =>
  (await prisma.staff.findUniqueOrThrow({ where: { id }, select: { userId: true } })).userId;

const me = async (cookie: string) =>
  (await request(app).get("/api/auth/me").set("Cookie", cookie)).body as {
    shopRole: string;
    staffId: string | null;
  };

beforeAll(async () => {
  const owner = await signup("oc-owner");
  ownerCookie = owner.cookie;
  ownerId = owner.userId;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Owner Chair Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  chairA = (await prisma.staff.create({ data: { shopId, name: "Chair A" }, select: { id: true } })).id;
  chairB = (await prisma.staff.create({ data: { shopId, name: "Chair B" }, select: { id: true } })).id;

  const barber = await signup("oc-barber");
  barberCookie = barber.cookie;
  barberId = barber.userId;
  await prisma.shopMember.create({
    data: { shopId, userId: barberId, role: "BARBER", staffId: chairB },
  });
  await prisma.staff.update({ where: { id: chairB }, data: { userId: barberId } });
});

beforeEach(async () => {
  // Every case starts with the owner on no chair.
  await prisma.shopMember.updateMany({ where: { shopId, userId: ownerId }, data: { staffId: null } });
  await prisma.staff.updateMany({ where: { shopId, userId: ownerId }, data: { userId: null } });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("the owner picks the chair they work", () => {
  it("links the seat AND the chair, and the session carries it", async () => {
    expect((await me(ownerCookie)).staffId).toBeNull();

    const res = await setChair(ownerCookie, { staffId: chairA });
    expect(res.status).toBe(200);
    expect((await ownerSeat())?.staffId).toBe(chairA);
    // The mirror every alert path reads.
    expect(await chairUser(chairA)).toBe(ownerId);
    expect((await me(ownerCookie)).staffId).toBe(chairA);
  });

  it("🔴 the owner is still the OWNER afterwards, with the whole dashboard", async () => {
    await setChair(ownerCookie, { staffId: chairA });
    expect((await ownerSeat())?.role).toBe("OWNER");
    expect((await me(ownerCookie)).shopRole).toBe("OWNER");
    // An owner-only surface and a manager-only one, both still open.
    const team = await request(app).get("/api/team").set("Cookie", ownerCookie);
    expect(team.status).toBe(200);
    expect(team.body.role).toBe("OWNER");
    const staff = await request(app).get("/api/booking/staff").set("Cookie", ownerCookie);
    expect(staff.status).toBe(200);
  });

  it("🔴 nothing in the body can reach the role", async () => {
    const res = await setChair(ownerCookie, { staffId: chairA, role: "BARBER" });
    expect(res.status).toBe(400);
    expect((await ownerSeat())?.role).toBe("OWNER");
    expect((await ownerSeat())?.staffId).toBeNull();
  });

  it("...and the member route still refuses the owner's seat outright", async () => {
    const seat = await prisma.shopMember.findUniqueOrThrow({
      where: { shopId_userId: { shopId, userId: ownerId } },
      select: { id: true },
    });
    const res = await request(app)
      .patch(`/api/team/members/${seat.id}`)
      .set("Cookie", ownerCookie)
      .send({ role: "BARBER" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cannot_modify_owner");
  });

  it("moving to another chair releases the first", async () => {
    const chairC = (await prisma.staff.create({ data: { shopId, name: "Chair C" }, select: { id: true } })).id;
    try {
      await setChair(ownerCookie, { staffId: chairA });
      const res = await setChair(ownerCookie, { staffId: chairC });
      expect(res.status).toBe(200);
      expect(await chairUser(chairA)).toBeNull();
      expect(await chairUser(chairC)).toBe(ownerId);
    } finally {
      await prisma.shopMember.updateMany({ where: { shopId, userId: ownerId }, data: { staffId: null } });
      await prisma.staff.delete({ where: { id: chairC } });
    }
  });

  it("null means 'I don't work a chair', and gives the chair back", async () => {
    await setChair(ownerCookie, { staffId: chairA });
    const res = await setChair(ownerCookie, { staffId: null });
    expect(res.status).toBe(200);
    expect((await ownerSeat())?.staffId).toBeNull();
    expect(await chairUser(chairA)).toBeNull();
    expect((await me(ownerCookie)).staffId).toBeNull();
  });

  it("🔴 cannot take a chair somebody else works, and theirs is untouched", async () => {
    const res = await setChair(ownerCookie, { staffId: chairB });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("staff_taken");
    expect(await chairUser(chairB)).toBe(barberId);
    expect((await ownerSeat())?.staffId).toBeNull();
  });

  it("refuses a chair from another shop, or one that is switched off", async () => {
    const other = await signup("oc-other");
    const otherShop = await request(app)
      .post("/api/shops")
      .set("Cookie", other.cookie)
      .send({ name: "Somebody Else", smsAttested: true });
    const foreign = await prisma.staff.create({
      data: { shopId: otherShop.body.id as string, name: "Not Yours" },
      select: { id: true },
    });
    const res = await setChair(ownerCookie, { staffId: foreign.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_staff");
    expect((await prisma.staff.findUniqueOrThrow({ where: { id: foreign.id } })).userId).toBeNull();

    await prisma.staff.update({ where: { id: chairA }, data: { active: false } });
    try {
      const off = await setChair(ownerCookie, { staffId: chairA });
      expect(off.status).toBe(400);
    } finally {
      await prisma.staff.update({ where: { id: chairA }, data: { active: true } });
    }
  });

  it("🔴 a barber cannot use it - not for themselves, not for the owner", async () => {
    const res = await setChair(barberCookie, { staffId: chairA });
    expect(res.status).toBe(403);
    expect(await chairUser(chairA)).toBeNull();
  });

  it("🔴 a MANAGER cannot use it either, and gains nothing by trying", async () => {
    // The barber above is stopped by the team router itself. A manager is let
    // into that router, so this is the case the route's own check exists for:
    // without it the route would write an OWNER seat for whoever called it.
    const manager = await signup("oc-manager");
    await prisma.shopMember.create({ data: { shopId, userId: manager.userId, role: "MANAGER" } });
    try {
      const res = await setChair(manager.cookie, { staffId: chairA });
      expect(res.status).toBe(403);
      expect(await chairUser(chairA)).toBeNull();
      const seat = await prisma.shopMember.findUniqueOrThrow({
        where: { shopId_userId: { shopId, userId: manager.userId } },
        select: { role: true, staffId: true },
      });
      expect(seat).toEqual({ role: "MANAGER", staffId: null });
    } finally {
      await prisma.shopMember.deleteMany({ where: { shopId, userId: manager.userId } });
    }
  });

  it("a shop from before team seats gets its owner seat created, as OWNER", async () => {
    await prisma.shopMember.deleteMany({ where: { shopId, userId: ownerId } });
    const res = await setChair(ownerCookie, { staffId: chairA });
    expect(res.status).toBe(200);
    expect(await ownerSeat()).toEqual({ role: "OWNER", staffId: chairA });
  });
});
