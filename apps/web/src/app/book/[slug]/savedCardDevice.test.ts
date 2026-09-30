import { describe, expect, it } from "vitest";
import {
  SAVED_CARD_KEY,
  forgetDeviceSavedCard,
  readDeviceSavedCard,
  rememberDeviceSavedCard,
  savedCardLabel,
} from "./savedCardDevice";

function memoryStore(broken = false) {
  const m = new Map<string, string>();
  const guard = () => {
    if (broken) throw new Error("SecurityError");
  };
  return {
    m,
    getItem: (k: string) => (guard(), m.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void m.set(k, v)),
    removeItem: (k: string) => (guard(), void m.delete(k)),
  };
}

const KEY = { token: "k".repeat(43), brand: "visa", last4: "4242" };

describe("the key to a saved card, on this device", () => {
  it("is kept per shop", () => {
    const s = memoryStore();
    rememberDeviceSavedCard("sample-studio", KEY, s);
    expect(readDeviceSavedCard("sample-studio", s)).toEqual(KEY);
    expect(readDeviceSavedCard("other-shop", s)).toBeNull();
  });

  it("is forgotten when the shop says it no longer works", () => {
    const s = memoryStore();
    rememberDeviceSavedCard("sample-studio", KEY, s);
    forgetDeviceSavedCard("sample-studio", s);
    expect(readDeviceSavedCard("sample-studio", s)).toBeNull();
    expect(s.m.has(SAVED_CARD_KEY)).toBe(false);
  });

  it("anything malformed reads as nothing, and a bad brand or last four is dropped, not shown", () => {
    const s = memoryStore();
    s.m.set(SAVED_CARD_KEY, "{nope");
    expect(readDeviceSavedCard("sample-studio", s)).toBeNull();
    s.m.set(SAVED_CARD_KEY, JSON.stringify({ "sample-studio": { token: "short" } }));
    expect(readDeviceSavedCard("sample-studio", s)).toBeNull();
    s.m.set(
      SAVED_CARD_KEY,
      JSON.stringify({ "sample-studio": { token: "k".repeat(43), brand: "<b>".repeat(20), last4: "42x2" } }),
    );
    expect(readDeviceSavedCard("sample-studio", s)).toEqual({ token: "k".repeat(43), brand: null, last4: null });
  });

  it("storage that throws never breaks the page", () => {
    const s = memoryStore(true);
    expect(() => rememberDeviceSavedCard("sample-studio", KEY, s)).not.toThrow();
    expect(readDeviceSavedCard("sample-studio", s)).toBeNull();
    expect(() => forgetDeviceSavedCard("sample-studio", s)).not.toThrow();
  });

  it("names the card the way people say it", () => {
    expect(savedCardLabel({ brand: "visa", last4: "4242" })).toBe("Visa •••• 4242");
    expect(savedCardLabel({ brand: null, last4: null })).toBe("Card on file");
  });
});
