import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { nextOnboardingStep, type OnboardingFacts } from "@chairback/config/onboarding";
import { createApp } from "../app.js";
import { __setSendEmailForTests, emailEnabled } from "../messaging/email.js";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";

/**
 * First-time setup (routes/onboarding.ts, config/onboarding.ts).
 *
 *  - a new shop starts unfinished; the state is read from its own data;
 *  - the team's chairs are added by name, never twice (a retry, a second
 *    tap, two at once), each offered the "everyone" services;
 *  - a team is added with an optional email each: everyone is bookable
 *    whether or not a single invitation goes out, and each invitation names
 *    that person's own chair;
 *  - finishing (or skipping) stamps the shop and the tour, once;
 *  - the owner's alone.
 */
const app = createApp();
const emails: string[] = [];
const shopIds: string[] = [];

async function signup(label: string, name = label): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}
async function newShop(cookie: string, name = "Fresh Cuts") {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  shopIds.push(res.body.id);
  return res.body.id as string;
}
const state = (cookie: string) => request(app).get("/api/onboarding/state").set("Cookie", cookie);
const team = (cookie: string, names: string[]) => request(app).post("/api/onboarding/team").set("Cookie", cookie).send({ names });

let owner: { cookie: string; userId: string };
let shopId: string;

beforeAll(async () => {
  owner = await signup("onb-owner", "Eric Chernichaw");
  shopId = await newShop(owner.cookie);
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("a new shop's setup state", () => {
  it("🔴 starts unfinished, and asks how clients book first (a new shop is 'link' with no link)", async () => {
    const me = await request(app).get("/api/shops/me").set("Cookie", owner.cookie);
    expect(me.body.onboardingCompletedAt).toBeNull();
    const res = await state(owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.facts).toEqual({
      hasShop: true,
      bookingMode: "link",
      bookingUrl: null,
      integrationConnected: false,
      staffCount: 0,
      serviceCount: 0,
      staffWithHours: 0,
      clientCount: 0,
    });
    expect(res.body.me).toEqual({ name: "Eric Chernichaw" });
    expect(res.body.shop.completedAt).toBeNull();
    expect(nextOnboardingStep(res.body.facts as OnboardingFacts)).toBe("booking");
  });

  it("the signup's texting agreement is on the account, so setup doesn't ask it again", async () => {
    expect((await request(app).get("/api/auth/me").set("Cookie", owner.cookie)).body.smsAttested).toBe(true);
  });

  it("an email address as a name is never offered as a chair's public name", async () => {
    const apple = await signup("onb-apple", "someone@privaterelay.appleid.com");
    await newShop(apple.cookie, "Relay Cuts");
    expect((await state(apple.cookie)).body.me).toEqual({ name: "" });
  });
});

describe("walking the steps", () => {
  it("ChairBack booking, then the team, services and hours - each read back from the shop's own data", async () => {
    expect((await request(app).patch("/api/shops/me").set("Cookie", owner.cookie).send({ bookingMode: "native" })).status).toBe(200);
    let facts = (await state(owner.cookie)).body.facts as OnboardingFacts;
    expect(nextOnboardingStep(facts)).toBe("team");

    // A service offered by everyone, before the team exists: new chairs pick it up.
    const svc = await request(app)
      .post("/api/booking/services/bulk")
      .set("Cookie", owner.cookie)
      .send({ services: [{ name: "Taper", durationMin: 30, price: 40 }] });
    expect(svc.status).toBe(201);

    const added = await team(owner.cookie, ["Eric Chernichaw", "  Dee  "]);
    expect(added.status).toBe(201);
    expect(added.body.created.map((s: { name: string }) => s.name)).toEqual(["Eric Chernichaw", "Dee"]);
    expect(added.body.skipped).toEqual([]);
    const links = await prisma.serviceStaff.count({ where: { shopId, staffId: { in: added.body.created.map((s: { id: string }) => s.id) } } });
    expect(links).toBe(2);

    facts = (await state(owner.cookie)).body.facts;
    expect(facts).toMatchObject({ staffCount: 2, serviceCount: 1, staffWithHours: 0 });
    expect(nextOnboardingStep(facts)).toBe("hours");

    for (const s of added.body.created as { id: string }[]) {
      const put = await request(app)
        .put(`/api/booking/staff/${s.id}/availability`)
        .set("Cookie", owner.cookie)
        .send({ rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1020 })) });
      expect(put.status).toBe(200);
    }
    const after = await state(owner.cookie);
    expect(after.body.facts.staffWithHours).toBe(2);
    expect(after.body.staff.every((s: { hasHours: boolean }) => s.hasHours)).toBe(true);
    expect(nextOnboardingStep(after.body.facts)).toBe("clients");
  });

  it("🔴 a name already on a chair is skipped - coming back, a second tap or a retry adds no one twice", async () => {
    const again = await team(owner.cookie, ["eric chernichaw", "Sam"]);
    expect(again.body.created.map((s: { name: string }) => s.name)).toEqual(["Sam"]);
    expect(again.body.skipped).toEqual(["eric chernichaw"]);
    expect(await prisma.staff.count({ where: { shopId, active: true } })).toBe(3);
  });

  it("🔴 two adds at once make each chair once (behind the shop's setup lock)", async () => {
    const solo = await signup("onb-race");
    const raceShop = await newShop(solo.cookie, "Race Cuts");
    const { results, settledEarly } = await raceBehindAdvisoryLock(`onboardteam:${raceShop}`, [
      () => team(solo.cookie, ["Kai", "Lee"]),
      () => team(solo.cookie, ["Kai", "Lee"]),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.every((r) => r.status === "fulfilled" && r.value.status === 201)).toBe(true);
    expect((await prisma.staff.findMany({ where: { shopId: raceShop }, select: { name: true } })).map((s) => s.name).sort()).toEqual(["Kai", "Lee"]);
  });

  it("refuses a blank, too-long or oversized list whole", async () => {
    for (const names of [[], ["  "], ["x".repeat(61)], Array.from({ length: 21 }, (_, i) => `P${i}`)]) {
      expect((await team(owner.cookie, names)).status).toBe(400);
    }
  });
});

