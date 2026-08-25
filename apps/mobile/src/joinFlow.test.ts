import { describe, expect, it } from "vitest";
import {
  base64ToBase64Url,
  buildJoinStartUrl,
  bytesToBase64Url,
  callbackIsForThisAttempt,
  inviteTokenFrom,
  readCallbackParams,
} from "./joinFlow";

/**
 * "Join your shop", minus the phone.
 *
 * Two things are worth protecting here and they are quite different. The first
 * is a UX judgement: whatever the barber pastes has to work, because the
 * alternative is a support text to their boss. The second is the security
 * boundary: the state check is the ONLY thing standing between us and a
 * callback URL that some other app on the device handed us.
 */

const TOKEN = "Ab3-_x9QwErTyUiOpAsDfGhJkLzXcVbNm12345678";

describe("reading whatever the barber pasted", () => {
  it("takes the whole link from the invitation email", () => {
    expect(
      inviteTokenFrom(`https://getchairback.com/team/join?token=${TOKEN}`),
    ).toBe(TOKEN);
  });

  it("takes the bare code", () => {
    expect(inviteTokenFrom(TOKEN)).toBe(TOKEN);
  });

  it("survives the mess a phone makes of a copied link", () => {
    expect(inviteTokenFrom(`  <https://getchairback.com/team/join?token=${TOKEN}>  `)).toBe(TOKEN);
    expect(inviteTokenFrom(`"${TOKEN}"`)).toBe(TOKEN);
    // A link pasted at the end of a sentence.
    expect(inviteTokenFrom(`https://getchairback.com/team/join?token=${TOKEN}.`)).toBe(TOKEN);
  });

  it("takes the app's own scheme, for a long-pressed in-app link", () => {
    expect(inviteTokenFrom(`chairback://team/join?token=${TOKEN}`)).toBe(TOKEN);
  });

  it("finds the token wherever it sits in the query", () => {
    expect(
      inviteTokenFrom(`https://getchairback.com/team/join?utm_source=email&token=${TOKEN}`),
    ).toBe(TOKEN);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["a sentence", "my boss said to download this"],
    ["a link with no token", "https://getchairback.com/team/join"],
    ["a token with illegal characters", "not a token!!"],
    ["something far too short", "abc"],
  ])("refuses %s rather than sending it on hopefully", (_label, input) => {
    expect(inviteTokenFrom(input)).toBeNull();
  });
});

describe("the URL that opens the authentication browser", () => {
  const url = buildJoinStartUrl({
    webOrigin: "https://getchairback.com",
    token: TOKEN,
    state: "STATE123",
    codeChallenge: "CHALLENGE456",
  });

  it("carries the invitation as `next`, which is what survives signup", () => {
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(params.get("next")).toBe(`/team/join?token=${TOKEN}`);
  });

  it("declares S256 - the plain PKCE method must never be offered", () => {
    expect(url).toContain("code_challenge_method=S256");
  });

  it("sends the challenge and never the verifier", () => {
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(params.get("code_challenge")).toBe("CHALLENGE456");
    expect(params.get("state")).toBe("STATE123");
    expect(url).not.toContain("verifier");
  });

  it("points at the start route on the configured origin", () => {
    expect(url.startsWith("https://getchairback.com/auth/mobile/start?")).toBe(true);
  });
});

describe("reading the callback", () => {
  it("reads the custom-scheme return", () => {
    expect(readCallbackParams("chairback://auth/callback?code=C1&state=S1")).toEqual({
      code: "C1",
      state: "S1",
    });
  });

  it("reads the https universal link the same way", () => {
    expect(
      readCallbackParams("https://getchairback.com/auth/mobile/callback?code=C1&state=S1"),
    ).toEqual({ code: "C1", state: "S1" });
  });

  it.each([
    ["no query at all", "chairback://auth/callback"],
    ["a code with no state", "chairback://auth/callback?code=C1"],
    ["a state with no code", "chairback://auth/callback?state=S1"],
  ])("returns null for %s", (_label, url) => {
    expect(readCallbackParams(url)).toBeNull();
  });
});

describe("the state check - the reason a foreign callback is harmless", () => {
  it("accepts the attempt this device started", () => {
    expect(callbackIsForThisAttempt({ code: "C", state: "S" }, "S")).toBe(true);
  });

  it("rejects a callback from a different attempt", () => {
    expect(callbackIsForThisAttempt({ code: "C", state: "OTHER" }, "S")).toBe(false);
  });

  it("rejects everything when there is no attempt in flight", () => {
    // The dangerous case: any app can open chairback://auth/callback?... at any
    // time. With nothing pending, nothing is accepted.
    expect(callbackIsForThisAttempt({ code: "C", state: "S" }, null)).toBe(false);
    expect(callbackIsForThisAttempt({ code: "C", state: "" }, "")).toBe(false);
  });
});

describe("base64url conversion", () => {
  it("makes a digest URL-safe and unpadded, as PKCE requires", () => {
    expect(base64ToBase64Url("ab+/cd==")).toBe("ab-_cd");
  });

  it("encodes random bytes without padding or unsafe characters", () => {
    const encoded = bytesToBase64Url(new Uint8Array([251, 255, 190, 0, 1, 2]));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded.length).toBeGreaterThan(0);
  });
});
