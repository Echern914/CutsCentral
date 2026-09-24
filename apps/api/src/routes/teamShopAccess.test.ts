import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { ACTIVE_SHOP_COOKIE_NAME, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { effectiveSeatRole } from "../auth/roles.js";

/**
 * A barber who already runs their OWN shop joins someone else's team.
 *
 * The bug this pins: the active-shop hint was verified against OWNERSHIP only,
 * and an unmatched hint fell straight back to the person's own shop. So an
 * independent barber who accepted a team invite could never act in the team's
 * shop - every request, the switcher included, landed them back in their own
 * business - and the switcher never listed the team anyway. The whole
 * "independent barbers join a shop's team" story was dead on arrival for
 * anyone who was already on ChairBack.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
let lastInviteToken: string | null = null;

async function signup(email: string, name: string): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}

async function createShop(cookie: string, name: string): Promise<string> {
  const res = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const withShop = (cookie: string, shopId: string) =>
  `${cookie}; ${ACTIVE_SHOP_COOKIE_NAME}=${shopId}`;

const me = (cookie: string) => request(app).get("/api/auth/me").set("Cookie", cookie);

const day = () => ({
  from: new Date(Date.now() - 36 * 3600_000).toISOString(),
  to: new Date(Date.now() + 36 * 3600_000).toISOString(),
});

let ownerCookie: string; // Snow: owns the team's shop
let teamShopId: string;
let barberCookie: string; // Joe: owns his own shop, joins Snow's team
let barberEmail: string;
let barberUserId: string;
let ownShopId: string;
let strangerShopId: string; // a shop Joe has nothing to do with
let seatId: string;

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    const m = /token=([^\s&]+)/.exec(input.text);
    lastInviteToken = m ? decodeURIComponent(m[1]!) : null;
    return { id: "TEST", status: "sent" as const };
  });
  const tag = randomToken(6).toLowerCase();

  ownerCookie = await signup(`snow-${tag}@test.chairback`, "Snow");
  teamShopId = await createShop(ownerCookie, "United Barbershop");

  barberEmail = `joe-${tag}@test.chairback`;
  barberCookie = await signup(barberEmail, "Joe");
  ownShopId = await createShop(barberCookie, "Joe's Cuts");
  barberUserId = (await prisma.user.findUniqueOrThrow({ where: { email: barberEmail } })).id;

  const strangerCookie = await signup(`stranger-${tag}@test.chairback`, "Stranger");
  strangerShopId = await createShop(strangerCookie, "Somewhere Else");

  // Snow invites Joe - no chair picked, which is exactly how most owners send it.
  const invite = await request(app)
    .post("/api/team/invites")
    .set("Cookie", ownerCookie)
    .send({ email: barberEmail, role: "BARBER" });
  expect(invite.status).toBe(201);
  const joined = await request(app)
    .post("/api/team/join")
    .set("Cookie", barberCookie)
    .send({ token: lastInviteToken });
  expect(joined.status).toBe(201);
  expect(joined.body.shopId).toBe(teamShopId);

  seatId = (await prisma.shopMember.findFirstOrThrow({
    where: { shopId: teamShopId, userId: barberUserId },
  })).id;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("a barber who owns a shop and joins a team", () => {
  it("🔴 lands in the team after accepting - on a device with no choice of its own (the app)", async () => {
    const res = await me(barberCookie);
    expect(res.status).toBe(200);
    expect(res.body.activeShopId).toBe(teamShopId);
    expect(res.body.activeShopName).toBe("United Barbershop");
    expect(res.body.shopRole).toBe("BARBER");
  });

  it("🔴 the switcher lists the team next to their own shop", async () => {
    const res = await me(barberCookie);
    expect(res.body.shops).toEqual([{ id: ownShopId, name: "Joe's Cuts" }]);
    expect(res.body.teams).toEqual([
      { id: teamShopId, name: "United Barbershop", role: "BARBER" },
    ]);
  });

  it("🔴 a cookie naming the team acts IN the team, as a barber - not as the owner of their own shop", async () => {
    const cookie = withShop(barberCookie, teamShopId);
    const home = await request(app).get("/api/barber/home").query(day()).set("Cookie", cookie);
    expect(home.status).toBe(200);
    expect(home.body.shop.name).toBe("United Barbershop");
    expect(home.body.reason).toBe("no_chair_linked");
    // Manager-only surfaces stay shut: they are a barber here.
    const roster = await request(app).get("/api/team").set("Cookie", cookie);
    expect(roster.status).toBe(403);
  });

  it("a cookie naming their own shop is honored over the account's choice", async () => {
    const res = await me(withShop(barberCookie, ownShopId));
    expect(res.body.activeShopId).toBe(ownShopId);
    expect(res.body.shopRole).toBe("OWNER");
    const roster = await request(app)
      .get("/api/team")
      .set("Cookie", withShop(barberCookie, ownShopId));
    expect(roster.status).toBe(200);
  });

  it("a forged cookie naming a stranger's shop grants nothing and falls through", async () => {
    const res = await me(withShop(barberCookie, strangerShopId));
    expect(res.body.activeShopId).toBe(teamShopId);
    expect(res.body.activeShopId).not.toBe(strangerShopId);
  });
});

describe("POST /api/auth/active-shop - the account remembers the switcher's choice", () => {
  it("switches the account back to their own shop, and every device follows", async () => {
    const res = await request(app)
      .post("/api/auth/active-shop")
      .set("Cookie", barberCookie)
      .send({ shopId: ownShopId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, shopId: ownShopId, role: "OWNER" });
    expect((await me(barberCookie)).body.activeShopId).toBe(ownShopId);

    const back = await request(app)
      .post("/api/auth/active-shop")
      .set("Cookie", barberCookie)
      .send({ shopId: teamShopId });
    expect(back.body).toMatchObject({ ok: true, shopId: teamShopId, role: "BARBER" });
    expect((await me(barberCookie)).body.activeShopId).toBe(teamShopId);
  });

  it("🔴 refuses a shop they neither own nor work in, and remembers nothing", async () => {
    const res = await request(app)
      .post("/api/auth/active-shop")
      .set("Cookie", barberCookie)
      .send({ shopId: strangerShopId });
    expect(res.status).toBe(404);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: barberUserId } });
    expect(user.activeShopId).toBe(teamShopId);
  });

  it("rejects junk input", async () => {
    const res = await request(app)
      .post("/api/auth/active-shop")
      .set("Cookie", barberCookie)
      .send({ shopId: teamShopId, extra: true });
    expect(res.status).toBe(400);
  });

  it("needs a session", async () => {
    const res = await request(app).post("/api/auth/active-shop").send({ shopId: teamShopId });
    expect(res.status).toBe(401);
  });

  it("🔴 a remembered shop is a hint, not a grant: a stranger's id stored by hand still resolves to their own", async () => {
    await prisma.user.update({
      where: { id: barberUserId },
      data: { activeShopId: strangerShopId },
    });
    try {
      const res = await me(barberCookie);
      expect(res.body.activeShopId).toBe(ownShopId);
      expect(res.body.shopRole).toBe("OWNER");
    } finally {
      await prisma.user.update({
        where: { id: barberUserId },
        data: { activeShopId: teamShopId },
      });
    }
  });
});

describe("the Team page can give a member a chair after they joined", () => {
  it("only the owner can", async () => {
    const res = await request(app)
      .post(`/api/team/members/${seatId}/staff`)
      .set("Cookie", withShop(barberCookie, teamShopId));
    expect(res.status).toBe(403);
  });

  it("🔴 one step: a new chair named after them, offered for 'all' services, linked to their seat", async () => {
    const service = await prisma.service.create({
      data: { shopId: teamShopId, name: "Cut", durationMin: 30, offeredByAll: true },
      select: { id: true },
    });
    const res = await request(app)
      .post(`/api/team/members/${seatId}/staff`)
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(201);
    const staffId = res.body.staffId as string;

    const chair = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
    expect(chair).toMatchObject({ shopId: teamShopId, name: "Joe", active: true });
    // The alert mirror moves with the seat, so Joe - not Snow - hears about
    // bookings on this chair.
    expect(chair.userId).toBe(barberUserId);
    const seat = await prisma.shopMember.findUniqueOrThrow({ where: { id: seatId } });
    expect(seat.staffId).toBe(staffId);
    const offered = await prisma.serviceStaff.findFirst({
      where: { serviceId: service.id, staffId },
    });
    expect(offered).not.toBeNull();

    // And Joe's own screen now has a chair instead of "ask the owner".
    const home = await request(app)
      .get("/api/barber/home")
      .query(day())
      .set("Cookie", withShop(barberCookie, teamShopId));
    expect(home.status).toBe(200);
    expect(home.body.reason).not.toBe("no_chair_linked");
    expect(home.body.chair).toMatchObject({ id: staffId, name: "Joe" });
  });

  it("a second tap makes no second chair", async () => {
    const before = await prisma.staff.count({ where: { shopId: teamShopId } });
    const res = await request(app)
      .post(`/api/team/members/${seatId}/staff`)
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_has_chair");
    expect(await prisma.staff.count({ where: { shopId: teamShopId } })).toBe(before);
  });

  it("the owner's own seat is not handed a chair here", async () => {
    const ownerSeat = await prisma.shopMember.findFirstOrThrow({
      where: { shopId: teamShopId, role: "OWNER" },
    });
    const res = await request(app)
      .post(`/api/team/members/${ownerSeat.id}/staff`)
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cannot_modify_owner");
  });

  it("another shop's seat is not found", async () => {
    const res = await request(app)
      .post(`/api/team/members/${seatId}/staff`)
      .set("Cookie", withShop(barberCookie, ownShopId));
    expect(res.status).toBe(404);
  });
});

describe("joining when already on the team", () => {
  it("🔴 answers already_member WITH the shop, and still takes them there", async () => {
    await prisma.user.update({
      where: { id: barberUserId },
      data: { activeShopId: ownShopId },
    });
    // A second live invitation for someone already seated (the invite route
    // refuses to mint one, so plant it the way an older link would exist).
    const token = randomToken();
    const { createHash } = await import("node:crypto");
    await prisma.teamInvite.create({
      data: {
        shopId: teamShopId,
        email: barberEmail,
        role: "BARBER",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        invitedById: barberUserId,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const res = await request(app)
      .post("/api/team/join")
      .set("Cookie", barberCookie)
      .send({ token });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already_member", shopId: teamShopId });
    expect((await me(barberCookie)).body.activeShopId).toBe(teamShopId);
  });
});

describe("losing the seat", () => {
  it("🔴 a removed barber's cookie AND remembered choice both stop working at once", async () => {
    const removed = await request(app)
      .delete(`/api/team/members/${seatId}`)
      .set("Cookie", ownerCookie);
    expect(removed.status).toBe(200);

    const res = await me(withShop(barberCookie, teamShopId));
    expect(res.body.activeShopId).toBe(ownShopId);
    expect(res.body.shopRole).toBe("OWNER");
    expect(res.body.teams).toEqual([]);
    const home = await request(app)
      .get("/api/barber/home")
      .query(day())
      .set("Cookie", withShop(barberCookie, teamShopId));
    expect(home.body.shop.name).toBe("Joe's Cuts");
  });
});

describe("ownership still comes from Shop.ownerId alone", () => {
  it("an owner whose own seat row is missing is still the owner", async () => {
    const ownerSeat = await prisma.shopMember.findFirstOrThrow({
      where: { shopId: teamShopId, role: "OWNER" },
    });
    await prisma.shopMember.delete({ where: { id: ownerSeat.id } });
    try {
      const res = await me(ownerCookie);
      expect(res.body.activeShopId).toBe(teamShopId);
      expect(res.body.shopRole).toBe("OWNER");
      expect(res.body.teams).toEqual([]);
    } finally {
      await prisma.shopMember.create({
        data: { shopId: teamShopId, userId: ownerSeat.userId, role: "OWNER" },
      });
    }
  });

  it("🔴 an OWNER seat on a shop they don't own degrades to manager - never owner powers", async () => {
    const planted = await prisma.shopMember.create({
      data: { shopId: strangerShopId, userId: barberUserId, role: "OWNER" },
    });
    try {
      const cookie = withShop(barberCookie, strangerShopId);
      const res = await me(cookie);
      expect(res.body.activeShopId).toBe(strangerShopId);
      expect(res.body.shopRole).toBe("MANAGER");
      expect(res.body.teams).toContainEqual({
        id: strangerShopId,
        name: "Somewhere Else",
        role: "MANAGER",
      });
      // Owner-only: inviting people.
      const invite = await request(app)
        .post("/api/team/invites")
        .set("Cookie", cookie)
        .send({ email: `x-${randomToken(4).toLowerCase()}@test.chairback`, role: "BARBER" });
      expect(invite.status).toBe(403);
    } finally {
      await prisma.shopMember.delete({ where: { id: planted.id } });
    }
  });
});

describe("effectiveSeatRole", () => {
  it("owning the shop is what makes an OWNER", () => {
    expect(effectiveSeatRole("BARBER", true)).toBe("OWNER");
    expect(effectiveSeatRole("OWNER", true)).toBe("OWNER");
  });
  it("a seat never escalates", () => {
    expect(effectiveSeatRole("OWNER", false)).toBe("MANAGER");
    expect(effectiveSeatRole("MANAGER", false)).toBe("MANAGER");
    expect(effectiveSeatRole("BARBER", false)).toBe("BARBER");
    expect(effectiveSeatRole("SOMETHING_NEW", false)).toBe("BARBER");
  });
});
