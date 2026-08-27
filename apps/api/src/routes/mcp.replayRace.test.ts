import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * 🔴 THE IN-FLIGHT STALE-CODE REPLAY RACE.
 *
 * Deleting stale codes at re-consent stops a stale code being LOADED. It cannot,
 * on its own, stop one that was loaded a moment earlier and is still in flight:
 *
 *   1. a replay loads consumed code A
 *   2. re-consent deletes code A and reactivates the reused connection
 *   3. the in-flight replay resumes
 *   4. it revokes the connection - the REPLACEMENT grant, which it was never
 *      part of, and which the barber is actively using
 *
 * The invariant these tests hold to: an old replay either completes BEFORE
 * re-consent and is superseded by it, or loses AFTER re-consent and revokes
 * nothing. It may never revoke the replacement grant.
 *
 * 🔴 NO SLEEPS. The window is pried open deterministically: `loadAuthCode` is
 * wrapped so that one designated call parks on a barrier promise AFTER doing its
 * real read and BEFORE returning, which is exactly the point between step 1 and
 * step 3. A timing-based version of this test would pass on a fast machine and
 * prove nothing.
 */

/** A promise the test resolves by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}
type Deferred = ReturnType<typeof deferred>;
interface Gate {
  reached: Deferred;
  release: Deferred;
}

/** Set by a test to park the NEXT loadAuthCode call. Null = pass through. */
let parkNext: Gate | null = null;

vi.mock("../mcp/tokens.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/tokens.js")>();
  return {
    ...actual,
    loadAuthCode: async (raw: string) => {
      const row = await actual.loadAuthCode(raw);
      if (parkNext) {
        const gate = parkNext;
        parkNext = null; // one-shot; re-consent's own reads must not park
        gate.reached.resolve();
        await gate.release.promise;
      }
      return row;
    },
  };
});

const { createApp } = await import("../app.js");
const app = createApp();

const password = "correct horse battery staple";
const emails: string[] = [];
const REDIRECT = "https://client.example/cb/callback";

let ownerCookie: string;
let shopId: string;
let clientId: string;

const makeVerifier = () => randomBytes(32).toString("base64url");
const challengeFor = (v: string) => createHash("sha256").update(v, "ascii").digest("base64url");

async function signup(email: string): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Race", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function registerClient(name = "Race Client"): Promise<string> {
  const res = await request(app)
    .post("/mcp/oauth/register")
    .send({ client_name: name, redirect_uris: [REDIRECT] });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

async function consent(cid: string): Promise<{ code: string; verifier: string }> {
  const verifier = makeVerifier();
  const res = await request(app)
    .post("/mcp/oauth/authorize/approve")
    .set("Cookie", ownerCookie)
    .send({ client_id: cid, redirect_uri: REDIRECT, code_challenge: challengeFor(verifier) });
  expect(res.status).toBe(200);
  return { code: new URL(res.body.redirect_to).searchParams.get("code")!, verifier };
}

const redeem = (cid: string, code: string, verifier: string) =>
  request(app).post("/mcp/oauth/token").send({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: cid,
  });

async function connect(cid: string) {
  const { code, verifier } = await consent(cid);
  const t = await redeem(cid, code, verifier);
  expect(t.status).toBe(200);
  return { ...t.body, code, verifier } as {
    access_token: string;
    refresh_token: string;
    code: string;
    verifier: string;
  };
}

const mcp = (token: string) =>
  request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

const GENERIC = { error: "invalid_grant", error_description: "authorization code is not valid" };

beforeAll(async () => {
  ownerCookie = await signup(`race-${randomToken(6).toLowerCase()}@test.chairback`);
  expect(
    (
      await request(app)
        .post("/api/shops")
        .set("Cookie", ownerCookie)
        .send({ name: "Race Cuts", smsAttested: true })
    ).status,
  ).toBe(201);
  const me = await request(app).get("/api/shops/me").set("Cookie", ownerCookie);
  shopId = me.body.id;
});

beforeEach(async () => {
  parkNext = null;
  clientId = await registerClient();
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.mcpClient.deleteMany({ where: { clientName: { contains: "Race Client" } } });
});

