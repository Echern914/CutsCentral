import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * A team owner sees how far each member's setup is (Eric, 2026-10-16), so a
 * shop moving its whole team over can see who's ready to take bookings.
 *
 *  - on to start: a member who just joined shows their progress;
 *  - yes/no per step only - never a count, a client or a number;
 *  - read from the member's real data, so it moves as they set up;
 *  - the member can hide it, and the owner's feed says so;
 *  - leaving and asking again starts it shown again.
 */
const app = createApp();
const tag = randomToken(6).toLowerCase();
const emails: string[] = [];

async function signup(label: string) {
  const email = `${label}-${tag}@test.chairback`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "correct horse battery staple", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}
async function shopFor(cookie: string, name: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

let owner: string;
let teamId: string;
let member: { cookie: string; shopId: string; linkId: string };

const progress = async () => {
  const res = await request(app).get("/api/team/links").set("Cookie", owner);
  expect(res.status).toBe(200);
  return res.body.active.find((x: { id: string }) => x.id === member.linkId).setup;
};
const share = (on: boolean) =>
  request(app).patch(`/api/teams/${member.linkId}/sharing`).set("Cookie", member.cookie).send({ shareSetup: on });

beforeAll(async () => {
  __setSendEmailForTests(async () => ({ id: "TEST", status: "sent" as const }));
  owner = await signup("owner");
  teamId = await shopFor(owner, `Team Shop ${tag}`);
  const cookie = await signup("member");
  const shopId = await shopFor(cookie, `Member Cuts ${tag}`);
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });
  const joined = await request(app).post("/api/teams/join").set("Cookie", cookie).send({ team: teamId });
  expect(joined.status).toBe(201);
  expect((await request(app).post(`/api/team/links/${joined.body.id}/approve`).set("Cookie", owner)).status).toBe(200);
  member = { cookie, shopId, linkId: joined.body.id as string };
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

describe("a member's setup progress, as the team owner sees it", () => {
  it("🔴 is shown from the start, yes/no per step - nothing else", async () => {
    expect(await progress()).toEqual({
      complete: false,
      steps: [
        { id: "booking", done: true },
        { id: "team", done: false },
        { id: "services", done: false },
        { id: "hours", done: false },
        { id: "clients", done: false },
      ],
    });
  });

  it("moves as the member sets up, and says when clients can book them", async () => {
    const staff = await prisma.staff.create({ data: { shopId: member.shopId, name: "Member" } });
    await prisma.service.create({ data: { shopId: member.shopId, name: "Cut", durationMin: 30, price: 30 } });
    await prisma.availabilityRule.create({
      data: { shopId: member.shopId, staffId: staff.id, weekday: 2, startMin: 540, endMin: 1020 },
    });
    const p = await progress();
    expect(p.complete).toBe(true);
    expect(p.steps.filter((s: { done: boolean }) => !s.done).map((s: { id: string }) => s.id)).toEqual(["clients"]);
  });

  it("🔴 the member can hide it; the owner then sees nothing, and the feed says so", async () => {
    const res = await share(false);
    expect(res.status).toBe(200);
    expect(res.body.shareSetup).toBe(false);
    expect(await progress()).toBeNull();
    const feed = (await request(app).get("/api/team/activity").set("Cookie", owner)).body.items as {
      kind: string;
      metric: string | null;
    }[];
    expect(feed.some((x) => x.kind === "hid" && x.metric === "setup")).toBe(true);
  });

  it("only the member can change it - not the team's owner", async () => {
    const res = await request(app)
      .patch(`/api/teams/${member.linkId}/sharing`)
      .set("Cookie", owner)
      .send({ shareSetup: true });
    expect(res.status).toBe(404);
    expect(await progress()).toBeNull();
  });

  it("leaving and asking again starts it shown again", async () => {
    expect((await request(app).post(`/api/teams/${member.linkId}/leave`).set("Cookie", member.cookie)).status).toBe(200);
    const again = await request(app).post("/api/teams/join").set("Cookie", member.cookie).send({ team: teamId });
    expect(again.status).toBe(201);
    expect((await request(app).post(`/api/team/links/${member.linkId}/approve`).set("Cookie", owner)).status).toBe(200);
    expect(await progress()).not.toBeNull();
  });
});
