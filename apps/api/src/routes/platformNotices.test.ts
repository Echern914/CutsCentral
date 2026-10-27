import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setExpoSenderForTests, __setPushSenderForTests } from "../messaging/push.js";
import {
  __resetNoticeCacheForTests,
  __setNoticePushModeForTests,
} from "../services/platformNotices.js";

/**
 * PLATFORM NOTICES - the status banner the platform owner posts from the admin
 * portal, shown on every barber's dashboard.
 *
 *  - only an admin can post, edit, resolve or delete one (404 for anyone else,
 *    like the rest of the portal);
 *  - a barber sees what is live: not a scheduled one, not an ended one, and a
 *    fixed one only for a few hours (as "resolved");
 *  - closing the banner hides it for THAT person only, and a newer notice
 *    shows again;
 *  - "notify phones" pushes to shop OWNERS exactly once, never while DRY_RUN.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const noticeIds: string[] = [];

async function signup(label: string, withShop: boolean): Promise<{ cookie: string; userId: string; shopId: string | null }> {
  const email = `pn-${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  let shopId: string | null = null;
  if (withShop) {
    const shop = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: `PN ${label}`, bookingUrl: "https://notices.test", smsAttested: true });
    expect(shop.status).toBe(201);
    shopId = (await prisma.shop.findFirstOrThrow({ where: { owner: { email } }, select: { id: true } })).id;
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { cookie, userId: user.id, shopId };
}

let admin: Awaited<ReturnType<typeof signup>>;
let ownerA: Awaited<ReturnType<typeof signup>>;
let ownerB: Awaited<ReturnType<typeof signup>>;
let staff: Awaited<ReturnType<typeof signup>>;
const tokens = {
  a: `ExponentPushToken[pn-a-${randomToken(8)}]`,
  b: `ExponentPushToken[pn-b-${randomToken(8)}]`,
  staff: `ExponentPushToken[pn-s-${randomToken(8)}]`,
};
const sentTo: string[] = [];

const adminPost = (path: string, body: Record<string, unknown> = {}, cookie = admin.cookie) =>
  request(app).post(`/api/admin-portal/notices${path}`).set("Cookie", cookie).send(body);
const listFor = async (cookie: string) => {
  __resetNoticeCacheForTests();
  const res = await request(app).get("/api/platform-notices").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.notices as { id: string; state: string; title: string; dismissed: boolean }[];
};

async function post(body: Record<string, unknown>): Promise<{ id: string; push: string }> {
  const res = await adminPost("", body);
  expect(res.status).toBe(201);
  noticeIds.push(res.body.notice.id);
  return { id: res.body.notice.id, push: res.body.push };
}

/** A notice written straight to the table, for states the clock has to produce. */
async function seed(data: { startsAt: Date; endsAt?: Date | null; resolvedAt?: Date | null; title: string }) {
  const row = await runAsOwner((tx) =>
    tx.platformNotice.create({
      data: { body: "seeded", severity: "issue", createdById: admin.userId, ...data },
      select: { id: true },
    }),
  );
  noticeIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  admin = await signup("admin", true);
  await prisma.user.update({ where: { id: admin.userId }, data: { isAdmin: true } });
  ownerA = await signup("ownera", true);
  ownerB = await signup("ownerb", true);
  // A person with no shop of their own: their device sits on owner A's shop,
  // the way a staff seat's would. Not an owner, so never pushed.
  staff = await signup("staff", false);
  await runAsOwner(async (tx) => {
    await tx.pushSubscription.create({ data: { shopId: ownerA.shopId!, userId: ownerA.userId, kind: "expo", expoPushToken: tokens.a } });
    await tx.pushSubscription.create({ data: { shopId: ownerB.shopId!, userId: ownerB.userId, kind: "expo", expoPushToken: tokens.b } });
    await tx.pushSubscription.create({ data: { shopId: ownerA.shopId!, userId: staff.userId, kind: "expo", expoPushToken: tokens.staff } });
  });
  // Fake transports for BOTH kinds, so no other suite's leftover device is
  // ever sent a real push from here.
  __setExpoSenderForTests({ send: async (token) => void sentTo.push(token) });
  __setPushSenderForTests({ send: async () => undefined });
});

afterEach(() => {
  __setNoticePushModeForTests(undefined);
});

