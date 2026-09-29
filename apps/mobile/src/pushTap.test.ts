import { describe, expect, it } from "vitest";
import { dashboardPathOf, routeForNotification, safeDashboardPath } from "./pushTap";

/**
 * A tapped BARBER alert opens the page it links to (2026-09-29: "when I tap a
 * notification it should take me directly to that day and time's
 * appointment"). The link was always sent; the app ignored it.
 */
describe("a barber alert", () => {
  it("🔴 'Next up' opens that appointment in the barber screen", () => {
    const url = "https://getchairback.com/dashboard/booking?tab=Appointments&appointment=ap_123";
    expect(routeForNotification({ url })).toBe(
      `/barber?next=${encodeURIComponent("/dashboard/booking?tab=Appointments&appointment=ap_123")}`,
    );
  });

  it("an alert without an appointment still lands on its dashboard page", () => {
    expect(routeForNotification({ url: "https://getchairback.com/dashboard/booking" })).toBe(
      `/barber?next=${encodeURIComponent("/dashboard/booking")}`,
    );
    expect(routeForNotification({ url: "https://getchairback.com/dashboard" })).toBe(
      `/barber?next=${encodeURIComponent("/dashboard")}`,
    );
  });

  it("🔴 keeps only the path - another host's page can never be opened signed in", () => {
    // The host is dropped: the barber screen puts the path after its own origin.
    expect(dashboardPathOf("https://evil.example/dashboard/booking?x=1")).toBe("/dashboard/booking?x=1");
    for (const url of [
      "https://getchairback.com/dashboards",
      "https://getchairback.com/dashboard//evil.example",
      "https://getchairback.com/login?next=/dashboard",
      "javascript:alert(1)//dashboard",
      "/dashboard/booking",
    ]) {
      expect(dashboardPathOf(url)).toBeNull();
    }
  });

  it("safeDashboardPath refuses anything but a /dashboard path", () => {
    expect(safeDashboardPath("/dashboard/booking?appointment=a")).toBe("/dashboard/booking?appointment=a");
    for (const p of ["//evil.example/dashboard", "https://evil.example", "/login", "/dashboardx", "/dashboard\\x", null, undefined, ""]) {
      expect(safeDashboardPath(p)).toBeNull();
    }
  });
});

/** A tapped notification about a held opening goes where the opening is. */
describe("routeForNotification", () => {
  it("sends a held-opening notification to Profile", () => {
    expect(routeForNotification({ url: "https://getchairback.com/r/abc123?opening=op_1" })).toBe("/customer/profile");
  });

  it("sends a shop announcement to Announcements", () => {
    expect(routeForNotification({ url: "https://getchairback.com/book/fades?announcement=bc_1" })).toBe(
      "/customer/announcements",
    );
  });

  it("leaves every other notification where it was", () => {
    for (const data of [
      { url: "https://getchairback.com/r/abc123" },
      { url: "https://getchairback.com/book/fades?openings=1" },
      { url: "https://getchairback.com/book/fades?announcement=" },
      { url: 7 },
      {},
      null,
      undefined,
      "not an object",
    ]) {
      expect(routeForNotification(data)).toBeNull();
    }
  });
});
