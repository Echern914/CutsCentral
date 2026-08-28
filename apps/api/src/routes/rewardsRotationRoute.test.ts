import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/** Wallet readiness is a narrow seam so the preflight is deterministic: the
 * shared test database's registration rows come and go with other suites. */
type Readiness = import("../wallet/pass.js").WalletDeliveryReadiness;
const readiness = vi.hoisted(() => vi.fn((): Readiness => "ready"));
vi.mock("../wallet/pass.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../wallet/pass.js")>();
  return { ...real, walletDeliveryReadiness: readiness };
});

import { createApp } from "../app.js";
import { ROTATE_ALL_KIND } from "../services/rewardsRotation.js";

/**
 * The admin endpoint's CONTRACT - not the traversal (that is the durable
 * worker's, tested in services/rewardsRotation.test.ts).
 *
 * What matters here: three independent gates, a prompt 202 that never holds
 * the request open across the customer table, exactly one run under
 * concurrent submissions, and a status read that carries counts only.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let adminCookie: string;
let plainCookie: string;

async function signup(label: string, admin: boolean): Promise<string> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  if (admin) await prisma.user.update({ where: { email }, data: { isAdmin: true } });
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

const post = (cookie: string, body: object) =>
  request(app).post("/api/admin-portal/rotate-all-rewards-links").set("Cookie", cookie).send(body);

const CONFIRM = { confirm: "ROTATE ALL REWARDS LINKS" };

/** A shop with one client holding a Wallet pass - the situation the preflight
 * exists to protect: rotating would kill the URL baked into that pass's QR. */
