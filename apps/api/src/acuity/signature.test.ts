import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAcuitySignature } from "./signature.js";

const KEY = "test-acuity-key";

function sign(body: string, key = KEY): string {
  return createHmac("sha256", key).update(Buffer.from(body)).digest("base64");
}

describe("verifyAcuitySignature", () => {
  const body = Buffer.from("action=scheduled&id=123&calendarID=1&appointmentTypeID=2");

  it("accepts a valid signature over the raw body", () => {
    expect(verifyAcuitySignature(body, sign(body.toString()), KEY)).toBe(true);
  });

  it("rejects a signature computed with the wrong key", () => {
    expect(verifyAcuitySignature(body, sign(body.toString(), "wrong"), KEY)).toBe(false);
  });

  it("rejects when the raw body differs by one byte", () => {
    const tampered = Buffer.from("action=scheduled&id=124&calendarID=1&appointmentTypeID=2");
    expect(verifyAcuitySignature(tampered, sign(body.toString()), KEY)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyAcuitySignature(body, undefined, KEY)).toBe(false);
  });

  it("rejects a garbage header without throwing", () => {
    expect(verifyAcuitySignature(body, "not-base64-!!!", KEY)).toBe(false);
  });
});
