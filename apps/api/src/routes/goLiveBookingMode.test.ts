import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { ACUITY, randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { ingestAppointment } from "../ingest.js";
import { OAUTH_STATE_COOKIE, createOAuthState } from "../acuity/oauth.js";
import type { AcuityAppointment } from "../acuity/types.js";

/**
 * Go Live for a shop whose customers book somewhere else, end to end.
 *
 * THE BUG: an Acuity shop's services were showing up (as the names on its
 * synced visits) while Go Live insisted it "Add a service" - a ChairBack menu no
 * customer of that shop could ever book. The engine's rules are covered one at
 * a time in engines/readiness.test.ts. What only a real request can prove is
 * here: history synced through the REAL ingest path, the collector reading real
 * rows, the full report and the badge summary agreeing, the page payload the
 * Book button is built from, the walk-in kiosk still refusing an empty menu, and
 * the Acuity connect callback leaving booking mode and publication alone.
 */
const app = createApp();

const password = "correct horse battery staple";
const emails: string[] = [];
let ownerCookie = "";
let shopId = "";
let slug = "";

const ACUITY_LINK = "https://fixture-studio.as.me/schedule.php";

interface WireItem {
  id: string;
  applicable: boolean;
  done: boolean;
  blocksLaunch: boolean;
  evidence: string;
}
interface Report {
  canGoLive: boolean;
  liveNow: boolean;
  blocking: WireItem[];
  items: WireItem[];
  milestones: { id: string; applicable: boolean; done: boolean }[];
  milestonesComplete: number;
  milestonesBlocking: number;
  milestonesApplicable: number;
}

async function signup(email: string): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Fixture Owner", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function report(cookie = ownerCookie): Promise<Report> {
  const res = await request(app).get("/api/readiness").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as Report;
}

async function summary(cookie = ownerCookie) {
  const res = await request(app).get("/api/readiness/summary").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as {
    milestonesComplete: number;
    milestonesTotal: number;
    milestonesBlocking: number;
    canGoLive: boolean;
    nextMilestone: { id: string } | null;
  };
}

const item = (r: Report, id: string) => r.items.find((i) => i.id === id)!;
const blockingIds = (r: Report) => r.blocking.map((b) => b.id).sort();

async function patchShop(body: Record<string, unknown>) {
  const res = await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send(body);
  return res;
}

/** An Acuity appointment as GET /appointments returns it (the fields we read). */
function acuityAppt(id: number, daysAgo: number, type: string, price: string, duration: number): AcuityAppointment {
  const start = new Date(Date.now() - daysAgo * 86_400_000);
  start.setUTCHours(15, 0, 0, 0);
  return {
    id: String(id),
    firstName: `Fixture${id}`,
    lastName: "Client",
    phone: `+1302555${String(1000 + id).slice(-4)}`,
    email: `fixture${id}@example.invalid`,
    datetime: start.toISOString(),
    endTime: new Date(start.getTime() + duration * 60_000).toISOString(),
    price,
    type,
    appointmentTypeID: 70000 + id,
    calendarID: 555001,
    canceled: false,
    noShow: false,
    duration,
  };
}

