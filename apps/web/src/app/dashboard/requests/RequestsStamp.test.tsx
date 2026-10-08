import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * 🔴 DASHBOARD LIST TIMES ARE THE VIEWER'S, NOT THE SERVER'S.
 *
 * Inbox, Requests, Nudges and Reviews are server components, and they
 * formatted with `toLocaleString(undefined, ...)` - the server's zone, UTC on
 * Vercel. A 6:15 PM Eastern request read 10:15 PM, and an evening message sat
 * under tomorrow's date. They now stamp with <LocalDate>, which re-renders in
 * the browser's own zone. The same pattern is used on all five pages.
 */

const CREATED = "2026-10-08T22:15:00.000Z";
vi.mock("@/lib/api", () => ({
  apiGet: async () => ({
    ok: true,
    data: {
      requests: [
        {
          id: "q1",
          firstName: "Ana",
          lastName: null,
          phone: null,
          email: null,
          message: null,
          preferredTime: null,
          status: "NEW",
          createdAt: CREATED,
        },
      ],
    },
  }),
}));
vi.mock("./StatusControl", () => ({ StatusControl: () => null }));

const { default: RequestsPage } = await import("./page");

describe("the requests list", () => {
  it("stamps each request with a browser-local <time>", async () => {
    const { container } = render(await RequestsPage());
    const stamp = container.querySelector(`time[datetime="${CREATED}"]`);
    expect(stamp).toBeTruthy();
    // After mount it is the browser's own format, which includes the hour.
    expect(stamp!.textContent).toMatch(/\d/);
  });
});
