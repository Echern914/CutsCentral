import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySquareSignature } from "./signature.js";

const KEY = "test-square-sig-key";
const URL = "https://api.example.com/webhooks/square";

// Square signs notificationUrl + rawBody (NOT body alone, unlike Acuity).
function sign(url: string, body: string, key = KEY): string {
  return createHmac("sha256", key).update(url).update(Buffer.from(body)).digest("base64");
}

describe("verifySquareSignature", () => {
  const body = Buffer.from('{"type":"booking.created","data":{}}');

  it("accepts a valid signature over (url + body)", () => {
    expect(verifySquareSignature(body, sign(URL, body.toString()), KEY, URL)).toBe(true);
  });

  it("rejects when the notification URL differs (trailing slash etc.)", () => {
    expect(verifySquareSignature(body, sign(URL, body.toString()), KEY, URL + "/")).toBe(false);
  });

  it("rejects a signature over the body ALONE (the Acuity recipe, wrong for Square)", () => {
    const bodyOnly = createHmac("sha256", KEY).update(body).digest("base64");
    expect(verifySquareSignature(body, bodyOnly, KEY, URL)).toBe(false);
  });

  it("rejects the wrong key", () => {
    expect(verifySquareSignature(body, sign(URL, body.toString(), "wrong"), KEY, URL)).toBe(false);
  });

  it("rejects a one-byte body tamper", () => {
    const tampered = Buffer.from('{"type":"booking.updated","data":{}}');
    expect(verifySquareSignature(tampered, sign(URL, body.toString()), KEY, URL)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifySquareSignature(body, undefined, KEY, URL)).toBe(false);
  });
});
