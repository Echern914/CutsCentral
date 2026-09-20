import { describe, expect, it, vi } from "vitest";
import { ensureHowToTapShown, type EducationDeps } from "./education";

/**
 * APPLE'S REQUIRED "HOW TO TAP" EDUCATION - when it appears, and what happens
 * when it cannot.
 *
 * 🔴 This proves the RULES, not the overlay. Apple's overlay itself needs iOS
 * 18, the entitlement and a physical iPhone, none of which exist here. What is
 * decidable without them is the part that would fail App Review or mislead a
 * barber: that it appears at first use, exactly once, that a failure is never
 * recorded as a showing, and that iOS 18+ never quietly gets our own screen
 * instead of Apple's.
 */

function deps(over: Partial<EducationDeps> = {}): EducationDeps {
  return {
    read: vi.fn(async () => null),
    write: vi.fn(async () => {}),
    nativeAvailable: vi.fn(() => true),
    presentNative: vi.fn(async () => true),
    presentFallback: vi.fn(async () => {}),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    ...over,
  };
}

describe("first use", () => {
  it("presents Apple's overlay on iOS 18+ and records it", async () => {
    const d = deps();
    const res = await ensureHowToTapShown(d);
    expect(res.outcome).toBe("native");
    expect(d.presentNative).toHaveBeenCalledTimes(1);
    expect(d.presentFallback).not.toHaveBeenCalled();
    expect(d.write).toHaveBeenCalledWith("2026-09-20T12:00:00.000Z");
  });

  it("shows our own instructions on an iOS too old for Apple's API", async () => {
    const d = deps({ nativeAvailable: vi.fn(() => false) });
    const res = await ensureHowToTapShown(d);
    expect(res.outcome).toBe("fallback");
    expect(d.presentFallback).toHaveBeenCalledTimes(1);
    expect(d.presentNative).not.toHaveBeenCalled();
    expect(d.write).toHaveBeenCalled();
  });
});

describe("repeated use", () => {
  it("🔴 does not put an overlay in front of a waiting customer the second time", async () => {
    const d = deps({ read: vi.fn(async () => "2026-09-01T00:00:00.000Z") });
    const res = await ensureHowToTapShown(d);
    expect(res.outcome).toBe("already");
    expect(d.presentNative).not.toHaveBeenCalled();
    expect(d.presentFallback).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it("shows once, then never again on the same device", async () => {
    // The real sequence, with storage that actually remembers.
    let stored: string | null = null;
    const d = deps({
      read: vi.fn(async () => stored),
      write: vi.fn(async (v: string) => {
        stored = v;
      }),
    });

    expect((await ensureHowToTapShown(d)).outcome).toBe("native");
    expect((await ensureHowToTapShown(d)).outcome).toBe("already");
    expect((await ensureHowToTapShown(d)).outcome).toBe("already");
    expect(d.presentNative).toHaveBeenCalledTimes(1);
  });
});

describe("dismissal and completion", () => {
  it("waits for our fallback to be dismissed before recording it", async () => {
    // The fallback resolves on dismissal, so a barber who has not closed it has
    // not been educated yet and the write must not have happened.
    let dismiss!: () => void;
    const dismissed = new Promise<void>((r) => {
      dismiss = r;
    });
    const write = vi.fn(async () => {});
    const d = deps({
      nativeAvailable: vi.fn(() => false),
      presentFallback: vi.fn(() => dismissed),
      write,
    });

    const pending = ensureHowToTapShown(d);
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();

    dismiss();
    expect((await pending).outcome).toBe("fallback");
    expect(write).toHaveBeenCalled();
  });

  it("waits for Apple's overlay to finish before recording it", async () => {
    // `presentContent(_:from:)` is `async throws` - which an EAS build proved,
    // since Stripe's published snippet omits both and does not compile - so
    // awaiting it means shown AND finished, not merely requested.
    let finish!: () => void;
    const shown = new Promise<void>((r) => {
      finish = r;
    });
    const write = vi.fn(async () => {});
    const d = deps({ presentNative: vi.fn(() => shown), write });

    const pending = ensureHowToTapShown(d);
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();

    finish();
    expect((await pending).outcome).toBe("native");
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("🔴 failure is never recorded as a showing", () => {
  it("a failed native present does NOT mark the education as done", async () => {
    // The record is the only evidence the requirement was met. A false one
    // means the next barber on this device never sees it at all.
    const d = deps({
      presentNative: vi.fn(async () => {
        throw new Error("ERR_NO_VIEW_CONTROLLER");
      }),
    });
    const res = await ensureHowToTapShown(d);
    expect(res.outcome).toBe("failed");
    expect(res.reason).toContain("ERR_NO_VIEW_CONTROLLER");
    expect(d.write).not.toHaveBeenCalled();
  });

  it("🔴 does NOT fall back to our own screen when Apple's fails on iOS 18+", async () => {
    // The tempting mistake. On iOS 18+ Apple's overlay IS the requirement;
    // showing ours instead would leave the app shipping without the thing
    // Apple asked for, with nothing anywhere saying so.
    const d = deps({
      presentNative: vi.fn(async () => {
        throw new Error("ERR_PRESENT_FAILED");
      }),
    });
    const res = await ensureHowToTapShown(d);
    expect(res.outcome).toBe("failed");
    expect(d.presentFallback).not.toHaveBeenCalled();
  });

  it("a failed fallback is a failure too", async () => {
    const d = deps({
      nativeAvailable: vi.fn(() => false),
      presentFallback: vi.fn(async () => {
        throw new Error("no window");
      }),
    });
    expect((await ensureHowToTapShown(d)).outcome).toBe("failed");
    expect(d.write).not.toHaveBeenCalled();
  });

  it("retries on the next attempt after a failure", async () => {
    // Nothing was recorded, so the next time the barber chooses Tap to Pay the
    // education is attempted again rather than skipped forever.
    let stored: string | null = null;
    const presentNative = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("ERR_PRESENT_FAILED"))
      .mockResolvedValueOnce(true);
    const d = deps({
      read: vi.fn(async () => stored),
      write: vi.fn(async (v: string) => {
        stored = v;
      }),
      presentNative,
    });

    expect((await ensureHowToTapShown(d)).outcome).toBe("failed");
    expect((await ensureHowToTapShown(d)).outcome).toBe("native");
    expect(presentNative).toHaveBeenCalledTimes(2);
  });
});

describe("unavailable devices", () => {
  it("an old iPhone gets accurate instructions rather than nothing", async () => {
    const d = deps({ nativeAvailable: vi.fn(() => false) });
    expect((await ensureHowToTapShown(d)).outcome).toBe("fallback");
  });

  it("unreadable storage errs towards showing it again, not skipping it", async () => {
    // Showing twice is an annoyance. Skipping is an App Review failure and a
    // barber who was never taught how to hold the phone.
    const d = deps({
      read: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    });
    expect((await ensureHowToTapShown(d)).outcome).toBe("native");
  });

  it("a storage write that fails still counts as shown for this session", async () => {
    const d = deps({
      write: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    // It was presented; failing the collection over a write would be worse.
    expect((await ensureHowToTapShown(d)).outcome).toBe("native");
  });
});
