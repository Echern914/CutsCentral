import { createHash } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { redactedReqSerializer } from "../logRedaction.js";

/**
 * The browser-to-app handoff that ends "Join your shop".
 *
 * What is actually being defended here: a code that travels in a REDIRECT URL.
 * It passes through the system browser, may land in history, and on the last
 * hop rides a custom scheme that any app on the device could register. So these
 * tests are less about the happy path (one case) and more about proving the
 * code is worthless to everyone except the app instance that started the flow -
 * without the PKCE verifier, without the matching state, or a second time.
 */
const app = createApp();

const password = "correct horse battery staple";
const emails: string[] = [];

/** RFC 7636 material: a 43-char verifier and its S256 challenge. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(32).slice(0, 43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function signup(email: string): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Barber", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

let cookie: string;
let userEmail: string;

beforeAll(async () => {
  userEmail = `mobile-${randomToken(6).toLowerCase()}@test.chairback`;
  cookie = await signup(userEmail);
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

/** Mint a code the way the web server action does, on the signed-in session. */
async function mint(state: string, challenge: string) {
  return request(app)
    .post("/api/auth/mobile/code")
    .set("Cookie", cookie)
    .send({ state, codeChallenge: challenge, codeChallengeMethod: "S256" });
}

describe("the round trip", () => {
  it("trades a code plus the verifier for a working session", async () => {
    const state = randomToken();
    const { verifier, challenge } = pkce();

    const minted = await mint(state, challenge);
    expect(minted.status).toBe(201);
    expect(minted.body.code).toBeTruthy();

    const exchanged = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.token).toBeTruthy();
    expect(exchanged.body.user.email).toBe(userEmail);

    // The token is a real session, indistinguishable from a password login's -
    // the app sends it as a bearer, so prove it works that way.
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${exchanged.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(userEmail);
  });

  it("never returns a session in anything but the response body", async () => {
    const state = randomToken();
    const { challenge } = pkce();
    const minted = await mint(state, challenge);
    // The value that travels in the callback URL is the code. It must not BE a
    // session or contain one: a session token here is three dot-separated
    // segments, a code is one opaque base64url string.
    expect(minted.body.code).not.toContain(".");
    expect(minted.body.token).toBeUndefined();
  });
});

describe("a stolen code is not enough", () => {
  it("refuses the wrong PKCE verifier", async () => {
    const state = randomToken();
    const { challenge } = pkce();
    const minted = await mint(state, challenge);

    const res = await request(app).post("/api/auth/mobile/exchange").send({
      code: minted.body.code,
      codeVerifier: pkce().verifier, // a different attempt's verifier
      state,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_or_expired");
    expect(res.body.token).toBeUndefined();
  });

  it("burns the code when the verifier is wrong, so guessing gets one shot", async () => {
    const state = randomToken();
    const { verifier, challenge } = pkce();
    const minted = await mint(state, challenge);

    await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: pkce().verifier, state });

    // Even the RIGHT verifier now fails: the failed attempt spent the code.
    const second = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state });
    expect(second.status).toBe(400);
    expect(second.body.token).toBeUndefined();
  });

  it("refuses a tampered state", async () => {
    const state = randomToken();
    const { verifier, challenge } = pkce();
    const minted = await mint(state, challenge);

    const res = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state: randomToken() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_or_expired");
  });

  it("refuses a replay of a code that already paid out", async () => {
    const state = randomToken();
    const { verifier, challenge } = pkce();
    const minted = await mint(state, challenge);

    const first = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state });
    expect(replay.status).toBe(400);
    expect(replay.body.token).toBeUndefined();
  });

  it("refuses an expired code", async () => {
    const state = randomToken();
    const { verifier, challenge } = pkce();
    const minted = await mint(state, challenge);

    // Reach in and age it rather than waiting two minutes.
    await prisma.mobileAuthCode.updateMany({
      where: { codeHash: createHash("sha256").update(minted.body.code).digest("hex") },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state });
    expect(res.status).toBe(400);
  });

  it("gives the same answer for a code that never existed", async () => {
    const res = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: randomToken(), codeVerifier: pkce().verifier, state: randomToken() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_or_expired");
  });
});