afterAll(async () => {
  __setExpoSenderForTests(undefined);
  __setPushSenderForTests(undefined);
  await runAsOwner((tx) => tx.platformNotice.deleteMany({ where: { id: { in: noticeIds } } }));
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  for (const u of users) {
    await prisma.shop.deleteMany({ where: { ownerId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  await prisma.$disconnect();
});

describe("only an admin writes a notice", () => {
  it("🔴 a signed-in barber cannot post, edit, resolve or delete one - and nothing is written", async () => {
    const before = await runAsOwner((tx) => tx.platformNotice.count());
    const body = { title: "Fake outage", body: "Not real", severity: "issue" };
    expect((await adminPost("", body, ownerA.cookie)).status).toBe(404);
    expect(await runAsOwner((tx) => tx.platformNotice.count())).toBe(before);

    const real = await post({ title: "Real one", body: "Posted by the admin", severity: "info" });
    expect((await adminPost(`/${real.id}/resolve`, {}, ownerA.cookie)).status).toBe(404);
    expect(
      (await request(app).patch(`/api/admin-portal/notices/${real.id}`).set("Cookie", ownerA.cookie).send({ title: "x" })).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/admin-portal/notices/${real.id}`).set("Cookie", ownerA.cookie)).status).toBe(404);
    expect((await request(app).get("/api/admin-portal/notices").set("Cookie", ownerA.cookie)).status).toBe(404);

    const row = await runAsOwner((tx) => tx.platformNotice.findUniqueOrThrow({ where: { id: real.id } }));
    expect(row.title).toBe("Real one");
    expect(row.resolvedAt).toBeNull();
  });

  it("a logged-out request is refused", async () => {
    expect((await request(app).post("/api/admin-portal/notices").send({ title: "t", body: "b", severity: "info" })).status).toBe(401);
    expect((await request(app).get("/api/platform-notices")).status).toBe(401);
  });

  it("refuses a bad severity, an empty title and an end before the start", async () => {
    expect((await adminPost("", { title: "t", body: "b", severity: "panic" })).status).toBe(400);
    expect((await adminPost("", { title: " ", body: "b", severity: "info" })).status).toBe(400);
    const res = await adminPost("", {
      title: "t",
      body: "b",
      severity: "maintenance",
      startsAt: "2030-01-02T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_window");
  });

  it("the admin edits, resolves and deletes one", async () => {
    const n = await post({ title: "Slow calendar", body: "Looking into it", severity: "issue" });
    const edit = await request(app)
      .patch(`/api/admin-portal/notices/${n.id}`)
      .set("Cookie", admin.cookie)
      .send({ title: "Calendar is slow", severity: "maintenance" });
    expect(edit.status).toBe(200);
    expect(edit.body.notice).toMatchObject({ title: "Calendar is slow", severity: "maintenance", state: "active" });

    const resolved = await adminPost(`/${n.id}/resolve`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.notice.state).toBe("resolved");

    const list = await request(app).get("/api/admin-portal/notices").set("Cookie", admin.cookie);
    expect(list.body.notices.some((x: { id: string }) => x.id === n.id)).toBe(true);

    expect((await request(app).delete(`/api/admin-portal/notices/${n.id}`).set("Cookie", admin.cookie)).status).toBe(200);
    expect((await request(app).delete(`/api/admin-portal/notices/${n.id}`).set("Cookie", admin.cookie)).status).toBe(404);
  });
});

describe("what a barber sees", () => {
  it("🔴 a live notice - not a scheduled, ended or long-fixed one; a just-fixed one as resolved", async () => {
    const now = Date.now();
    const live = await post({ title: "Texts are delayed", body: "We're on it", severity: "issue" });
    const future = await seed({ title: "future", startsAt: new Date(now + 3_600_000) });
    const ended = await seed({ title: "ended", startsAt: new Date(now - 7_200_000), endsAt: new Date(now - 60_000) });
    const oldFix = await seed({ title: "old fix", startsAt: new Date(now - 86_400_000), resolvedAt: new Date(now - 7 * 3_600_000) });
    const newFix = await seed({ title: "new fix", startsAt: new Date(now - 7_200_000), resolvedAt: new Date(now - 3_600_000) });

    const seen = await listFor(staff.cookie);
    const byId = new Map(seen.map((n) => [n.id, n]));
    expect(byId.get(live.id)?.state).toBe("active");
    expect(byId.get(newFix)?.state).toBe("resolved");
    for (const hidden of [future, ended, oldFix]) expect(byId.has(hidden)).toBe(false);
    // Nothing about who posted it, or whether it pushed.
    expect(Object.keys(byId.get(live.id)!).sort()).toEqual(
      ["body", "dismissed", "endsAt", "id", "resolvedAt", "severity", "startsAt", "state", "title"],
    );
  });

  it("🔴 closing the banner closes it for that person only, and a newer notice shows again", async () => {
    // The banner shows what is NOT dismissed; the bell lists every live one.
    const bannerFor = async (cookie: string) => (await listFor(cookie)).filter((n) => !n.dismissed).map((n) => n.id);
    const first = await post({ title: "Booking page hiccup", body: "Fixing now", severity: "issue" });
    expect(await bannerFor(ownerA.cookie)).toContain(first.id);

    const dismiss = await request(app).post(`/api/platform-notices/${first.id}/dismiss`).set("Cookie", ownerA.cookie);
    expect(dismiss.status).toBe(200);

    expect(await bannerFor(ownerA.cookie)).not.toContain(first.id);
    // Still listed (for the bell), marked closed.
    expect((await listFor(ownerA.cookie)).find((n) => n.id === first.id)?.dismissed).toBe(true);
    // Someone else still has it open.
    expect(await bannerFor(ownerB.cookie)).toContain(first.id);

    const second = await post({ title: "Maintenance tonight", body: "10pm for 15 minutes", severity: "maintenance" });
    const after = await bannerFor(ownerA.cookie);
    expect(after).toContain(second.id);
    expect(after).not.toContain(first.id);
  });

  it("dismissing a notice that does not exist is a 404", async () => {
    const res = await request(app).post("/api/platform-notices/does-not-exist/dismiss").set("Cookie", ownerA.cookie);
    expect(res.status).toBe(404);
  });
});

describe("notify phones", () => {
  const mine = () => sentTo.filter((t) => Object.values(tokens).includes(t));

  it("🔴 pushes shop OWNERS exactly once - a second ask sends nothing", async () => {
    __setNoticePushModeForTests("live");
    sentTo.length = 0;
    const n = await post({ title: "Payments are down", body: "Card payments fail.\nCash still works.", severity: "issue", notifyPhones: true });
    expect(n.push).toBe("sending");
    await vi.waitFor(() => expect(mine().sort()).toEqual([tokens.a, tokens.b].sort()), { timeout: 5000 });
    // Never the device of someone who owns no shop.
    expect(mine()).not.toContain(tokens.staff);

    const row = await runAsOwner((tx) => tx.platformNotice.findUniqueOrThrow({ where: { id: n.id } }));
    expect(row.pushedAt).not.toBeNull();

    const again = await request(app)
      .patch(`/api/admin-portal/notices/${n.id}`)
      .set("Cookie", admin.cookie)
      .send({ notifyPhones: true });
    expect(again.status).toBe(200);
    expect(again.body.push).toBe("already_sent");
    // Give a wrongly-started second fan-out the time it would need to show.
    await new Promise((r) => setTimeout(r, 300));
    expect(mine().filter((t) => t === tokens.a)).toHaveLength(1);
    expect(mine().filter((t) => t === tokens.b)).toHaveLength(1);
  });

  it("without the box ticked, nothing is sent", async () => {
    __setNoticePushModeForTests("live");
    sentTo.length = 0;
    const n = await post({ title: "FYI", body: "New help articles", severity: "info" });
    expect(n.push).toBe("not_requested");
    await new Promise((r) => setTimeout(r, 200));
    expect(mine()).toEqual([]);
  });

  it("🔴 DRY_RUN sends nothing and stamps nothing - even with a working transport", async () => {
    __setNoticePushModeForTests("dry_run");
    sentTo.length = 0;
    const n = await post({ title: "Simulated", body: "Should not buzz", severity: "issue", notifyPhones: true });
    expect(n.push).toBe("dry_run");
    await new Promise((r) => setTimeout(r, 300));
    expect(mine()).toEqual([]);
    const row = await runAsOwner((tx) => tx.platformNotice.findUniqueOrThrow({ where: { id: n.id } }));
    expect(row.pushedAt).toBeNull();
  });
});
