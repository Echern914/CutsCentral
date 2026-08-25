import { readdirSync, readFileSync } from "node:fs";
import { Router } from "express";
import express from "express";
import request from "supertest";
import { pino } from "pino";
import { pinoHttp } from "pino-http";
import { describe, expect, it } from "vitest";
import {
  redactedReqSerializer,
  redactedResSerializer,
  redactUrl,
} from "./logRedaction.js";

/**
 * WHAT A REQUEST URL IS ALLOWED TO SAY IN A LOG.
 *
 * Five route families carry their credential in the PATH rather than in a
 * header. A query string at least looks like something to be careful with; a
 * path segment reads like an id. These are not ids - each is a bearer secret
 * that is enough on its own to act as somebody, and every one of them is
 * stored hashed precisely so a leaked backup cannot replay it.
 *
 * 🔴 Logging the raw value undoes that for anyone who can read the log stream,
 * and a log stream is routinely forwarded somewhere with a longer memory and
 * looser access than the database it describes. A chat message has no expiry.
 *
 * The tests below cover the redaction itself, a structural guard against a new
 * route growing a secret path nobody teaches the redactor about, and the
 * mounted case end to end.
 */

const SECRET = "SUPERSECRETTOKENVALUE";

describe("redactUrl: the path secrets", () => {
  it.each([
    ["the Acuity webhook, whose URL is its only authenticator", `/webhooks/acuity/${SECRET}`],
    ["a rewards magic token", `/api/rewards/${SECRET}`],
    ["and every action hanging off it", `/api/rewards/${SECRET}/opt-out`],
    ["the rewards delete action", `/api/rewards/${SECRET}/delete`],
    ["a waitlist offer", `/api/book/offer/${SECRET}`],
    ["claiming that offer", `/api/book/offer/${SECRET}/claim`],
    ["an appointment manage link", `/api/book/manage/${SECRET}`],
    ["rescheduling through it", `/api/book/manage/${SECRET}/reschedule`],
    ["cancelling through it", `/api/book/manage/${SECRET}/cancel`],
    ["a waitlist cancel link", `/api/page/waitlist/cancel/${SECRET}`],
  ])("masks %s", (_label, url) => {
    const out = redactUrl(url);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[redacted]");
  });

  it("keeps the route shape, which is the part worth logging", () => {
    expect(redactUrl(`/api/book/manage/${SECRET}/reschedule`)).toBe(
      "/api/book/manage/[redacted]/reschedule",
    );
  });

  it("🔴 does NOT redact an ordinary row id that merely looks similar", () => {
    // /api/loyalty/rewards/:id is a reward definition a barber edits. Matching
    // on a bare `/rewards/` would swallow it, and over-redaction is how a log
    // stops being worth reading.
    expect(redactUrl("/api/loyalty/rewards/clx123")).toBe("/api/loyalty/rewards/clx123");
    expect(redactUrl("/api/booking/appointments/clx123")).toBe(
      "/api/booking/appointments/clx123",
    );
    expect(redactUrl("/api/page/some-shop/waitlist")).toBe("/api/page/some-shop/waitlist");
  });

  it("still masks the sensitive query values it always did", () => {
    const out = redactUrl(
      "/api/team/join/preview?token=INVITETOKEN&code=HANDOFFCODE&state=HANDOFFSTATE",
    );
    expect(out).not.toContain("INVITETOKEN");
    expect(out).not.toContain("HANDOFFCODE");
    expect(out).not.toContain("HANDOFFSTATE");
  });

  it("masks a path secret and a query secret in the same URL", () => {
    const out = redactUrl(`/api/book/manage/${SECRET}/slots?token=OTHER`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("OTHER");
  });
});

describe("the serializer, through a real mounted router", () => {
  it("redacts end to end - the token reaches no log line", async () => {
    // Every pattern names its mount prefix in full, and Express rewrites
    // `req.url` to strip that prefix while a mounted router is running. It
    // turns out not to bite - `req.url` is restored by the time pino-http
    // serializes on response finish - but "the redaction works only because of
    // WHEN the serializer runs" is not something to leave unpinned.
    const lines: string[] = [];
    const app = express();
    app.use(
      pinoHttp({
        logger: pino({ level: "info" }, { write: (line: string) => void lines.push(line) }),
        serializers: { req: redactedReqSerializer },
      }),
    );
    const book = Router();
    book.get("/offer/:token", (_req, res) => {
      res.json({ ok: true });
    });
    app.use("/api/book", book);

    await request(app).get(`/api/book/offer/${SECRET}`).expect(200);

    const logged = lines.join("\n");
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("/api/book/offer/[redacted]");
  });

  it("logs the method and the URL, and no headers or body", () => {
    const out = redactedReqSerializer({
      method: "POST",
      originalUrl: "/api/book/offer/x/claim",
      headers: { cookie: "cb_session=SESSIONSECRET", authorization: "Bearer BEARERSECRET" },
      body: { email: "someone@example.com" },
      remoteAddress: "203.0.113.9",
    });
    expect(Object.keys(out).sort()).toEqual(["method", "url"]);
    expect(JSON.stringify(out)).not.toContain("SESSIONSECRET");
    expect(JSON.stringify(out)).not.toContain("BEARERSECRET");
    expect(JSON.stringify(out)).not.toContain("someone@example.com");
  });
});

describe("🔴 every route whose path IS a credential is covered", () => {
  it("no route file has grown a secret path shape the redactor does not know", () => {
    // A structural guard, not a code review. Add `/api/foo/:token` and this
    // fails; add a sixth action under an already-covered prefix and it does
    // not. The pinned set is the list redactUrl's patterns were written for.
    const dir = new URL("./routes/", import.meta.url);
    const found = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(new URL(file, dir), "utf8");
      for (const [, literal] of src.matchAll(/"(\/[^"\n]*:(?:token|magicToken)[^"\n]*)"/g)) {
        // The prefix is what a redaction pattern has to name; the action after
        // the secret does not matter.
        found.add(`${file}${literal!.slice(0, literal!.indexOf(":"))}`);
      }
    }
    expect([...found].sort()).toEqual([
      "booking.public.ts/manage/",
      "booking.public.ts/offer/",
      "rewards.ts/",
      "shops.ts/waitlist/cancel/",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 🔴 The RESPONSE side: headers that are themselves credentials        */
/* ------------------------------------------------------------------ */

describe("🔴 the response side, through a real express + pinoHttp capture", () => {
  /**
   * The proof runs the way the leak was found: a real express app, the SAME
   * serializer config app.ts uses, and an assertion over every byte pino
   * actually emits. With the res serializer removed (main's config until this
   * change), these fail - the session cookie and the handoff code both land
   * in the log verbatim.
   */
  async function capture(drive: (app: express.Express) => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const app = express();
    app.use(
      pinoHttp({
        logger: pino({ level: "info" }, { write: (l: string) => void lines.push(l) }),
        serializers: { req: redactedReqSerializer, res: redactedResSerializer },
      }),
    );
    await drive(app);
    return lines.join("\n");
  }

  it("set-cookie never reaches the log - the session cookie is the account", async () => {
    const out = await capture(async (app) => {
      app.get("/login", (_req, res) => {
        // Two cookies, because Set-Cookie is an ARRAY once there is more than
        // one - the session plus an OAuth state cookie is the real shape of
        // the Google/Apple callbacks, and a redaction that handled only the
        // single-string case would pass the array through untouched.
        res.cookie("cb_session", "LIVE_SESSION_TOKEN_VALUE", { httpOnly: true });
        res.cookie("cb_google_state", "OAUTH_STATE_VALUE", { httpOnly: true });
        res.json({ ok: true });
      });
      await request(app).get("/login").expect(200);
    });
    expect(out).not.toContain("LIVE_SESSION_TOKEN_VALUE");
    expect(out).not.toContain("OAUTH_STATE_VALUE");
    expect(out).toContain("[redacted]");
    // And the line is still a request log, not a hole where one used to be.
    expect(out).toContain('"statusCode":200');
  });

  it("location never reaches the log - the redirect target carries the handoff code", async () => {
    const out = await capture(async (app) => {
      app.get("/oauth/cb", (_req, res) => {
        // The exact shape of auth.ts / authApple.ts: a signed code that
        // exchanges for a session, riding in the redirect target.
        res.redirect("https://app.example.com/auth/google/landing?code=HANDOFF_CODE_VALUE");
      });
      await request(app).get("/oauth/cb").expect(302);
    });
    expect(out).not.toContain("HANDOFF_CODE_VALUE");
    expect(out).not.toContain("app.example.com"); // the whole target, not just the query
    expect(out).toContain('"statusCode":302');
  });

  it("ordinary response headers survive - over-redaction is its own failure", async () => {
    const out = await capture(async (app) => {
      app.get("/data", (_req, res) => {
        res.json({ ok: true });
      });
      await request(app).get("/data").expect(200);
    });
    expect(out).toContain("application/json");
  });
});

describe("redactedResSerializer", () => {
  it("masks by header NAME, case-insensitively, arrays included", () => {
    const out = redactedResSerializer({
      statusCode: 302,
      headers: {
        "Set-Cookie": ["cb_session=SECRET_A; HttpOnly", "cb_state=SECRET_B"],
        Location: "/auth/apple/landing?code=SECRET_C",
        "content-type": "application/json",
      },
    });
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("SECRET_A");
    expect(flat).not.toContain("SECRET_B");
    expect(flat).not.toContain("SECRET_C");
    expect(out.headers["Set-Cookie"]).toBe("[redacted]");
    expect(out.headers["Location"]).toBe("[redacted]");
    expect(out.headers["content-type"]).toBe("application/json");
    expect(out.statusCode).toBe(302);
  });

  it("falls back to getHeaders() when handed a raw ServerResponse shape", () => {
    const out = redactedResSerializer({
      statusCode: 200,
      getHeaders: () => ({ "set-cookie": "cb_session=SECRET_D" }),
    });
    expect(JSON.stringify(out)).not.toContain("SECRET_D");
    expect(out.headers["set-cookie"]).toBe("[redacted]");
  });

  it("a response with no headers yet serializes without throwing", () => {
    expect(redactedResSerializer({ statusCode: null })).toEqual({
      statusCode: null,
      headers: {},
    });
  });
});

describe("🔴 app.ts actually wires BOTH serializers", () => {
  it("the pinoHttp call names req and res - a correct serializer nobody passes is the #297 bug again", () => {
    // #297's whole failure mode was a redaction that existed but was not
    // wired at every sink. The serializer being right is worthless if app.ts
    // quietly reverts to the default res serializer, so pin the wiring.
    const src = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    expect(src).toMatch(/req: redactedReqSerializer/);
    expect(src).toMatch(/res: redactedResSerializer/);
  });
});
