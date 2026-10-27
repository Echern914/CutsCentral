import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * 🔴 A Wallet pass's authenticationToken is printed INTO the pass on the
 * customer's phone and sent back on every update for the life of the pass.
 * When it was an HMAC under SESSION_SECRET, the 2026-10-25 session rotation
 * made every older pass fail with "Authentication failure": reschedules,
 * punches and cancellations stopped reaching those phones.
 *
 * WALLET_AUTH_SECRET is the long-lived key. These tests pin that the tokens
 * follow it and NOT the session key - so rotating sessions again leaves every
 * pass working.
 *
 * Env before the import: apiEnv() is frozen on first read, and vitest gives
 * this file its own module registry.
 */
const WALLET_KEY = "w".repeat(48);
process.env.WALLET_AUTH_SECRET = WALLET_KEY;

const { passAuthToken, verifyPassAuth, walletAuthKey } = await import("./pass.js");
const { apptPassAuthToken, verifyApptPassAuth } = await import("./appointmentPass.js");

const hmac = (key: string, data: string) => createHmac("sha256", key).update(data).digest("hex");

describe("Wallet pass tokens use their own long-lived key", () => {
  it("walletAuthKey() is WALLET_AUTH_SECRET when set", () => {
    expect(walletAuthKey()).toBe(WALLET_KEY);
    expect(walletAuthKey()).not.toBe(process.env.SESSION_SECRET);
  });

  it("🔴 the appointment pass token is derived from WALLET_AUTH_SECRET, not SESSION_SECRET", () => {
    const id = "cmapptxxxxxxxxxxxxWALLET1";
    expect(apptPassAuthToken(id)).toBe(hmac(WALLET_KEY, `wallet-appt-pass:${id}`));
    expect(apptPassAuthToken(id)).not.toBe(
      hmac(process.env.SESSION_SECRET!, `wallet-appt-pass:${id}`),
    );
    expect(verifyApptPassAuth(`ApplePass ${hmac(WALLET_KEY, `wallet-appt-pass:${id}`)}`, id)).toBe(
      true,
    );
  });

  it("🔴 the punch-card pass token is derived from WALLET_AUTH_SECRET, not SESSION_SECRET", () => {
    const id = "cmclientxxxxxxxxxxWALLET2";
    expect(passAuthToken(id)).toBe(hmac(WALLET_KEY, `wallet-pass:${id}`));
    expect(verifyPassAuth(`ApplePass ${hmac(WALLET_KEY, `wallet-pass:${id}`)}`, id)).toBe(true);
    expect(
      verifyPassAuth(`ApplePass ${hmac(process.env.SESSION_SECRET!, `wallet-pass:${id}`)}`, id),
    ).toBe(false);
  });
});

// Unset, the key is SESSION_SECRET byte for byte (the original scheme): every
// other wallet test file runs that way, so the passes minted since the
// 2026-10-25 rotation keep verifying until WALLET_AUTH_SECRET is set to that
// same value.