beforeAll(async () => {
  ownerCookie = await signup(`golive-${randomToken(6).toLowerCase()}@test.chairback`);
  expect(
    (
      await request(app)
        .post("/api/shops")
        .set("Cookie", ownerCookie)
        .send({ name: "Fixture Acuity Studio", smsAttested: true })
    ).status,
  ).toBe(201);
  const me = await request(app).get("/api/shops/me").set("Cookie", ownerCookie);
  shopId = me.body.id;
  slug = me.body.slug;
  expect(shopId).toBeTruthy();

  // What a finished Acuity connect leaves behind: the connection and live
  // webhook subscriptions. No token is ever decrypted on these paths.
  await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: "fixture-account", accessToken: "fixture-not-a-token" },
  });
  await prisma.shop.update({
    where: { id: shopId },
    data: { acuityWebhookIds: ["fixture-wh-1", "fixture-wh-2"] },
  });
  const patched = await patchShop({ bookingMode: "acuity", bookingUrl: ACUITY_LINK, timezone: "UTC" });
  expect(patched.status).toBe(200);

  // History through the backfill's own write path.
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  for (const appt of [
    acuityAppt(9101, 3, "Silk Press", "85.00", 90),
    acuityAppt(9102, 5, "Silk Press", "85.00", 90),
    acuityAppt(9103, 6, "Trim", "35.00", 30),
  ]) {
    await ingestAppointment(shop, "scheduled", appt.id, appt);
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("an Acuity shop's synced services", () => {
  it("are names on its visits - no ChairBack service exists behind them", async () => {
    expect(await prisma.service.count({ where: { shopId } })).toBe(0);
    const names = await prisma.visit.findMany({ where: { shopId }, select: { serviceName: true } });
    expect(new Set(names.map((v) => v.serviceName))).toEqual(new Set(["Silk Press", "Trim"]));
  });
});

describe("Go Live on Acuity booking", () => {
  it("passes on the Acuity link alone: no ChairBack services, chairs or alert device", async () => {
    await patchShop({ bookingMode: "acuity" });
    const r = await report();
    expect(blockingIds(r)).toEqual([]);
    expect(r.canGoLive).toBe(true);
    for (const id of ["shop.service.active", "shop.staff.active", "shop.alerts.reachable", "shop.test_booking"]) {
      expect(item(r, id).applicable, id).toBe(false);
    }
    expect(item(r, "shop.booking_source").done).toBe(true);
    expect(item(r, "integration.connected").done).toBe(true);
    expect(item(r, "integration.live_sync").done).toBe(true);
  });

  it("the badge, the next step and the progress count all agree", async () => {
    await patchShop({ bookingMode: "acuity" });
    const r = await report();
    const s = await summary();
    // Nothing to set up for booking, so it is left out rather than shown done.
    expect(r.milestones.find((m) => m.id === "services_and_barber")!.applicable).toBe(false);
    expect(r.milestones).toHaveLength(4);
    expect(s.milestonesBlocking).toBe(0); // the bell: no "steps before you can go live"
    expect(s.nextMilestone).toBeNull(); // the Continue setup card has nothing to show
    expect(s.canGoLive).toBe(true);
    expect(s.milestonesTotal).toBe(r.milestonesApplicable);
    expect(s.milestonesComplete).toBe(s.milestonesTotal);
  });

  it("the Book button is the Acuity link, and ChairBack's booking page stays closed", async () => {
    await patchShop({ bookingMode: "acuity" });
    const page = await request(app).get(`/api/page/${slug}`);
    expect(page.status).toBe(200);
    expect(page.body.bookingMode).toBe("acuity");
    expect(page.body.bookingUrl).toBe(ACUITY_LINK);
    expect((await request(app).get(`/api/book/${slug}`)).status).toBe(404);
  });

  it("a missing link still blocks - it is the one thing an Acuity shop's customers need", async () => {
    await patchShop({ bookingMode: "acuity" });
    expect((await patchShop({ bookingUrl: "" })).status).toBe(200);
    try {
      const r = await report();
      expect(blockingIds(r)).toEqual(["shop.booking_source", "shop.preflight"]);
      expect(r.canGoLive).toBe(false);
      expect(r.liveNow).toBe(false);
      const s = await summary();
      expect(s.nextMilestone?.id).toBe("shop");
    } finally {
      await patchShop({ bookingUrl: ACUITY_LINK });
    }
  });

  it("so does a stored link no customer could open", async () => {
    await patchShop({ bookingMode: "acuity" });
    // The API will not store one...
    expect((await patchShop({ bookingUrl: "javascript:alert(1)" })).status).toBe(400);
    // ...but readiness reads the row, so a value that got there another way
    // must not pass for a working Book button.
    await prisma.shop.update({ where: { id: shopId }, data: { bookingUrl: "not a link" } });
    try {
      const r = await report();
      expect(blockingIds(r)).toEqual(["shop.booking_source", "shop.preflight"]);
      expect(item(r, "shop.booking_source").evidence).toContain("not a web address");
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { bookingUrl: ACUITY_LINK } });
    }
  });
});

describe("Go Live on the shop's own link", () => {
  it("passes on the link, and never asks for Acuity even while it is still connected", async () => {
    await patchShop({ bookingMode: "link" });
    try {
      const r = await report();
      expect(r.canGoLive).toBe(true);
      expect(item(r, "shop.service.active").applicable).toBe(false);
      expect(item(r, "integration.connected").applicable).toBe(false);
      expect(item(r, "integration.live_sync").applicable).toBe(false);
      expect((await request(app).get(`/api/book/${slug}`)).status).toBe(404);
    } finally {
      await patchShop({ bookingMode: "acuity" });
    }
  });
});

