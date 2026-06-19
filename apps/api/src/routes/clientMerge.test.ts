import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Client merge through the HTTP surface. Covers the high-risk behavior the
 * service guarantees: the winner's balance becomes the SUM of both ledgers, the
 * loser's visits move (and cadence recomputes), consent reconciles
 * opted-out-wins + earliest-consent-wins, the loser is soft-archived (hidden but
 * recoverable), and a foreign or self id is rejected.
 */
const app = createApp();
const emailA = `mrg-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `mrg-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let shopIdA: string;

async function signupAndShop(email: string, shopName: string): Promise<{ cookie: string; shopId: string }> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Merge Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://merge.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie, shopId: shop.body.id };
}

async function addClient(cookie: string, firstName: string): Promise<string> {
  const res = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookie)
    .send({ firstName });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Log a COMPLETED manual visit for a client (earns the base rate). */
async function logVisit(cookie: string, clientId: string, when?: string): Promise<void> {
  const res = await request(app)
    .post(`/api/dashboard/clients/${clientId}/visits`)
    .set("Cookie", cookie)
    .send(when ? { when } : {});
  expect(res.status).toBe(201);
}

async function balanceOf(cookie: string, clientId: string): Promise<number> {
  const res = await request(app)
    .get(`/api/dashboard/clients/${clientId}/ledger`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.balance as number;
}

beforeAll(async () => {
  const a = await signupAndShop(emailA, "Merge Cuts A");
  cookieA = a.cookie;
  shopIdA = a.shopId;
  const b = await signupAndShop(emailB, "Merge Cuts B");
  cookieB = b.cookie;
});

afterAll(async () => {
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("client merge routes", () => {
  it("requires auth", async () => {
    const res = await request(app).post("/api/dashboard/clients/whatever/merge");
    expect(res.status).toBe(401);
  });

  it("rejects merging a client into itself", async () => {
    const id = await addClient(cookieA, "Selfie");
    const res = await request(app)
      .post(`/api/dashboard/clients/${id}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("same_client");
  });

  it("404s a foreign loser id (cross-tenant isolation)", async () => {
    const winner = await addClient(cookieA, "WinnerX");
    const foreign = await addClient(cookieB, "OtherShop");
    const res = await request(app)
      .post(`/api/dashboard/clients/${winner}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: foreign });
    expect(res.status).toBe(404);
  });

  it("sums balances, moves visits, and archives the loser", async () => {
    const winner = await addClient(cookieA, "Keeper");
    const loser = await addClient(cookieA, "Dupe");
    // Winner has 2 punches (2 visits), loser has 1 (1 visit) - on different days
    // so the winner ends up with a real 2-visit cadence after the merge.
    await logVisit(cookieA, winner, new Date("2026-01-01T12:00:00Z").toISOString());
    await logVisit(cookieA, winner, new Date("2026-02-01T12:00:00Z").toISOString());
    await logVisit(cookieA, loser, new Date("2026-03-01T12:00:00Z").toISOString());
    expect(await balanceOf(cookieA, winner)).toBe(2);
    expect(await balanceOf(cookieA, loser)).toBe(1);

    const res = await request(app)
      .post(`/api/dashboard/clients/${winner}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: loser });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(3); // 2 + 1
    expect(res.body.movedVisits).toBe(1);

    // Winner now holds the summed balance and all 3 visits.
    expect(await balanceOf(cookieA, winner)).toBe(3);
    const detail = await request(app)
      .get(`/api/dashboard/clients/${winner}`)
      .set("Cookie", cookieA);
    expect(detail.body.visits).toHaveLength(3);
    // Cadence recomputed from the now-3 completed visits.
    expect(detail.body.client.medianIntervalDays).not.toBeNull();

    // Loser is archived (hidden from the active list, reachable by id).
    const loserDetail = await request(app)
      .get(`/api/dashboard/clients/${loser}`)
      .set("Cookie", cookieA);
    expect(loserDetail.body.client.archived).toBe(true);
    const list = await request(app)
      .get("/api/dashboard/clients")
      .set("Cookie", cookieA);
    expect((list.body.clients as { id: string }[]).map((c) => c.id)).not.toContain(loser);
  });

  it("reconciles consent: opted-out wins, earliest consent wins", async () => {
    const winner = await addClient(cookieA, "WConsent");
    const loser = await addClient(cookieA, "LConsent");
    // Winner: consented LATE, not opted out. Loser: consented EARLY, opted out.
    await forShop(shopIdA).client.update({
      where: { id: winner },
      data: { optedOut: false, smsConsentAt: new Date("2026-05-01T00:00:00Z"), smsConsentSource: "manual" },
    });
    await forShop(shopIdA).client.update({
      where: { id: loser },
      data: { optedOut: true, smsConsentAt: new Date("2026-01-01T00:00:00Z"), smsConsentSource: "join_page" },
    });

    const res = await request(app)
      .post(`/api/dashboard/clients/${winner}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: loser });
    expect(res.status).toBe(200);

    const merged = await forShop(shopIdA).client.findFirst({ where: { id: winner } });
    expect(merged?.optedOut).toBe(true); // a STOP on either record wins
    expect(merged?.smsConsentAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z"); // earliest
    expect(merged?.smsConsentSource).toBe("join_page"); // source of the earliest
  });

  it("keeps balance correct when the loser's ledger had a reversal", async () => {
    const winner = await addClient(cookieA, "WRev");
    const loser = await addClient(cookieA, "LRev");
    await logVisit(cookieA, winner); // winner +1
    await logVisit(cookieA, loser); // loser +1

    // Undo the loser's only punch via the ledger reverse endpoint (writes an
    // offsetting correction row); loser balance returns to 0.
    const ledger = await request(app)
      .get(`/api/dashboard/clients/${loser}/ledger`)
      .set("Cookie", cookieA);
    const earn = (ledger.body.entries as { id: string; earned: number }[]).find((e) => e.earned > 0)!;
    const undo = await request(app)
      .post(`/api/dashboard/clients/${loser}/ledger/${earn.id}/reverse`)
      .set("Cookie", cookieA);
    expect(undo.status).toBe(200);
    expect(await balanceOf(cookieA, loser)).toBe(0);

    // Merge: the earn + its correction move together, so the winner keeps just
    // its own +1 (loser contributes a net 0), not a phantom punch.
    const res = await request(app)
      .post(`/api/dashboard/clients/${winner}/merge`)
      .set("Cookie", cookieA)
      .send({ loserId: loser });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(1);
    expect(await balanceOf(cookieA, winner)).toBe(1);
  });
});
