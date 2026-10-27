import { describe, expect, it } from "vitest";
import {
  PLATFORM_NOTICE_FIXED_SHOWS_MS,
  platformNoticePushBody,
  platformNoticeState,
  platformNoticeVisible,
} from "./platformNotices.js";

/**
 * Where a platform notice is in its life decides whether every barber's
 * dashboard shows it, so the rule is pinned here once for the API and the web.
 */
const NOW = new Date("2026-10-27T15:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe("platformNoticeState", () => {
  it("live from its start until its end", () => {
    expect(platformNoticeState({ startsAt: at(-5), endsAt: null, resolvedAt: null }, NOW)).toBe("active");
    expect(platformNoticeState({ startsAt: at(-5), endsAt: at(5), resolvedAt: null }, NOW)).toBe("active");
    expect(platformNoticeState({ startsAt: at(5), endsAt: null, resolvedAt: null }, NOW)).toBe("scheduled");
    expect(platformNoticeState({ startsAt: at(-60), endsAt: at(0), resolvedAt: null }, NOW)).toBe("ended");
  });

  it("shows as fixed for a few hours after it is resolved, then drops off", () => {
    const justFixed = { startsAt: at(-120), endsAt: null, resolvedAt: at(-30) };
    expect(platformNoticeState(justFixed, NOW)).toBe("resolved");
    const longFixed = {
      startsAt: at(-600),
      endsAt: null,
      resolvedAt: new Date(NOW.getTime() - PLATFORM_NOTICE_FIXED_SHOWS_MS - 1),
    };
    expect(platformNoticeState(longFixed, NOW)).toBe("ended");
  });

  it("an end time that has passed wins over a recent fix, and a fix before the start announces nothing", () => {
    expect(platformNoticeState({ startsAt: at(-120), endsAt: at(-1), resolvedAt: at(-10) }, NOW)).toBe("ended");
    expect(platformNoticeState({ startsAt: at(60), endsAt: null, resolvedAt: at(-10) }, NOW)).toBe("ended");
  });

  it("only live and just-fixed notices are visible", () => {
    expect(platformNoticeVisible("active")).toBe(true);
    expect(platformNoticeVisible("resolved")).toBe(true);
    expect(platformNoticeVisible("scheduled")).toBe(false);
    expect(platformNoticeVisible("ended")).toBe(false);
  });
});

describe("platformNoticePushBody", () => {
  it("is the first non-empty line, trimmed and cut to fit a lock screen", () => {
    expect(platformNoticePushBody("\n  Card payments fail.  \nCash still works.")).toBe("Card payments fail.");
    const long = platformNoticePushBody("x".repeat(400));
    expect(long.length).toBe(140);
    expect(long.endsWith("…")).toBe(true);
  });
});