describe("switching to ChairBack booking", () => {
  it("restores every native requirement at once, and Go Live stops on the empty menu", async () => {
    await patchShop({ bookingMode: "native" });
    try {
      const r = await report();
      expect(r.canGoLive).toBe(false);
      for (const id of ["shop.service.active", "shop.staff.active", "shop.alerts.reachable"]) {
        expect(item(r, id).applicable, id).toBe(true);
        expect(blockingIds(r), id).toContain(id);
      }
      expect(r.milestones.every((m) => m.applicable)).toBe(true);
      const s = await summary();
      expect(s.milestonesTotal).toBe(4);
      expect(s.nextMilestone?.id).toBe("services_and_barber");
      expect(s.canGoLive).toBe(false);
    } finally {
      await patchShop({ bookingMode: "acuity" });
    }
  });
});

describe("the walk-in kiosk on an Acuity shop", () => {
  beforeAll(() => {
    process.env.WALK_IN_MODE_ENABLED = "true";
    __resetEnvCacheForTests();
  });
  afterAll(() => {
    delete process.env.WALK_IN_MODE_ENABLED;
    __resetEnvCacheForTests();
  });

  it("still refuses to open with no ChairBack menu - a walk-in is a ChairBack booking", async () => {
    await patchShop({ bookingMode: "acuity" });
    const res = await request(app)
      .post("/api/shops/me/walk-in-kiosk-token")
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("shop_not_ready");
    expect(res.body.blockers.map((b: { id: string }) => b.id).sort()).toEqual([
      "shop.service.active",
      "shop.staff.active",
    ]);
  });
});

describe("connecting Acuity", () => {
  it("changes neither the booking mode nor what is published, and creates no service", async () => {
    const cookie = await signup(`golive-cb-${randomToken(6).toLowerCase()}@test.chairback`);
    expect(
      (
        await request(app)
          .post("/api/shops")
          .set("Cookie", cookie)
          .send({ name: "Fixture Connect Studio", smsAttested: true })
      ).status,
    ).toBe(201);
    const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
    const connectShopId: string = me.body.id;
    // Unpublished on purpose, so a callback that switched the page on shows.
    await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ publicPageEnabled: false });
    const before = await prisma.shop.findUniqueOrThrow({
      where: { id: connectShopId },
      select: { bookingMode: true, bookingUrl: true, publicPageEnabled: true },
    });
    expect(before.publicPageEnabled).toBe(false);

    // Acuity, stubbed at the network edge: token, account, webhook subscriptions
    // and the history backfill the callback starts in the background.
    const realFetch = globalThis.fetch;
    let webhookId = 0;
    let backfillCalls = 0;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === ACUITY.tokenUrl) {
          return json({ access_token: "fixture-access", token_type: "Bearer", expires_in: 3600 });
        }
        if (url === `${ACUITY.apiBase}/me`) return json({ id: 424242 });
        if (url === `${ACUITY.apiBase}/webhooks`) return json({ id: ++webhookId });
        if (url.startsWith(`${ACUITY.apiBase}/appointments`) || url.startsWith(`${ACUITY.apiBase}/blocks`)) {
          backfillCalls++;
          return json([]);
        }
        return realFetch(input, init);
      }),
    );

    try {
      const state = createOAuthState(connectShopId, Math.floor(Date.now() / 1000));
      const res = await request(app)
        .get(`/api/acuity/oauth/callback?code=fixture-code&state=${encodeURIComponent(state)}`)
        .set("Cookie", `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/onboarding\/done$/);

      // Let the background backfill finish against the stub before asserting.
      for (let i = 0; i < 50 && backfillCalls === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(backfillCalls).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 200));

      const after = await prisma.shop.findUniqueOrThrow({
        where: { id: connectShopId },
        select: { bookingMode: true, bookingUrl: true, publicPageEnabled: true, acuityWebhookIds: true },
      });
      expect(await prisma.acuityConnection.count({ where: { shopId: connectShopId } })).toBe(1);
      expect(after.acuityWebhookIds.length).toBeGreaterThan(0);
      expect(after.bookingMode).toBe(before.bookingMode);
      expect(after.bookingUrl).toBe(before.bookingUrl);
      expect(after.publicPageEnabled).toBe(false);
      expect(await prisma.service.count({ where: { shopId: connectShopId } })).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
