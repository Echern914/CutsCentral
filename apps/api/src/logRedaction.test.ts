import { readdirSync, readFileSync } from "node:fs";
import { Router } from "express";
import express from "express";
import request from "supertest";
import { pino } from "pino";
import { pinoHttp } from "pino-http";
import { describe, expect, it } from "vitest";
import { redactedReqSerializer, redactUrl } from "./logRedaction.js";

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
