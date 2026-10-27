import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Linking: { openURL: vi.fn(async () => {}) }, Platform: { OS: "ios" } }));

const { bookAgainRoute, openAppointment, openBookAgain, openManage, openStorefront, __resetPushGuardForTests } =
  await import("./navigate");

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

describe("book again", () => {
  const shop = { key: "link_1", name: "Drick" };

  it("opens the shop screen told WHICH visit to repeat - not the plain storefront", () => {
    expect(bookAgainRoute({ id: "a_appt1", shop })).toEqual({
      pathname: "/customer/shop/[key]",
      params: { key: "link_1", name: "Drick", again: "a_appt1" },
    });
  });

  it("the rewards card names no visit: it repeats their usual", () => {
    expect(bookAgainRoute({ shop }).params.again).toBe("usual");
  });

  it("is one tap, one screen - and a different visit is a different tap", () => {
    const router = fakeRouter();
    openBookAgain(router, { id: "a_appt1", shop });
    openBookAgain(router, { id: "a_appt1", shop });
    openBookAgain(router, { id: "a_appt2", shop });
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push.mock.calls[0]![0].params.again).toBe("a_appt1");
  });
});
