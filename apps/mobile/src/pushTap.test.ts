import { describe, expect, it } from "vitest";
import { routeForNotification } from "./pushTap";

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