describe("minting", () => {
  it("requires a session - the code is issued to a PERSON, not a request", async () => {
    const { challenge } = pkce();
    const res = await request(app)
      .post("/api/auth/mobile/code")
      .send({ state: randomToken(), codeChallenge: challenge });
    expect(res.status).toBe(401);
  });

  it("refuses a challenge that isn't PKCE-shaped", async () => {
    const res = await mint(randomToken(), "short");
    expect(res.status).toBe(400);
  });

  it("refuses the plain challenge method outright", async () => {
    const { challenge } = pkce();
    const res = await request(app)
      .post("/api/auth/mobile/code")
      .set("Cookie", cookie)
      .send({ state: randomToken(), codeChallenge: challenge, codeChallengeMethod: "plain" });
    expect(res.status).toBe(400);
  });

  it("supersedes an abandoned attempt, leaving exactly one live code", async () => {
    const first = await mint(randomToken(), pkce().challenge);
    const state = randomToken();
    const { verifier, challenge } = pkce();
    const second = await mint(state, challenge);

    const live = await prisma.mobileAuthCode.count({
      where: { codeHash: createHash("sha256").update(first.body.code).digest("hex") },
    });
    expect(live).toBe(0);

    // And the survivor still works.
    const exchanged = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: second.body.code, codeVerifier: verifier, state });
    expect(exchanged.status).toBe(200);
  });

  it("stores only hashes - a database leak yields nothing redeemable", async () => {
    const state = randomToken();
    const { challenge } = pkce();
    const minted = await mint(state, challenge);

    const row = await prisma.mobileAuthCode.findUnique({
      where: { codeHash: createHash("sha256").update(minted.body.code).digest("hex") },
    });
    expect(row).not.toBeNull();
    // The raw code and the raw state appear nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(minted.body.code);
    expect(JSON.stringify(row)).not.toContain(state);
  });
});

describe("what reaches the logs", () => {
  it("masks the invitation token and the handoff code in request URLs", () => {
    const serialized = redactedReqSerializer({
      method: "GET",
      url: "/api/team/join/preview?token=SUPERSECRETTOKEN&code=SECRETCODE&state=SECRETSTATE",
    });
    expect(serialized.url).not.toContain("SUPERSECRETTOKEN");
    expect(serialized.url).not.toContain("SECRETCODE");
    expect(serialized.url).not.toContain("SECRETSTATE");
    expect(serialized.url).toContain("[redacted]");
  });
});

/**
 * The second hand-off flow: a new owner who signed up and created a shop in the
 * browser. It mints the SAME kind of ticket as an invitation - these pin that
 * the purpose is accepted and changes nothing about the security properties.
 */
describe("the new-shop purpose", () => {
  it("mints and redeems exactly like team_join", async () => {
    const state = randomToken();
    const { verifier, challenge } = pkce();

    const minted = await request(app)
      .post("/api/auth/mobile/code")
      .set("Cookie", cookie)
      .send({
        state,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        purpose: "new_shop",
      });
    expect(minted.status).toBe(201);
    expect(minted.body.code).toBeTruthy();

    const redeemed = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.token).toBeTruthy();
  });

  it("still refuses a purpose that is not a hand-off flow", async () => {
    const { challenge } = pkce();
    const res = await request(app)
      .post("/api/auth/mobile/code")
      .set("Cookie", cookie)
      .send({
        state: randomToken(),
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        purpose: "admin_takeover",
      });
    expect(res.status).toBe(400);
  });

  it("is still single-use - the purpose buys no second redemption", async () => {
    const state = randomToken();
    const { verifier, challenge } = pkce();
    const minted = await request(app)
      .post("/api/auth/mobile/code")
      .set("Cookie", cookie)
      .send({
        state,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        purpose: "new_shop",
      });

    const first = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: minted.body.code, codeVerifier: verifier, state });
    expect(second.status).not.toBe(200);
  });
});