async function shopWithWalletPass(): Promise<{ clientId: string; token: string }> {
  const email = `rotr-pass-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "rotr-pass", smsAttested: true });
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Pass Holder Cuts", smsAttested: true });
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookie)
    .send({ firstName: "PassHolder" });
  await prisma.walletPassRegistration.create({
    data: {
      shopId: shop.body.id,
      clientId: created.body.id,
      deviceLibraryIdentifier: `dev-${randomToken(6)}`,
      pushToken: randomToken(8),
    },
  });
  const row = await prisma.client.findUnique({ where: { id: created.body.id } });
  return { clientId: created.body.id as string, token: row!.magicToken };
}

beforeEach(async () => {
  if (!adminCookie) adminCookie = await signup("rotr-admin", true);
  if (!plainCookie) plainCookie = await signup("rotr-plain", false);
  process.env.REWARDS_ROTATE_ALL_ENABLED = "true";
  readiness.mockReset();
  readiness.mockReturnValue("ready");
});

afterEach(async () => {
  delete process.env.REWARDS_ROTATE_ALL_ENABLED;
  await prisma.platformOperation.deleteMany({ where: { kind: ROTATE_ALL_KIND } });
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

describe("the gates", () => {
  it("the production gate DEFAULTS FALSE - unset refuses, and nothing is created", async () => {
    delete process.env.REWARDS_ROTATE_ALL_ENABLED;
    const res = await post(adminCookie, CONFIRM);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "rotation_disabled" });
    expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(0);
  });

  it("fails closed on anything that is not exactly \"true\"", async () => {
    for (const value of ["false", "1", "TRUE", "yes", ""]) {
      process.env.REWARDS_ROTATE_ALL_ENABLED = value;
      expect((await post(adminCookie, CONFIRM)).status).toBe(403);
    }
    expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(0);
  });

  it("enabling the gate alone starts NOTHING", async () => {
    const status = await request(app)
      .get("/api/admin-portal/rotate-all-rewards-links")
      .set("Cookie", adminCookie);
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.run).toBeNull();
    expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(0);
  });

  it("requires the exact confirm phrase", async () => {
    for (const body of [{}, { confirm: "rotate all rewards links" }, { confirm: "yes" }]) {
      const res = await post(adminCookie, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "confirm_phrase_required" });
    }
    expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(0);
  });

  it("refuses a non-admin outright", async () => {
    const res = await post(plainCookie, CONFIRM);
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(0);
  });
});

describe("the wallet-refresh preflight", () => {
  for (const state of ["unconfigured", "suppressed"] as const) {
    it(`answers 409 when passes exist and wallet delivery is ${state}`, async () => {
      const held = await shopWithWalletPass();
      readiness.mockReturnValue(state);

      const res = await post(adminCookie, CONFIRM);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "wallet_refresh_unavailable" });
      // Nothing created, nothing rotated, nothing enqueued.
      expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(0);
      expect(await prisma.platformOperationPassTask.count()).toBe(0);
      const after = await prisma.client.findUnique({ where: { id: held.clientId } });
      expect(after!.magicToken).toBe(held.token);
    });
  }

  it("the refusal carries a FIXED classification - no provider or config detail", async () => {
    await shopWithWalletPass();
    readiness.mockReturnValue("unconfigured");
    const res = await post(adminCookie, CONFIRM);
    expect(Object.keys(res.body)).toEqual(["error"]);
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/WALLET_|cert|APNs|apns|DRY_RUN/);
  });

  it("GET status stays available while delivery is unavailable", async () => {
    readiness.mockReturnValue("unconfigured");
    const res = await request(app)
      .get("/api/admin-portal/rotate-all-rewards-links")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.run).toBeNull();
  });
});

describe("the durable hand-off", () => {
  it("answers 202 PROMPTLY with a run id, without traversing anything", async () => {
    const started = Date.now();
    const res = await post(adminCookie, CONFIRM);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.runId).toBe("string");
    expect(res.body.created).toBe(true);
    // The handler creates one row and returns; it must not be doing table work.
    expect(elapsed).toBeLessThan(2000);

    const row = await prisma.platformOperation.findUnique({ where: { id: res.body.runId } });
    expect(row!.status).toBe("PENDING");
    expect(row!.rotatedCount).toBe(0); // nothing rotated by the request itself
    expect(row!.startedAt).toBeNull();
  });

  it("two concurrent submissions produce exactly ONE run", async () => {
    const responses = await Promise.all([
      post(adminCookie, CONFIRM),
      post(adminCookie, CONFIRM),
      post(adminCookie, CONFIRM),
    ]);
    for (const r of responses) expect(r.status).toBe(202);
    const ids = new Set(responses.map((r) => r.body.runId));
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.body.created)).toHaveLength(1);
    expect(await prisma.platformOperation.count({ where: { kind: ROTATE_ALL_KIND } })).toBe(1);
  });

  it("a repeat submission joins the existing run instead of starting another", async () => {
    const first = await post(adminCookie, CONFIRM);
    const second = await post(adminCookie, CONFIRM);
    expect(second.status).toBe(202);
    expect(second.body.runId).toBe(first.body.runId);
    expect(second.body.created).toBe(false);
  });

  it("the status read returns counts and state ONLY", async () => {
    const created = await post(adminCookie, CONFIRM);
    const res = await request(app)
      .get("/api/admin-portal/rotate-all-rewards-links")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.run).sort()).toEqual(
      [
        "completedAt",
        "createdAt",
        "cutoffAt",
        "errorCode",
        "failedAt",
        "passFailed",
        "passPending",
        "passSucceeded",
        "rotated",
        "runId",
        "startedAt",
        "status",
      ].sort(),
    );
    expect(res.body.run.runId).toBe(created.body.runId);
    // No client-shaped anything can appear: there is no such field.
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/https?:\/\//);
    expect(flat).not.toContain("/r/");
    expect(flat).not.toMatch(/\+1\d{10}/);
  });

  it("the status read is admin-only", async () => {
    const res = await request(app)
      .get("/api/admin-portal/rotate-all-rewards-links")
      .set("Cookie", plainCookie);
    expect(res.status).toBeGreaterThanOrEqual(403);
  });
});
