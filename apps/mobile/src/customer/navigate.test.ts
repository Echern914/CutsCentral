import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Linking: { openURL: vi.fn(async () => {}) }, Platform: { OS: "ios" } }));

const { openAppointment, openManage, openStorefront, __resetPushGuardForTests } = await import("./navigate");

function fakeRouter() {
  return { push: vi.fn() } as unknown as Parameters<typeof openAppointment>[0] & { push: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  __resetPushGuardForTests();
});
afterEach(() => vi.useRealTimers());

describe("one tap, one screen", () => {
  it("🔴 a double tap on a visit opens it ONCE (two copies made Back look broken)", () => {
    const router = fakeRouter();
    openAppointment(router, "a1");
    openAppointment(router, "a1");
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("the same visit opens again after a moment (Back, then tap it again)", () => {
    const router = fakeRouter();
    openAppointment(router, "a1");
    vi.advanceTimersByTime(1200);
    openAppointment(router, "a1");
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("a different visit is a different tap", () => {
    const router = fakeRouter();
    openAppointment(router, "a1");
    openAppointment(router, "a2");
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("🔴 the shop page and the manage page are guarded the same way", () => {
    const router = fakeRouter();
    openStorefront(router, { key: "drick", name: "Drick" });
    openStorefront(router, { key: "drick", name: "Drick" });
    openManage(router, "a1", "reschedule");
    openManage(router, "a1", "reschedule");
    expect(router.push).toHaveBeenCalledTimes(2);
  });
});
