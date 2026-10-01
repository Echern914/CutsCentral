import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppHasRewardsTab } from "./useAppHasRewardsTab";

type W = { __cbNative?: { rewardsTab?: boolean; openAuth?: boolean }; ReactNativeWebView?: unknown };
const w = () => window as unknown as W;

afterEach(() => {
  delete w().__cbNative;
  delete w().ReactNativeWebView;
});

describe("an app build whose Rewards tab holds a client's whole rewards", () => {
  it("🔴 says so, and only then is the page's rewards button redundant", () => {
    w().ReactNativeWebView = { postMessage() {} };
    w().__cbNative = { openAuth: true, rewardsTab: true };
    expect(renderHook(() => useAppHasRewardsTab()).result.current).toBe(true);
  });

  it("🔴 an older build - the bridge without the flag - keeps the button", () => {
    w().ReactNativeWebView = { postMessage() {} };
    w().__cbNative = { openAuth: true };
    expect(renderHook(() => useAppHasRewardsTab()).result.current).toBe(false);
  });

  it("a browser is never the app, whatever a page sets", () => {
    w().__cbNative = { rewardsTab: true };
    expect(renderHook(() => useAppHasRewardsTab()).result.current).toBe(false);
  });
});