describe("adding a team, with an email for anyone who should sign in", () => {
  const people = (cookie: string, list: { name: string; email?: string }[]) =>
    request(app).post("/api/onboarding/team").set("Cookie", cookie).send({ people: list });
  const addr = (label: string) => `${label}-${randomToken(6)}@test.local`.toLowerCase();
  const sent: { to: string; token: string | null }[] = [];
  const capture = () =>
    __setSendEmailForTests(async (input) => {
      const m = /token=([^\s&]+)/.exec(input.text);
      sent.push({ to: input.to, token: m ? decodeURIComponent(m[1]!) : null });
      return { id: "TEST", status: "sent" as const };
    });
  afterAll(() => __setSendEmailForTests(undefined));

  it("🔴 everyone is made bookable; an email sends that person an invitation naming THEIR chair", async () => {
    capture();
    const solo = await signup("onb-people", "Eric");
    const id = await newShop(solo.cookie, "People Cuts");
    const dee = addr("dee");
    const res = await people(solo.cookie, [{ name: "Eric" }, { name: "Dee", email: dee.toUpperCase() }, { name: "Kai", email: "" }]);
    expect(res.status).toBe(201);
    expect(res.body.created.map((s: { name: string }) => s.name)).toEqual(["Eric", "Dee", "Kai"]);
    expect(res.body.invites).toEqual([{ name: "Dee", email: dee, outcome: "sent" }]);

    const deeChair = res.body.created.find((s: { name: string }) => s.name === "Dee").id as string;
    const invites = await prisma.teamInvite.findMany({ where: { shopId: id }, select: { email: true, role: true, staffId: true } });
    expect(invites).toEqual([{ email: dee, role: "BARBER", staffId: deeChair }]);
    expect(sent.filter((m) => m.to === dee)).toHaveLength(1);

    // Accepting lands them on the chair setup made for them - no second one.
    emails.push(dee);
    const join = await request(app).post("/api/auth/signup").send({ email: dee, password: "supersecret123", name: "Dee F", smsAttested: true, acceptTerms: true });
    const cookie = (join.headers["set-cookie"] as unknown as string[])[0]!;
    const token = sent.find((m) => m.to === dee)!.token!;
    expect((await request(app).post("/api/team/join").set("Cookie", cookie).send({ token })).status).toBe(201);
    const seat = await prisma.shopMember.findFirstOrThrow({ where: { shopId: id, role: "BARBER" }, select: { staffId: true, role: true } });
    expect(seat).toEqual({ staffId: deeChair, role: "BARBER" });
    expect(await prisma.staff.count({ where: { shopId: id } })).toBe(3);
  });

  it("🔴 email not set up on the server: everyone is still added, and nothing pretends to have been sent", async () => {
    __setSendEmailForTests(undefined);
    // Without the test sender this reads the environment. If it is ever on in
    // a test run, stop here rather than send a real invitation.
    expect(emailEnabled()).toBe(false);
    const solo = await signup("onb-noemail", "Eric");
    const id = await newShop(solo.cookie, "Quiet Cuts");
    const dee = addr("dee");
    const res = await people(solo.cookie, [{ name: "Eric" }, { name: "Dee", email: dee }]);
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.invites).toEqual([{ name: "Dee", email: dee, outcome: "email_unavailable" }]);
    // No invitation was written: a link nobody was sent is not left lying around.
    expect(await prisma.teamInvite.count({ where: { shopId: id } })).toBe(0);
  });

  it("a send that fails is reported, and the person is still added", async () => {
    __setSendEmailForTests(async () => {
      throw new Error("provider down");
    });
    const solo = await signup("onb-sendfail", "Eric");
    const id = await newShop(solo.cookie, "Flaky Cuts");
    const dee = addr("dee");
    const res = await people(solo.cookie, [{ name: "Dee", email: dee }]);
    expect(res.status).toBe(201);
    expect(res.body.invites).toEqual([{ name: "Dee", email: dee, outcome: "email_failed" }]);
    expect(await prisma.staff.count({ where: { shopId: id, name: "Dee" } })).toBe(1);
  });

  it("🔴 a retry adds no one twice, and leaves ONE live invitation for the same chair", async () => {
    capture();
    const solo = await signup("onb-retry", "Eric");
    const id = await newShop(solo.cookie, "Retry Cuts");
    const dee = addr("dee");
    const first = await people(solo.cookie, [{ name: "Dee", email: dee }]);
    const again = await people(solo.cookie, [{ name: "dee", email: dee }]);
    expect(again.status).toBe(201);
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped).toEqual(["dee"]);
    expect(again.body.invites).toEqual([{ name: "dee", email: dee, outcome: "sent" }]);
    expect(await prisma.staff.count({ where: { shopId: id } })).toBe(1);
    const live = await prisma.teamInvite.findMany({ where: { shopId: id, acceptedAt: null, revokedAt: null }, select: { staffId: true } });
    expect(live).toEqual([{ staffId: first.body.created[0].id }]);
  });

  it("the owner's own address, or someone already on the team, is added but not invited", async () => {
    capture();
    const solo = await signup("onb-self", "Eric");
    const id = await newShop(solo.cookie, "Self Cuts");
    const mine = (await prisma.user.findUniqueOrThrow({ where: { id: solo.userId }, select: { email: true } })).email;
    const res = await people(solo.cookie, [{ name: "Eric", email: mine }]);
    expect(res.status).toBe(201);
    expect(res.body.invites).toEqual([{ name: "Eric", email: mine, outcome: "already_member" }]);
    expect(await prisma.teamInvite.count({ where: { shopId: id } })).toBe(0);
    expect(await prisma.staff.count({ where: { shopId: id, name: "Eric" } })).toBe(1);
  });

  it("someone whose chair another sign-in already holds is not sent a second way in", async () => {
    capture();
    const solo = await signup("onb-linked", "Eric");
    const id = await newShop(solo.cookie, "Linked Cuts");
    const made = await people(solo.cookie, [{ name: "Dee" }]);
    const holder = await signup("onb-holder");
    await prisma.shopMember.create({ data: { shopId: id, userId: holder.userId, role: "BARBER", staffId: made.body.created[0].id } });
    const dee = addr("dee");
    const res = await people(solo.cookie, [{ name: "Dee", email: dee }]);
    expect(res.body.invites).toEqual([{ name: "Dee", email: dee, outcome: "already_linked" }]);
    expect(await prisma.teamInvite.count({ where: { shopId: id } })).toBe(0);
  });

  it("refuses two people on one address, a bad address, or an unknown field - whole, adding no one", async () => {
    const solo = await signup("onb-badpeople", "Eric");
    const id = await newShop(solo.cookie, "Strict Cuts");
    for (const list of [
      [{ name: "Dee", email: "same@test.local" }, { name: "Kai", email: "SAME@test.local" }],
      [{ name: "Dee", email: "not-an-email" }],
      [{ name: "Dee", role: "MANAGER" }],
      [{ name: "  " }],
    ]) {
      expect((await people(solo.cookie, list as { name: string; email?: string }[])).status).toBe(400);
    }
    expect(await prisma.staff.count({ where: { shopId: id } })).toBe(0);
  });
});

