import { describe, expect, it } from "vitest";
import { since } from "./connections";

/**
 * The pure half of the connection panel.
 *
 * 🔴 THIS FILE IMPORTING CLEANLY IS ITSELF THE TEST OF THE SPLIT. connections.ts
 * must stay free of `@/lib/api`, because the panel is a client component and
 * that module pulls in `next/headers` - one value import from the wrong side of
 * the line fails the whole web build. If someone moves the fetch back in here,
 * this file stops resolving.
 */
describe("since", () => {
  it("says nothing for a connection never used", () => {
    // Distinct from "0 minutes ago" - the panel prints "not used yet" instead,
    // which is a genuinely different fact about an assistant.
    expect(since(null)).toBeNull();
  });

  it("reads in the units a human would use", () => {
    const ago = (ms: number) => since(new Date(Date.now() - ms).toISOString());
    expect(ago(10_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5 min ago");
    expect(ago(2 * 3_600_000)).toBe("2 hours ago");
    expect(ago(1 * 3_600_000)).toBe("1 hour ago");
    expect(ago(3 * 86_400_000)).toBe("3 days ago");
    expect(ago(1 * 86_400_000)).toBe("1 day ago");
    expect(ago(60 * 86_400_000)).toBe("2 months ago");
  });

  it("does not render a future timestamp as a negative age", () => {
    // Clock skew between the API host and the browser is normal and must not
    // produce "-3 min ago" on a panel about security.
    expect(since(new Date(Date.now() + 60_000).toISOString())).toBe("just now");
  });

  it("survives a malformed timestamp rather than rendering NaN", () => {
    expect(since("not-a-date")).toBe("just now");
  });
});
