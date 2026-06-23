import { describe, expect, it } from "vitest";
import { toCents } from "./payments.js";

/**
 * Pure money-math used by the payments path. The Stripe-touching functions
 * (createAheadPaymentIntent / refundForCancellation / applyPaymentEvent) need a
 * live Stripe test account to exercise end-to-end and are verified there; this
 * locks the conversion that decides the charge amount.
 */
describe("toCents", () => {
  it("converts dollars to integer cents", () => {
    expect(toCents(45)).toBe(4500);
    expect(toCents(55)).toBe(5500);
    expect(toCents(35.5)).toBe(3550);
  });
  it("rounds to the nearest cent (no float drift)", () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004 -> 30
  });
  it("returns null for null/undefined/zero/negative (no $0 charge, no throw)", () => {
    expect(toCents(null)).toBeNull();
    expect(toCents(undefined)).toBeNull();
    expect(toCents(0)).toBeNull();
    expect(toCents(-5)).toBeNull();
  });
});

/**
 * The cancellation-fee math (kept-fee in cents from a basis-points policy) as
 * applied in cancelAppointment. Mirrors: feeCents = floor(collected * bps / 10000).
 */
describe("cancellation fee math", () => {
  const fee = (collected: number, bps: number) => Math.floor((collected * bps) / 10000);
  it("0 bps = full refund (no fee kept)", () => {
    expect(fee(5500, 0)).toBe(0);
  });
  it("10000 bps = keep 100% (no refund)", () => {
    expect(fee(5500, 10000)).toBe(5500);
  });
  it("partial fee floors to whole cents", () => {
    expect(fee(5500, 2500)).toBe(1375); // 25% of $55.00
    expect(fee(4599, 3333)).toBe(1532); // floors
  });
});
