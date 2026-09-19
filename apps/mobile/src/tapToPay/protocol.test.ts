import { describe, expect, it } from "vitest";
import {
  capabilityScript,
  parseTapToPayMessage,
  resultScript,
  tokenRequestScript,
} from "./protocol";

/**
 * The bridge is a string from a web page, so this file is about what must NOT
 * get through. It cannot tell you Tap to Pay works - see the real-device script
 * in docs/service-checkout.md for the only thing that can.
 */

const good = {
  type: "cb:tap-to-pay",
  requestId: "req_abc123456789",
  clientSecret: "pi_3ABCdef456_secret_xyz789",
  connectAccountId: "acct_1ABCdef",
  locationId: "tml_1ABCdef",
  amountCents: 4000,
};

describe("parseTapToPayMessage", () => {
  it("accepts our own collect message", () => {
    expect(parseTapToPayMessage(JSON.stringify(good))).toEqual({
      kind: "collect",
      request: {
        requestId: "req_abc123456789",
        clientSecret: "pi_3ABCdef456_secret_xyz789",
        connectAccountId: "acct_1ABCdef",
        locationId: "tml_1ABCdef",
        amountCents: 4000,
      },
    });
  });

  it("refuses a Terminal Location that is not one - a reader cannot connect without it", () => {
    for (const locationId of ["", "loc_1", "acct_1ABCdef", "tml", "../tml_1"]) {
      expect(parseTapToPayMessage(JSON.stringify({ ...good, locationId }))).toBeNull();
    }
  });

  it("ignores anything that is not JSON, or not ours", () => {
    expect(parseTapToPayMessage("cb:ready")).toBeNull();
    expect(parseTapToPayMessage("{not json")).toBeNull();
    expect(parseTapToPayMessage(JSON.stringify({ type: "cb:open-auth" }))).toBeNull();
    expect(parseTapToPayMessage(JSON.stringify({ ...good, type: "tap-to-pay" }))).toBeNull();
  });

  it("🔴 refuses anything that is not shaped like a PaymentIntent secret", () => {
    // The secret IS the authority to collect against an intent. A value that
    // is not one has no business being handed to the payment SDK, whatever it
    // claims to be.
    for (const clientSecret of [
      "",
      "seti_123_secret_abc", // a SetupIntent - saves a card, does not charge
      "pi_123", // no secret part
      "sk_live_deadbeef",
      "https://evil.test/pi_1_secret_2",
      "pi_1_secret_<script>",
    ]) {
      expect(parseTapToPayMessage(JSON.stringify({ ...good, clientSecret }))).toBeNull();
    }
  });

  it("refuses a connected account id that is not one", () => {
    for (const connectAccountId of ["", "acct", "cus_123", "acct_1 OR 1=1", "../acct_1"]) {
      expect(parseTapToPayMessage(JSON.stringify({ ...good, connectAccountId }))).toBeNull();
    }
  });

  it("refuses a nonsense amount, though the amount here is display only", () => {
    for (const amountCents of [0, -100, 12.5, "4000", null, Number.NaN]) {
      expect(parseTapToPayMessage(JSON.stringify({ ...good, amountCents }))).toBeNull();
    }
  });

  it("refuses a missing or oversized requestId", () => {
    expect(parseTapToPayMessage(JSON.stringify({ ...good, requestId: "" }))).toBeNull();
    expect(parseTapToPayMessage(JSON.stringify({ ...good, requestId: "x".repeat(65) }))).toBeNull();
    expect(parseTapToPayMessage(JSON.stringify({ ...good, requestId: 12345 }))).toBeNull();
  });

  it("accepts a connection token reply, including the page failing to get one", () => {
    expect(
      parseTapToPayMessage(JSON.stringify({ type: "cb:tap-to-pay-token", nonce: "n1", secret: "pst_x" })),
    ).toEqual({ kind: "token", reply: { nonce: "n1", secret: "pst_x" } });
    // The page could not fetch one: the SDK must be told, not left waiting.
    expect(
      parseTapToPayMessage(JSON.stringify({ type: "cb:tap-to-pay-token", nonce: "n1", secret: null })),
    ).toEqual({ kind: "token", reply: { nonce: "n1", secret: null } });
    expect(
      parseTapToPayMessage(JSON.stringify({ type: "cb:tap-to-pay-token", nonce: "", secret: "x" })),
    ).toBeNull();
  });
});

describe("the scripts injected back into the page", () => {
  it("carries the requestId so a stale reply cannot resolve a newer press", () => {
    const js = resultScript("req_1", "collected");
    expect(js).toContain('"requestId":"req_1"');
    expect(js).toContain('"outcome":"collected"');
    expect(js.endsWith("true;")).toBe(true);
  });

  it("🔴 a failure message cannot become a statement in our own page", () => {
    // The text can come from the SDK, and this script is injected into the
    // dashboard - the page holding the barber's session. So run it and check
    // the payload arrives as DATA, rather than eyeballing the source: a
    // substring assertion passes just as happily on the escaped form.
    const hostile = '");window.__pwned=1;("';
    const js = resultScript("req_1", "failed", hostile);

    const fakeWindow: Record<string, unknown> = {
      __cbTapToPay: { resolve: (p: unknown) => (fakeWindow.__got = p) },
    };
    // eslint-disable-next-line no-new-func
    new Function("window", js)(fakeWindow);

    expect(fakeWindow.__got).toEqual({
      requestId: "req_1",
      outcome: "failed",
      message: hostile,
    });
    expect(fakeWindow.__pwned).toBeUndefined();
  });

  it("announces the capability both ways round", () => {
    expect(capabilityScript(true)).toContain("tapToPay:true");
    expect(capabilityScript(false)).toContain("tapToPay:false");
  });

  it("passes the nonce through a token request", () => {
    expect(tokenRequestScript("n-42")).toContain('"n-42"');
  });
});