describe("🔴 an in-flight replay cannot revoke a grant created after it started", () => {
  it("replay parked mid-flight, re-consent completes, replay loses", async () => {
    // 1. Connect with code A.
    const a = await connect(clientId);
    expect((await mcp(a.access_token)).status).toBe(200);

    // A sibling assistant, same user and same shop, that must be untouched.
    const siblingClient = await registerClient("Race Client Sibling");
    const sibling = await connect(siblingClient);
    expect((await mcp(sibling.access_token)).status).toBe(200);

    // 2. Start the replay of A and park it AFTER the code load, BEFORE the
    //    replay-revocation path runs.
    const gate: Gate = { reached: deferred(), release: deferred() };
    parkNext = gate;
    const replayInFlight = redeem(clientId, a.code, a.verifier).then((r) => r);
    await gate.reached.promise; // the replay is now holding a stale code row

    // 3. Re-consent and redeem code B while the replay is parked.
    const b = await connect(clientId);
    expect((await mcp(b.access_token)).status).toBe(200);

    // 4. Release the parked replay.
    gate.release.resolve();
    const replay = await replayInFlight;

    // 5. Generic invalid_grant, byte-identical to any unknown code.
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual(GENERIC);

    // 6. 🔴 THE INVARIANT: the replacement grant survived.
    expect((await mcp(b.access_token)).status).toBe(200);

    // 7. The sibling connection is untouched.
    expect((await mcp(sibling.access_token)).status).toBe(200);

    const conn = await prisma.mcpConnection.findFirstOrThrow({
      where: { shopId, client: { clientId } },
      select: { revokedAt: true },
    });
    expect(conn.revokedAt).toBeNull();

    // 8. Replaying B still revokes B - detection was not weakened to win this.
    const replayB = await redeem(clientId, b.code, b.verifier);
    expect(replayB.status).toBe(400);
    expect(replayB.body).toEqual(GENERIC);
    expect((await mcp(b.access_token)).status).toBe(401);
    expect((await mcp(sibling.access_token)).status).toBe(200);
  });

  it("the OPPOSITE ordering: replay completes first, then re-consent restores", async () => {
    const a = await connect(clientId);
    expect((await mcp(a.access_token)).status).toBe(200);

    // Replay A runs to completion with no interference: this IS a genuine
    // same-grant replay, so it must revoke.
    const replay = await redeem(clientId, a.code, a.verifier);
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual(GENERIC);
    expect((await mcp(a.access_token)).status).toBe(401);
    expect(
      (
        await prisma.mcpConnection.findFirstOrThrow({
          where: { shopId, client: { clientId } },
          select: { revokedReason: true },
        })
      ).revokedReason,
    ).toBe("replay");

    // Re-consent afterwards restores a working connection on the same row.
    const b = await connect(clientId);
    expect((await mcp(b.access_token)).status).toBe(200);
    expect(
      (
        await prisma.mcpConnection.findFirstOrThrow({
          where: { shopId, client: { clientId } },
          select: { revokedAt: true },
        })
      ).revokedAt,
    ).toBeNull();
  });

  it("a parked replay of an UNCONSUMED code also revokes nothing", async () => {
    // The harmless variant of the same interleaving: a code that was minted and
    // never redeemed. It must stop working, and must not take the revocation
    // path on the way out.
    const stale = await consent(clientId);
    const live = await connect(clientId);
    expect((await mcp(live.access_token)).status).toBe(200);

    const gate: Gate = { reached: deferred(), release: deferred() };
    parkNext = gate;
    // .then() is what DISPATCHES a supertest request - without it the request
    // never leaves the test and the barrier never trips.
    const inFlight = redeem(clientId, stale.code, stale.verifier).then((r) => r);
    await gate.reached.promise;

    const b = await connect(clientId);
    gate.release.resolve();
    const res = await inFlight;

    expect(res.status).toBe(400);
    expect(res.body).toEqual(GENERIC);
    expect((await mcp(b.access_token)).status).toBe(200);
  });

  it("the parked-replay path leaves no replay marker on a code it did not win", async () => {
    const a = await connect(clientId);
    const gate: Gate = { reached: deferred(), release: deferred() };
    parkNext = gate;
    const inFlight = redeem(clientId, a.code, a.verifier).then((r) => r);
    await gate.reached.promise;
    await connect(clientId); // deletes code A
    gate.release.resolve();
    await inFlight;

    // The row is gone entirely, so there is nothing left for a later replay to
    // resolve - and nothing was marked on a row belonging to the new grant.
    // Scoped to THIS test's client: the shop also holds codes for sibling
    // clients and for earlier cases, which are not what this asserts.
    const rows = await prisma.mcpAuthCode.findMany({
      where: { shopId, client: { clientId } },
      select: { replayDetectedAt: true, consumedAt: true },
    });
    // Exactly one row survives per tuple: code B. It IS consumed, because the
    // re-consent above redeemed it - that is the normal path.
    expect(rows.length).toBe(1);
    expect(rows[0]!.consumedAt).not.toBeNull();
    // 🔴 THE POINT: the losing replay left no replay marker on the new grant's
    // code. Had it marked this row, a later legitimate action could be read as
    // theft, and the marker is what the revocation branch keys off.
    expect(rows[0]!.replayDetectedAt).toBeNull();
  });
});
