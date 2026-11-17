import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppStrandsMaps } from "./useAppStrandsMaps";

type W = { __cbNative?: { externalMaps?: boolean; openAuth?: boolean }; ReactNativeWebView?: unknown };
const w = () => window as unknown as W;

afterEach(() => {
  delete w().__cbNative;
  delete w().ReactNativeWebView;
});

describe("an app build that would open a map inside itself", () => {
  it("🔴 an older build - the bridge without the flag - strands the visitor, so no Directions", () => {
    w().ReactNativeWebView = { postMessage() {} };
    w().__cbNative = { openAuth: true };
    expect(renderHook(() => useAppStrandsMaps()).result.current).toBe(true);
  });

  it("a build that opens maps outside keeps the button", () => {
    w().ReactNativeWebView = { postMessage() {} };
    w().__cbNative = { openAuth: true, externalMaps: true };
    expect(renderHook(() => useAppStrandsMaps()).result.current).toBe(false);
  });

  it("a browser keeps the button", () => {
    expect(renderHook(() => useAppStrandsMaps()).result.current).toBe(false);
  });
});