describe("the shop's time zone (Booking → Settings)", () => {
  it("🔴 a real zone is saved; one Intl can't read is refused, and the zone stays", async () => {
    const solo = await signup("onb-tz");
    const id = await newShop(solo.cookie, "Zone Cuts");
    const patch = (timezone: string) => request(app).patch("/api/shops/me").set("Cookie", solo.cookie).send({ timezone });
    expect((await patch("America/Los_Angeles")).status).toBe(200);
    expect((await patch("Mars/Olympus_Mons")).status).toBe(400);
    expect((await patch("")).status).toBe(400);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id } })).timezone).toBe("America/Los_Angeles");
  });
});

describe("finishing", () => {
  it("🔴 stamps the shop and the tour once; signing in stops resuming setup", async () => {
    const solo = await signup("onb-finish");
    const id = await newShop(solo.cookie, "Finish Cuts");
    expect((await request(app).get("/api/auth/me").set("Cookie", solo.cookie)).body.welcomeSeen).toBe(false);
    expect((await request(app).post("/api/onboarding/complete").set("Cookie", solo.cookie)).body).toEqual({ ok: true });
    const first = (await prisma.shop.findUniqueOrThrow({ where: { id } })).onboardingCompletedAt;
    expect(first).not.toBeNull();
    expect((await request(app).get("/api/auth/me").set("Cookie", solo.cookie)).body.welcomeSeen).toBe(true);
    await request(app).post("/api/onboarding/complete").set("Cookie", solo.cookie);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id } })).onboardingCompletedAt).toEqual(first);
    expect((await request(app).get("/api/shops/me").set("Cookie", solo.cookie)).body.onboardingCompletedAt).toBe(first!.toISOString());
  });
});

describe("the owner's alone", () => {
  it("a manager or a barber gets 403 from every setup route", async () => {
    for (const role of ["MANAGER", "BARBER"] as const) {
      const seat = await signup(`onb-${role.toLowerCase()}`);
      await prisma.shopMember.create({ data: { shopId, userId: seat.userId, role } });
      expect((await state(seat.cookie)).status).toBe(403);
      expect((await team(seat.cookie, ["Nope"])).status).toBe(403);
      expect((await request(app).post("/api/onboarding/complete").set("Cookie", seat.cookie)).status).toBe(403);
    }
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).onboardingCompletedAt).toBeNull();
  });
});
